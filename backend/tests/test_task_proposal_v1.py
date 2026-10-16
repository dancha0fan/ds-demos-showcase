"""独立出题（题目与作品创建解耦的第一步）：POST /api/v1/tasks。

核心不变式（与上传 propose_task 同一治理口径：用户贡献候选，管理员决定知识体系）：
  1. 必须登录 —— 不开放匿名出题
  2. 只落 pending EntitySuggestion(kind=new_task)，**不直建 Task**（批准前公开面零变化）
  3. 管理员批准 → create_task(status=active)，公开列表/详情立即可见（零作品题目照常展示）
  4. 幂等与防重：同用户同题名不堆箱；与 active 题目逐字同名 409；每用户每小时限流
"""

import json
import os

import pytest

from app.models import EntitySuggestion, Task, User


def _db():
    from app.database import SessionLocal

    return SessionLocal()


def _seed_task(title: str, status: str = "active") -> str:
    db = _db()
    t = Task(slug=f"prop-{os.urandom(3).hex()}", title=title, description="", status=status)
    db.add(t)
    db.commit()
    slug = t.slug
    db.close()
    return slug


def _propose(client, headers, title="独立出题测试题", **extra):
    body = {"title": title, **extra}
    return client.post("/api/v1/tasks", json=body, headers=headers)


def _uid_by_name(username: str) -> int:
    db = _db()
    uid = db.query(User.id).filter(User.username == username).first()[0]
    db.close()
    return uid


def _pending_new_tasks(user_id: int | None = None):
    db = _db()
    q = db.query(EntitySuggestion).filter(
        EntitySuggestion.kind == "new_task",
        EntitySuggestion.status == "pending",
    )
    if user_id is not None:
        q = q.filter(EntitySuggestion.created_by == user_id)
    rows = q.all()
    out = [
        {
            "id": s.id,
            "title": (json.loads(s.payload or "{}").get("title") or ""),
            "confidence": s.confidence,
            "source": s.source,
            "demo_id": s.demo_id,
            "created_by": s.created_by,
        }
        for s in rows
    ]
    db.close()
    return out


def test_propose_requires_auth(client):
    # 必须用**独立 client 实例**发这条匿名请求：conftest 的 client 是 session 级的，
    # 而登录会 set_cookie（security.py set_auth_cookie），token_from_request 又回落到 cookie
    # —— 前面任何用例登录过，这里无头请求就会被认证成该用户而拿到 202，
    # 断言会以「看起来像权限漏洞」的方式失败。同款写法见 test_security_batch1.py 的匿名 peek 段。
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as anon:
        r = anon.post("/api/v1/tasks", json={"title": "匿名也想出题"})
    assert r.status_code == 401, r.text
    # 且不留待审行（按题名圈定：库是跨文件共享的，全局计数会吃别人留下的行）
    db = _db()
    n = (
        db.query(EntitySuggestion)
        .filter(EntitySuggestion.kind == "new_task", EntitySuggestion.status == "pending")
        .all()
    )
    db.close()
    assert not any((json.loads(s.payload or "{}").get("title")) == "匿名也想出题" for s in n)


def test_propose_queues_pending_suggestion_without_creating_task(client, auth_headers):
    headers, username = auth_headers()
    r = _propose(client, headers, title="出一道画布弹跳题", description="让模型各显神通", category="effect")
    assert r.status_code == 202, r.text
    data = r.json()
    assert data["status"] == "pending"
    assert data["duplicate"] is False

    db = _db()
    uid = db.query(EntitySuggestion).filter(EntitySuggestion.id == data["suggestion_id"]).first().created_by
    # 不直建 Task：批准前公开面零变化
    assert db.query(Task).filter(Task.title == "出一道画布弹跳题").first() is None
    db.close()

    rows = [x for x in _pending_new_tasks() if x["id"] == data["suggestion_id"]]
    assert len(rows) == 1
    row = rows[0]
    assert row["title"] == "出一道画布弹跳题"
    assert row["source"] == "user"
    assert row["demo_id"] is None  # 独立出题：不挂任何作品
    assert row["created_by"] == uid
    # 必须可被默认收件箱看到（confidence ≥ REVIEW=0.60）
    from app.services import suggestion_service

    assert (row["confidence"] or 0) >= suggestion_service.REVIEW


def test_propose_validation_errors(client, auth_headers):
    headers, _ = auth_headers()
    # title 缺失 / 全空白 / 超长（>200）/ 描述超长（>4000）
    assert client.post("/api/v1/tasks", json={"description": "x"}, headers=headers).status_code == 422
    assert _propose(client, headers, title="   ").status_code == 422
    assert _propose(client, headers, title="超" * 201).status_code == 422
    assert _propose(client, headers, title="描述超长", description="长" * 4001).status_code == 422


def test_propose_conflicts_with_active_task_title(client, auth_headers):
    headers, _ = auth_headers()
    slug = _seed_task("已存在的同名题")
    r = _propose(client, headers, title="已存在的同名题")
    assert r.status_code == 409, r.text
    assert slug in r.json()["detail"]  # 指路到既有题目


def test_propose_idempotent_same_user_same_title(client, auth_headers):
    headers, username = auth_headers()
    uid = _uid_by_name(username)
    r1 = _propose(client, headers, title="幂等同题名")
    assert r1.status_code == 202, r1.text
    r2 = _propose(client, headers, title="幂等同题名")
    assert r2.status_code == 202, r2.text
    assert r2.json()["duplicate"] is True
    assert r2.json()["suggestion_id"] == r1.json()["suggestion_id"]
    # 该用户名下仍然只有一条待审（库是 session 级共享，计数必须按用户圈定）
    assert len(_pending_new_tasks(uid)) == 1


def test_propose_different_titles_and_users_all_queue(client, auth_headers):
    h1, name1 = auth_headers()
    h2, name2 = auth_headers()
    uid1, uid2 = _uid_by_name(name1), _uid_by_name(name2)
    assert _propose(client, h1, title="甲的第一题").status_code == 202
    assert _propose(client, h1, title="甲的第二题").status_code == 202
    # 跨用户同题名不去重（admin 人工裁决是否合并）——这正是去重键修复的行为面
    assert _propose(client, h2, title="甲的第一题").status_code == 202
    assert len(_pending_new_tasks(uid1)) == 2
    assert len([x for x in _pending_new_tasks(uid2) if x["title"] == "甲的第一题"]) == 1


def test_admin_approve_creates_active_task_and_public_visible(client, auth_headers, admin_headers):
    headers, _ = auth_headers()
    r = _propose(client, headers, title="批准后可见的题", description="零作品也应可浏览")
    sid = r.json()["suggestion_id"]

    # 收件箱能看到（new_task 过滤）
    lst = client.get("/api/v1/admin/suggestions", params={"kind": "new_task"}, headers=admin_headers)
    assert lst.status_code == 200, lst.text
    assert any(item["id"] == sid for item in lst.json()["items"])

    # 批准 → create_task(active)
    rv = client.post(f"/api/v1/admin/suggestions/{sid}/review", json={"action": "approve"}, headers=admin_headers)
    assert rv.status_code == 200, rv.text

    db = _db()
    t = db.query(Task).filter(Task.title == "批准后可见的题").first()
    assert t is not None and t.status == "active"
    slug = t.slug
    db.close()

    # 公开列表/详情立即可见，且零作品题目照常返回（demos_total=0）
    lst = client.get("/api/v1/tasks", params={"q": "批准后可见的题"})
    assert lst.status_code == 200 and lst.json()["total"] == 1
    det = client.get(f"/api/v1/tasks/{slug}")
    assert det.status_code == 200, det.text
    assert det.json()["demos_total"] == 0
    assert det.json()["chain"]["rows"] == []


def test_propose_rate_limit_per_user(client, auth_headers):
    headers, _ = auth_headers()
    codes = []
    for i in range(11):
        r = _propose(client, headers, title=f"限流压测题{i}")
        codes.append(r.status_code)
    assert codes[:10] == [202] * 10
    assert codes[10] == 429
    # 限流按用户分桶：另一用户不受牵连
    h2, _ = auth_headers()
    assert _propose(client, h2, title="另一用户的题").status_code == 202


@pytest.fixture(autouse=True)
def _clear_propose_side_effects():
    """跨用例隔离（库是 session 级共享）：

    - 限流器按 user.id 分桶，用例后清空（与 conftest 的 IP 维度重置同思路）；
    - 删除本文件产生的**独立出题**提案行（kind=new_task + source=user + demo_id IS NULL
      是独立出题的精确指纹；上传提议新题带 demo_id，不在清理面）——
      否则留给下游的 dedup 测试会被这三键全 None 的行误判成「已在队列」。
    """
    from app.services import ratelimit

    yield
    with ratelimit._lock:
        for k in [k for k in ratelimit._buckets if k.startswith("task:propose:")]:
            del ratelimit._buckets[k]
    db = _db()
    (
        db.query(EntitySuggestion)
        .filter(
            EntitySuggestion.kind == "new_task",
            EntitySuggestion.source == "user",
            EntitySuggestion.demo_id.is_(None),
        )
        .delete(synchronize_session=False)
    )
    db.commit()
    db.close()
