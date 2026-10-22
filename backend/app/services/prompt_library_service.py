"""提示词收录与公开聚合。读操作不改库；投稿批准才创建独立收录信息。"""

import hashlib
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from ..models import Demo, DemoModel, DemoTag, EntitySuggestion, Model, Prompt, PromptLibraryEntry, Tag, User
from ..serializers import preload_demo_relations, serialize_demo
from .scope import VALID_SCOPES, scope_contains_filter


def normalize_content(content: str) -> str:
    """与作品双写一致：保留大小写、内文空白，仅规范换行和首尾空白。"""
    return content.replace("\r\n", "\n").strip()


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _savepoint(db: Session):
    # Python sqlite3 的旧事务模式不会为 SELECT 开启实际事务。
    # 此时直接 SAVEPOINT / RELEASE 会提前提交，外层审核失败也回滚不了。
    connection = db.connection()
    if connection.dialect.name == "sqlite" and not connection.connection.driver_connection.in_transaction:
        connection.exec_driver_sql("BEGIN")
    return db.begin_nested()


def _lock_write(db: Session, statement) -> None:
    """SQLite 短写事务串行；其他数据库对业务定位行加锁，不写无关字段。"""
    connection = db.connection()
    if connection.dialect.name == "sqlite":
        # 本服务调用前只有鉴权/读操作；若已有实际事务，调用方已在写入流程中。
        if not connection.connection.driver_connection.in_transaction:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
    else:
        db.execute(statement.with_for_update()).first()


def lock_submission(db: Session, user_id: int) -> None:
    """重复查询与创建处于同一串行区，确保同一人的并发投稿只入箱一次。"""
    _lock_write(db, select(User.id).where(User.id == user_id))


def lock_review(db: Session, suggestion: EntitySuggestion) -> None:
    """等待其他审核结束后重读状态，防止已载入的 pending 被第二个决策覆盖。"""
    _lock_write(db, select(EntitySuggestion.id).where(EntitySuggestion.id == suggestion.id))
    db.refresh(suggestion)


def get_or_create_prompt(db: Session, content: str) -> Prompt:
    """正文按精确哈希复用；保存点保护并发写入的唯一约束竞争。"""
    digest = content_hash(content)
    existing = db.query(Prompt).filter(Prompt.content_hash == digest).first()
    if existing is not None:
        return existing
    row = Prompt(content_hash=digest, content=content)
    try:
        with _savepoint(db):
            db.add(row)
            db.flush()
    except IntegrityError:
        existing = db.query(Prompt).filter(Prompt.content_hash == digest).first()
        if existing is None:
            raise
        return existing
    return row


def validate_proposal(payload: dict) -> dict:
    """请求和审核执行共用校验；来源只保存链接，不发起外部请求。"""
    fields = {"title": 200, "content": 20000, "category": 64, "source_url": 2048}
    values = {}
    for field, maximum in fields.items():
        value = payload.get(field)
        if value is None and field in ("category", "source_url"):
            value = ""
        if not isinstance(value, str) or len(value) > maximum:
            raise HTTPException(status_code=422, detail=f"{field} 需为不超过 {maximum} 字符的文本")
        values[field] = normalize_content(value) if field == "content" else value.strip()
    if not values["title"] or not values["content"]:
        raise HTTPException(status_code=422, detail="标题和提示词正文不能为空")
    source = values["source_url"]
    if source:
        try:
            parsed = urlsplit(source)
            valid = (parsed.scheme.lower() in ("http", "https") and bool(parsed.hostname)
                     and parsed.username is None and parsed.password is None
                     and not any(c.isspace() or ord(c) < 32 for c in source))
            parsed.port  # 同时拒绝不合法的端口号
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(status_code=422, detail="来源链接需为有效的 HTTP(S) 网址，且不能包含账号密码")
    values["category"] = values["category"] or None
    values["source_url"] = source or None
    return values


def backfill_missing_prompt_links(db: Session, batch_size: int = 200) -> int:
    """按主键分批修复旧作品缺失的 prompt_id；不改原文、时间或已有链接。

    缓存实体可以包含待审作品的正文，公开查询另行检查作品状态和视区。
    函数只 flush，事务边界归启动方或维护脚本；重复启动不会改写已修复行。
    """
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    last_id = 0
    linked = 0
    while True:
        rows = (db.query(Demo.id, Demo.prompt)
                .filter(Demo.id > last_id, Demo.prompt_id.is_(None), Demo.prompt != "")
                .order_by(Demo.id).limit(batch_size).all())
        if not rows:
            break
        last_id = rows[-1].id
        by_content: dict[str, list[int]] = {}
        for row in rows:
            content = normalize_content(row.prompt or "")
            if content:
                by_content.setdefault(content, []).append(row.id)
        for content, ids in by_content.items():
            prompt = get_or_create_prompt(db, content)
            result = db.execute(update(Demo).where(Demo.id.in_(ids), Demo.prompt_id.is_(None))
                                .values(prompt_id=prompt.id).execution_options(synchronize_session=False))
            linked += result.rowcount
        db.flush()
    if linked:
        # 批量修复只失效一次，避免每件作品都重置聚类状态。
        from . import cluster_service

        cluster_service.invalidate()
    return linked


def publish_prompt(db: Session, payload: dict, *, created_by: int | None) -> PromptLibraryEntry:
    """审核执行用：复用正文，已有收录的标题和来源不被后来投稿覆盖。"""
    values = validate_proposal(payload)
    scope = payload.get("scope", "deep")
    if scope not in VALID_SCOPES:
        raise HTTPException(status_code=422, detail="提示词视区无效")
    prompt = get_or_create_prompt(db, values.pop("content"))
    existing = (db.query(PromptLibraryEntry)
                .filter(PromptLibraryEntry.prompt_id == prompt.id, PromptLibraryEntry.scope == scope).first())
    if existing is not None:
        return existing
    entry = PromptLibraryEntry(prompt_id=prompt.id, scope=scope, status="approved",
                               created_by=created_by, **values)
    try:
        with _savepoint(db):
            db.add(entry)
            db.flush()
    except IntegrityError:
        existing = (db.query(PromptLibraryEntry)
                    .filter(PromptLibraryEntry.prompt_id == prompt.id, PromptLibraryEntry.scope == scope).first())
        if existing is None:
            raise
        return existing
    return entry


def _summary_query(db: Session, scope: str):
    """单一公开口径；计数、派生标题、详情与分页均使用相同的可见作品集合。"""
    visible = and_(Demo.status == "approved", scope_contains_filter(scope), Demo.prompt_id.is_not(None))
    counts = (db.query(Demo.prompt_id.label("prompt_id"), func.count(Demo.id).label("demos_total"),
                       func.min(Demo.id).label("first_demo_id"))
              .filter(visible).group_by(Demo.prompt_id).subquery())
    model_counts = (db.query(Demo.prompt_id.label("prompt_id"),
                            func.count(func.distinct(DemoModel.model_id)).label("models_total"))
                    .join(DemoModel, DemoModel.demo_id == Demo.id)
                    .join(Model, Model.id == DemoModel.model_id)
                    .filter(visible, Model.status != "deprecated")
                    .group_by(Demo.prompt_id).subquery())
    first = aliased(Demo)
    entry = aliased(PromptLibraryEntry)
    demo_category = (select(Tag.value).join(DemoTag, DemoTag.tag_id == Tag.id)
                     .where(DemoTag.demo_id == first.id, Tag.key == "category", Tag.status != "deprecated")
                     .order_by(Tag.value, Tag.id).limit(1).correlate(first).scalar_subquery())
    query = (db.query(
        Prompt.id.label("id"), func.coalesce(entry.title, first.title).label("title"),
        Prompt.content.label("content"), func.coalesce(entry.category, demo_category).label("category"),
        entry.source_url.label("source_url"),
        case((entry.id.is_not(None), "contributed"), else_="demo").label("source"),
        func.coalesce(entry.created_at, first.created_at, Prompt.created_at).label("created_at"),
        func.coalesce(counts.c.demos_total, 0).label("demos_total"),
        func.coalesce(model_counts.c.models_total, 0).label("models_total"),
    ).outerjoin(entry, and_(entry.prompt_id == Prompt.id, entry.scope == scope, entry.status == "approved"))
      .outerjoin(counts, counts.c.prompt_id == Prompt.id)
      .outerjoin(first, first.id == counts.c.first_demo_id)
      .outerjoin(model_counts, model_counts.c.prompt_id == Prompt.id)
      .filter(or_(entry.id.is_not(None), counts.c.demos_total > 0)))
    return query


def list_prompts(db: Session, *, scope: str, q: str | None = None, category: str | None = None,
                 sort: str = "newest", has_results: bool | None = None, page: int = 1,
                 page_size: int = 20) -> tuple[list[dict], int]:
    summary = _summary_query(db, scope).subquery()
    query = db.query(summary)
    if q and q.strip():
        value = q.strip()
        query = query.filter(or_(summary.c.title.icontains(value, autoescape=True),
                                 summary.c.content.icontains(value, autoescape=True)))
    if category and category.strip():
        query = query.filter(summary.c.category == category.strip())
    if has_results is not None:
        query = query.filter(summary.c.demos_total > 0 if has_results else summary.c.demos_total == 0)
    total = query.count()
    if sort == "most_tested":
        query = query.order_by(summary.c.demos_total.desc())
    query = query.order_by(summary.c.created_at.desc(), summary.c.id.desc())
    return [dict(r._mapping) for r in query.offset((page - 1) * page_size).limit(page_size).all()], total


def get_prompt(db: Session, prompt_id: int, *, scope: str) -> dict | None:
    row = _summary_query(db, scope).filter(Prompt.id == prompt_id).first()
    return dict(row._mapping) if row is not None else None


def list_prompt_demos(db: Session, prompt_id: int, *, scope: str, page: int = 1,
                      page_size: int = 20) -> tuple[list[dict], int]:
    query = db.query(Demo).filter(Demo.prompt_id == prompt_id, Demo.status == "approved", scope_contains_filter(scope))
    total = query.count()
    demos = query.order_by(Demo.created_at.desc(), Demo.id.desc()).offset((page - 1) * page_size).limit(page_size).all()
    preload_demo_relations(db, demos)
    return [serialize_demo(db, demo) for demo in demos], total
