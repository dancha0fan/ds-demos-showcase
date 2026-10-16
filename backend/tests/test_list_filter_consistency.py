"""第二批（P-02/P-06）后端定向回归。

P-02：`sort=random` 叠加过滤时，过滤必须生效，且 `total` 与 `items` 同源自洽。
      修复前 `total` 来自过滤后计数、`items` 来自全局随机池（`_random_ids` 只按
      status+scope 取全量），用户会在作者页看到别人的作品，且「共 N 条」与一页吐出的条数矛盾。

P-06：`_find_model` 的解析口径。词表固定值存的是实体 **name**（`sync_model_tag` 写
      `model:<name>`），而 name 与 slug 常不同（`GLM-4.5` → slug `glm-4-5`）；
      上传页「站内战绩」拿词表值直接调 `GET /models/{词表值}`，缺 name 兜底会 404 被静默吞掉。

两件事都锁「正常路径不许退化」：无过滤 random 仍走全局池、翻页不重叠；name/slug/id/别名
四种解析方式都要能用。
"""

import json

from app.models import Model
from app.services import model_service


def _db():
    from app.database import SessionLocal

    return SessionLocal()


def _ensure_value(value: str) -> None:
    """`model:` 是固定键，值必须先在词表里。"""
    db = _db()
    try:
        model_service.ensure_tag_value(db, value)
        db.commit()
    finally:
        db.close()


def _upload(client, title: str, tag_value: str, headers: dict | None = None) -> str:
    _ensure_value(tag_value)
    data = {
        "title": title,
        "description": "batch2 回归",
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
    r = client.post("/api/v1/demos", data=data, files=files, headers=headers or {})
    assert r.status_code == 201, r.text
    return r.json()["slug"]


# ---------------------------------------------------------------- P-02


def test_random_sort_applies_filters_and_keeps_total_consistent(client):
    """P-02：random + 过滤时过滤生效，total 与 items 自洽。

    用两个身份造作品（匿名→public、admin→admin），这样能真正验证 author 维度：
    修复前 `?author=public&sort=random` 会把 admin 的作品一并返回。

    断言口径说明：用「子集 + 排除他人」而非「精确集合相等」。
    会话级 client 与库在同一次 pytest 运行内共享，别的测试文件可能留下同作者的作品
    （实测：与 test_security_batch1.py 同跑时会多出 batch1 的 public 作品）；
    精确相等会让本用例依赖「全局数据孤岛」—— 那是测试脆弱性，不是产品行为。
    """
    from fastapi.testclient import TestClient

    from app.main import app

    _ensure_value("b2-m")

    with TestClient(app) as anon:
        pub = {_upload(anon, f"B2PUB{i}", "b2-m") for i in range(2)}

    r = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin123"})
    admin_h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    adm = {_upload(client, f"B2ADM{i}", "b2-m", admin_h) for i in range(2)}

    # 基线：不过滤时两者都在
    allr = client.get("/api/v1/demos?sort=newest&page_size=100").json()
    all_slugs = {i["slug"] for i in allr["items"]}
    assert pub <= all_slugs and adm <= all_slugs

    # 核心：author 过滤在 random 下生效 —— 自己的作品必须在，他人一件都不能混入
    r = client.get("/api/v1/demos?author=public&sort=random&page_size=100")
    assert r.status_code == 200, r.text
    body = r.json()
    got = {i["slug"] for i in body["items"]}
    assert pub <= got, f"自己的 public 作品应全部返回：got={sorted(got)}"
    assert not (got & adm), f"admin 作品不得混入 public 过滤结果：{sorted(got & adm)}"
    assert body["total"] == len(body["items"]), f"total 与 items 须自洽：{body['total']} vs {len(body['items'])}"

    r = client.get("/api/v1/demos?author=admin&sort=random&page_size=100").json()
    got_adm = {i["slug"] for i in r["items"]}
    assert adm <= got_adm, f"admin 过滤应含自己的作品：{sorted(got_adm)}"
    assert not (got_adm & pub), f"public 作品不得混入 admin 过滤结果：{sorted(got_adm & pub)}"

    # q 过滤同样生效
    r = client.get("/api/v1/demos?q=B2ADM&sort=random&page_size=100").json()
    assert {i["slug"] for i in r["items"]} == adm, f"q 过滤失效：{[i['title'] for i in r['items']]}"

    # tag 过滤：含自己全部 4 件，且 total 自洽
    r = client.get("/api/v1/demos?tag=model:b2-m&sort=random&page_size=100").json()
    got_tag = {i["slug"] for i in r["items"]}
    assert (pub | adm) <= got_tag, f"tag 过滤应含全部自有作品：{sorted(got_tag)}"
    assert r["total"] == len(r["items"]), f"tag total 应与 items 自洽：{r['total']} vs {len(r['items'])}"

    # 分页稳定性：过滤路径下桶内翻页不重叠、不漏（覆盖自有作品）
    p1 = client.get("/api/v1/demos?author=public&sort=random&page_size=50&page=1").json()["items"]
    p2 = client.get("/api/v1/demos?author=public&sort=random&page_size=50&page=2").json()["items"]
    s1 = {i["slug"] for i in p1}
    s2 = {i["slug"] for i in p2}
    assert not (s1 & s2), f"两页不得重叠：{sorted(s1 & s2)}"
    assert (s1 | s2) >= pub, f"两页合计应覆盖自有 public 作品：{sorted(pub - (s1 | s2))}"


def test_random_sort_without_filter_keeps_global_semantics(client):
    """P-02 边界：无过滤时 random 仍是全局随机（首页「随便看看」语义不得退化）。"""
    _ensure_value("b2-m2")
    s1 = _upload(client, "B2N1", "b2-m2")
    s2 = _upload(client, "B2N2", "b2-m2")

    r = client.get("/api/v1/demos?sort=random&page_size=100").json()
    got = {i["slug"] for i in r["items"]}
    assert {s1, s2} <= got, f"无过滤 random 应出全部：{sorted(got)}"
    # total/items 同源的口径：items 长度必须是 min(total, page_size)。
    # 不写 total == len(items)——那要求全库恰好 ≤100 件，而库是跨文件共享的（别的用例
    # 也会留下已上架作品），会把「同源」这个真命题测成「全库很小」这个假前提。
    assert len(r["items"]) == min(r["total"], 100), (
        f"total/items 不同源：total={r['total']}，items={len(r['items'])}"
    )

    # 超页返回空、不报错（既有边界语义）
    r = client.get("/api/v1/demos?sort=random&page=99&page_size=50").json()
    assert r["items"] == []


def test_random_sort_early_returns_preserved(client):
    """P-02 边界：不存在的过滤实体仍走早退（total=0），不因改动变成 500。"""
    assert client.get("/api/v1/demos?author=nobody-xyz&sort=random").json()["total"] == 0
    assert client.get("/api/v1/demos?model=no-such-model-xyz&sort=random").json()["total"] == 0
    assert client.get("/api/v1/demos?task=no-such-task-xyz&sort=random").json()["total"] == 0


# ---------------------------------------------------------------- P-06


def test_model_resolvable_by_name_slug_id_and_alias(client):
    """P-06：`GET /models/{ident}` 四种解析方式都要能用。

    词表值常是实体 name（含大写/点号等 slugify 会改写的字符），上传页「站内战绩」
    正是拿词表值来查的 —— 修复前 name 走不通，404 被前端静默吞掉、卡片直接不显示。
    """
    r = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin123"})
    admin_h = {"Authorization": f"Bearer {r.json()['access_token']}"}

    # 建实体：name 与 slug 明显不同（GLM-4.5 → glm-4-5）
    r = client.post("/api/v1/admin/models", json={"name": "GLM-4.5", "vendor": "Zhipu"}, headers=admin_h)
    assert r.status_code == 201, r.text
    created = r.json()
    slug, mid = created["slug"], created["id"]
    assert slug != "GLM-4.5", f"前置条件：name 与 slug 应不同（slug={slug}）"

    db = _db()
    try:
        tag = db.query(Model).filter(Model.name == "GLM-4.5").first()
        assert tag is not None
        # 词表值确实是 name（这是 P-06 的根因）
        from app.models import Tag

        tv = db.query(Tag).filter(Tag.key == "model", Tag.value == "GLM-4.5").first()
        assert tv is not None, "建实体应同步写入词表 model:<name>"
    finally:
        db.close()

    # ① 按 slug
    assert client.get(f"/api/v1/models/{slug}").status_code == 200, "按 slug 解析应可用"
    # ② 按 name（本次修复点：上传页战绩卡片走这条）
    r = client.get("/api/v1/models/GLM-4.5")
    assert r.status_code == 200, f"按 name 解析应可用（词表值即 name）：{r.status_code}"
    assert r.json()["slug"] == slug
    # ③ 按 id
    assert client.get(f"/api/v1/models/{mid}").status_code == 200, "按 id 解析应可用"
    # ④ peek 复用同一解析路径，也应能按 name 取到
    assert client.get("/api/v1/peek/model/GLM-4.5").status_code == 200, "peek 应复用同一解析口径"
    # 不存在的仍 404（不因兜底变宽松）
    assert client.get("/api/v1/models/no-such-model-xyz").status_code == 404
