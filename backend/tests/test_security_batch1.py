"""第一批安全修复的定向回归用例（P-01 预览 version 注入、P-03 peek 状态门禁）。

两件事各锁一组不变量：

P-01（version 段注入）：
  1. 含引号/尖括号的 version 一律 400，且响应体不含注入标签；
  2. 两条真实生成的 version 形态（12 位十六进制 hash、纯数字时间戳）仍能正常预览；
  3. 无版本旧链接、子资源（js）仍走原路径 —— 修复只收紧非法输入，不改正常链路。

P-03（peek 状态门禁）——范围**仅题目侧**：
  4. 题目：merged/hidden 对**所有角色**（含管理员）404，candidate 仅 admin
     （依据 tasks.py:55 / task_service.py:562 的 KB-15 明文口径）；
  5. 模型：**不做状态门禁**，保持基线语义 —— 规范与测试只约束列表口径
     （list_models docstring / models.py:17），实体详情对 candidate/deprecated 一律 200，
     无「实体详情须保密」的要求；收紧属产品行为变更，是待产品决策项；
  6. peek/demo 保持原语义（详情页 capability URL 本就按 slug 开放，不额外加门禁）。

注意：TestClient 会自动持久化 cookie，所以「匿名」断言必须用**独立 client 实例**，
否则前面 admin 登录留下的 cookie 会让请求带管理员身份，把 candidate 用例误判成通过。
"""

import json
import os

from app.models import Model, Task


def _db():
    from app.database import SessionLocal

    return SessionLocal()


def _ensure_value(value: str) -> None:
    """`model:` 是固定键，值必须先在词表里。"""
    from app.services import model_service

    db = _db()
    try:
        model_service.ensure_tag_value(db, value)
        db.commit()
    finally:
        db.close()


def _upload_web(client, title: str, tag_value: str) -> str:
    _ensure_value(tag_value)
    data = {
        "title": title,
        "description": "batch1 安全回归",
        "demo_type": "web",
        "tags": json.dumps([f"model:{tag_value}"]),
    }
    files = {
        "file": (
            "index.html",
            f"<!doctype html><html><head><title>{title}</title></head><body>x</body></html>".encode(),
            "text/html",
        )
    }
    r = client.post("/api/v1/demos", data=data, files=files)
    assert r.status_code == 201, r.text
    return r.json()["slug"]


def _real_version(client, slug: str) -> str:
    """取该 demo 真实 preview_url 里的 version 段（与线上同源）。"""
    detail = client.get(f"/api/v1/demos/{slug}").json()
    prev = detail.get("preview_url") or ""
    assert "/v" in prev, prev
    return prev.split("/v", 1)[1].split("/", 1)[0]


# ---------------------------------------------------------------- P-01


def test_preview_version_rejects_injection_and_keeps_legal_forms(client):
    """P-01：version 是白名单收口的路径段，非法输入 400；两种合法形态与旧链接不受影响。"""
    slug = _upload_web(client, "Batch1 Preview", "b1-prev")

    # 非法：引号 + 标签（修复前会原样进入 <base href>）
    bad = 'x%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E'
    r = client.get(f"/preview/{slug}/v{bad}/index.html")
    assert r.status_code == 400, f"恶意 version 应 400，实际 {r.status_code}"
    assert "onerror=alert(1)" not in r.text, "响应体不得含注入内容"

    # 非法：尖括号 / 空白 / 超长
    for raw in ("%3Cscript%3E", "a%20b", "x" * 65):
        rr = client.get(f"/preview/{slug}/v{raw}/index.html")
        assert rr.status_code == 400, f"{raw!r} 应 400，实际 {rr.status_code}"

    # 合法形态①：真实 hash（12 位十六进制）
    real = _real_version(client, slug)
    r = client.get(f"/preview/{slug}/v{real}/index.html")
    assert r.status_code == 200, r.text
    assert '<base href="/preview/' in r.text, "合法版本化 URL 仍应注入 base"
    assert "immutable" in r.headers.get("cache-control", ""), r.headers.get("cache-control")

    # 合法形态②：纯数字时间戳（无 content_hash 的历史行回落到此形态）
    r = client.get(f"/preview/{slug}/v1700000000/index.html")
    assert r.status_code == 200, r.text

    # 历史兼容：无版本旧链接仍在，且保持 no-cache
    r = client.get(f"/preview/{slug}/index.html")
    assert r.status_code == 200, r.text
    assert r.headers.get("cache-control") == "no-cache", r.headers.get("cache-control")

    # 正常子资源链路不受影响
    from app.services import storage as st

    (st.demo_files_dir(slug) / "app.js").write_bytes(b"console.log(1)")
    r = client.get(f"/preview/{slug}/v{real}/app.js")
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------- P-03


def _add_task(slug: str, status: str) -> None:
    db = _db()
    try:
        if db.query(Task).filter(Task.slug == slug).first() is None:
            db.add(Task(slug=slug, title=f"B1 {status}", description="内部题面", status=status))
            db.commit()
    finally:
        db.close()


def _add_model(slug: str, status: str) -> None:
    db = _db()
    try:
        if db.query(Model).filter(Model.slug == slug).first() is None:
            db.add(Model(slug=slug, name=f"B1 {slug}", status=status, description="内部描述"))
            db.commit()
    finally:
        db.close()


def test_peek_task_status_gate_matches_task_detail(client):
    """P-03：题目侧与 `task_detail`（KB-15）逐字同口径。

    merged/hidden 对所有角色 404（管理员也不例外）；candidate 仅 admin。
    """
    from fastapi.testclient import TestClient

    from app.main import app

    _add_task("b1-task-hidden", "hidden")
    _add_task("b1-task-merged", "merged")
    _add_task("b1-task-cand", "candidate")

    # 匿名：全新 client，避免上面的 admin 会话 cookie 污染
    with TestClient(app) as anon:
        for s in ("b1-task-hidden", "b1-task-merged", "b1-task-cand"):
            r = anon.get(f"/api/v1/peek/task/{s}")
            assert r.status_code == 404, f"匿名 peek {s} 应 404，实际 {r.status_code}"

    # 管理员
    r = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin123"})
    admin_h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    r = client.get("/api/v1/peek/task/b1-task-cand", headers=admin_h)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "B1 candidate"
    # merged/hidden 对管理员同样 404 —— 与 /tasks/{slug} 详情一致
    for s in ("b1-task-hidden", "b1-task-merged"):
        r = client.get(f"/api/v1/peek/task/{s}", headers=admin_h)
        assert r.status_code == 404, f"管理员 peek {s} 应仍 404（详情页基准口径），实际 {r.status_code}"

    # 与既有详情接口口径交叉核对（证明 peek 是对齐而非自造规则）
    assert client.get("/api/v1/tasks/b1-task-hidden", headers=admin_h).status_code == 404
    assert client.get("/api/v1/tasks/b1-task-cand", headers=admin_h).status_code == 200


def test_peek_model_status_keeps_baseline_semantics(client):
    """P-03 范围边界：模型侧**状态可见性不做门禁**，保持基线语义。

    为什么这里锁的是「全部 200」而不是「deprecated 404」：
      规范与测试只约束**列表**口径（list_models docstring / models.py:17 的「缺省展示
      active+unverified」），实体详情 `GET /models/{slug}` 对 candidate/deprecated 一律 200，
      规范里没有任何「实体详情须保密」的要求。把列表的展示策略推导成实体详情的保密要求，
      会构成产品行为变更 —— 属待产品决策项，不在本次安全修复范围。

    本用例的作用是**防止后续把模型侧一并收紧**（那会静默改变公开行为）。
    """
    from fastapi.testclient import TestClient

    from app.main import app

    _add_model("b1-model-cand", "candidate")
    _add_model("b1-model-dep", "deprecated")
    _add_model("b1-model-act", "active")
    _add_model("b1-model-unv", "unverified")

    with TestClient(app) as anon:
        # 四种状态在 peek 与实体详情上行为一致（都不拦）
        for s in ("b1-model-cand", "b1-model-dep", "b1-model-act", "b1-model-unv"):
            r = anon.get(f"/api/v1/peek/model/{s}")
            assert r.status_code == 200, f"peek {s} 应保持 200（基线语义），实际 {r.status_code}"
            assert anon.get(f"/api/v1/models/{s}").status_code == 200, f"详情 {s} 应 200（既有行为）"
        # 字段集不得缩水（侧滑预览依赖）
        j = anon.get("/api/v1/peek/model/b1-model-act").json()
        for k in ("kind", "slug", "name", "vendor", "resolution", "status", "description",
                  "demo_count", "votes", "score", "sample_level", "demos", "full_path"):
            assert k in j, f"peek 模型缺少字段 {k}"

    # 列表侧口径未被波及：deprecated 仍不在公开列表缺省结果里
    listed = {m["slug"] for m in client.get("/api/v1/models?page_size=100").json()["items"]}
    assert "b1-model-dep" not in listed, "列表缺省口径不应被本次改动影响"
    assert "b1-model-act" in listed


def test_peek_demo_keeps_capability_semantics(client):
    """P-03 边界：demo 分支不加状态门禁（详情页 capability URL 本就按 slug 开放）。"""
    from fastapi.testclient import TestClient

    from app.main import app

    slug = _upload_web(client, "Batch1 Capability", "b1-cap")
    with TestClient(app) as anon:
        r = anon.get(f"/api/v1/peek/demo/{slug}")
        assert r.status_code == 200, r.text
        assert r.json()["kind"] == "demo"
        assert anon.get("/api/v1/peek/demo/no-such-demo-xyz").status_code == 404


def test_peek_unknown_kind_still_422(client):
    """修复不得改变既有的"不猜"行为。"""
    assert client.get("/api/v1/peek/thing/x").status_code == 422
    assert client.get("/api/v1/peek/model/no-such-model-xyz").status_code == 404
    assert client.get("/api/v1/peek/task/no-such-task-xyz").status_code == 404
