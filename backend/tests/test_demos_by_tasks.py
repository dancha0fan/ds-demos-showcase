"""GET /demos/by-tasks：作品库「demo 组」按题取整组。

为什么要这个口：主列表按页切片，一个同题组会被页边界切开；前端只有拿到整组，
才能把堆叠卡画完整、并按「组内最近更新 / 浏览最多 / 最高分」算组级排序。

口径：
- 只出 `approved` + 当前视区 scope（与主列表一致）；
- **刻意不过滤搜索/标签条件**——组的语义是「这道题的全部作品」。
"""

import json

from app.models import Demo, DemoTask, Task


def _db():
    from app.database import SessionLocal

    return SessionLocal()


def _ensure_value(value: str) -> None:
    from app.services import model_service

    db = _db()
    try:
        model_service.ensure_tag_value(db, value)
        db.commit()
    finally:
        db.close()


def _task(slug: str, title: str) -> int:
    db = _db()
    try:
        t = db.query(Task).filter(Task.slug == slug).first()
        if t is None:
            t = Task(slug=slug, title=title, description="", status="active")
            db.add(t)
            db.commit()
        return t.id
    finally:
        db.close()


def _upload(client, title: str, headers=None) -> str:
    _ensure_value("bytasks-model")
    data = {
        "title": title,
        "description": "by-tasks 回归",
        "demo_type": "web",
        "tags": json.dumps(["model:bytasks-model"]),
    }
    files = {"file": ("index.html", f"<!doctype html><body>{title}</body>".encode(), "text/html")}
    r = client.post("/api/v1/demos", data=data, files=files, headers=headers or {})
    assert r.status_code == 201, r.text
    return r.json()["slug"]


def _attach(demo_slug: str, task_id: int) -> None:
    db = _db()
    try:
        d = db.query(Demo).filter(Demo.slug == demo_slug).first()
        assert d is not None
        exists = db.query(DemoTask).filter(DemoTask.demo_id == d.id, DemoTask.task_id == task_id).first()
        if exists is None:
            db.add(DemoTask(demo_id=d.id, task_id=task_id))
            db.commit()
    finally:
        db.close()


def test_by_tasks_returns_whole_group(client):
    tid = _task("bytasks-group", "整组测试题")
    slugs = [_upload(client, f"bytasks-{i}") for i in range(3)]
    for s in slugs:
        _attach(s, tid)

    r = client.get("/api/v1/demos/by-tasks", params={"task_ids": [tid]})
    assert r.status_code == 200, r.text
    rows = r.json()
    got = {d["slug"] for d in rows}
    assert set(slugs) <= got, f"整组应全部返回，实际 {sorted(got)}"
    # 组级时间排序要用 updated_at（列表接口同源字段）
    assert all("updated_at" in d for d in rows)


def test_by_tasks_empty_and_unknown(client):
    assert client.get("/api/v1/demos/by-tasks").json() == []
    assert client.get("/api/v1/demos/by-tasks", params={"task_ids": [999999]}).json() == []


def test_by_tasks_excludes_pending(client):
    tid = _task("bytasks-pending", "待审过滤题")
    approved = _upload(client, "bytasks-approved")
    _attach(approved, tid)
    hidden = _upload(client, "bytasks-pending-demo")
    _attach(hidden, tid)
    # conftest 把 AUTO_APPROVE 设为 true，而 demos.py:961 对匿名上传也是
    # 「auto_approve 或 auto_approve_public 任一开就 approved」——测试环境造不出
    # 天然 pending，这里直接把状态压回 pending，专门验证 by-tasks 的 approved 过滤。
    db = _db()
    try:
        row = db.query(Demo).filter(Demo.slug == hidden).first()
        row.status = "pending"
        db.commit()
    finally:
        db.close()

    r = client.get("/api/v1/demos/by-tasks", params={"task_ids": [tid]})
    slugs = {d["slug"] for d in r.json()}
    assert approved in slugs
    assert hidden not in slugs, "未上架作品不许经 by-tasks 泄露进整组"


def test_by_tasks_ignores_non_positive_ids(client):
    tid = _task("bytasks-ids", "非法 id 题")
    slug = _upload(client, "bytasks-id-ok")
    _attach(slug, tid)
    r = client.get("/api/v1/demos/by-tasks", params={"task_ids": [0, -1, tid]})
    assert r.status_code == 200, r.text
    assert slug in {d["slug"] for d in r.json()}
