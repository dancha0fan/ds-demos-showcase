"""sort=random 的会话固定种子（rs）—— 跨 60s 时间桶翻页的根修：

前端去重只能遮重复，漏项必须靠顺序本身稳定。不变式：
  1. 无 rs 响应必须回传 random_seed；用它重放同页得到同一顺序（可 pin）
  2. 同一种子翻完整段：页间零重复、并集恰为全集（无漏件）
  3. 跨 60s 时间桶（time.time 前跳）同种子顺序不变 —— 回归桶依赖播种即挂
  4. 不同种子给出不同顺序；非法 rs 422
  5. 带过滤（q）时种子同样生效，且顺序仍建立在过滤后集合上
"""

import os

import pytest


def _db():
    from app.database import SessionLocal

    return SessionLocal()


@pytest.fixture()
def seeder(client, auth_headers):
    """注册一个用户并上传 N 件已上架作品（AUTO_APPROVE=true；登录上传无匿名限流）。"""
    headers, username = auth_headers()

    def _seed(prefix: str, n: int):
        for i in range(n):
            data = {
                "title": f"{prefix}{i:02d}",
                "description": "随机翻页种子测试",
                "demo_type": "web",
                "tags": '["model:unspecified"]',
            }
            files = {"file": ("index.html", f"<!doctype html><body>{prefix}{i}-{os.urandom(4).hex()}</body>".encode(), "text/html")}
            r = client.post("/api/v1/demos", data=data, files=files, headers=headers)
            assert r.status_code == 201, r.text

    return _seed


def _rand(client, **params):
    return client.get("/api/v1/demos", params={"sort": "random", **params})


def _slugs(payload):
    return [d["slug"] for d in payload["items"]]


def test_seed_roundtrip_and_full_pagination(client, seeder):
    """口径：把池子收窄到本用例自己播的 12 件（q=rseed）。

    conftest 的库是 session 级、跨文件共享的（别的用例也会上传已上架作品），
    拿「全局最新 100 件」当参照会让断言依赖「全库恰好 ≤15 件」——那是测试脆弱性，
    不是产品行为（同款口径说明见 test_list_filter_consistency.py 的 P-02 用例）。
    """
    seeder("rseed", 12)
    scope = {"q": "rseed"}  # 只覆盖本用例自己播的 12 件
    r1 = _rand(client, page=1, page_size=5, **scope)
    assert r1.status_code == 200, r1.text
    p1 = r1.json()
    seed = p1["random_seed"]
    assert seed, "无 rs 响应必须回传 random_seed，否则客户端无从 pin 顺序"
    assert p1["total"] == 12, f"过滤后 total 必须是本用例自己的 12 件，实际 {p1['total']}"

    # 回放同页：同种子同顺序（可 pin 的定义）
    r1b = _rand(client, page=1, page_size=5, rs=seed, **scope)
    assert _slugs(r1b.json()) == _slugs(p1)

    # 翻完整段：页间零重复，并集恰为全集（无漏件）
    seen: list[str] = []
    for page in range(1, 4):  # 12 件 / 每页 5 → 3 页取完
        r = _rand(client, page=page, page_size=5, rs=seed, **scope)
        assert r.status_code == 200
        seen.extend(_slugs(r.json()))
    assert len(seen) == len(set(seen)), "同一种子翻页出现重复件"
    assert len(seen) == p1["total"], f"同一种子翻页漏件：取到 {len(seen)} 件，应为 {p1['total']}"
    ref = client.get("/api/v1/demos", params={"sort": "newest", "page_size": 100, **scope}).json()
    assert set(seen) == {d["slug"] for d in ref["items"]}, "同一种子翻页漏件"
    assert p1["total"] == ref["total"]


def test_seed_survives_ttl_jump(client, seeder, monkeypatch):
    seeder("rttl", 12)
    r1 = _rand(client, page=1, page_size=5, rs="ttl-jump-seed")
    page1 = _slugs(r1.json())
    r2 = _rand(client, page=2, page_size=5, rs="ttl-jump-seed")
    page2 = _slugs(r2.json())

    # 时间前跳多个 60s 桶：同种子顺序必须原样（旧实现按时间桶播种，这里必挂）
    import app.routers.demos as demos_mod

    real_time = demos_mod.time.time
    monkeypatch.setattr(demos_mod.time, "time", lambda: real_time() + 3600 * 6)
    r2b = _rand(client, page=2, page_size=5, rs="ttl-jump-seed")
    assert _slugs(r2b.json()) == page2, "跨时间桶同种子顺序漂移（漏项根因回归）"
    assert not set(page1) & set(page2)

    # 回跳后仍然一致（种子不依赖当前时间方向）
    monkeypatch.setattr(demos_mod.time, "time", lambda: real_time() - 3600 * 6)
    r1b = _rand(client, page=1, page_size=5, rs="ttl-jump-seed")
    assert _slugs(r1b.json()) == page1


def test_seedless_seed_is_pinable_across_buckets(client, seeder, monkeypatch):
    seeder("rpin", 12)
    r1 = _rand(client, page=1, page_size=5)
    seed = r1.json()["random_seed"]
    page1 = _slugs(r1.json())

    import app.routers.demos as demos_mod

    real_time = demos_mod.time.time
    monkeypatch.setattr(demos_mod.time, "time", lambda: real_time() + 3600)
    # 无 rs 的新请求可能换序（旧行为），但拿第一次的种子回传必须能续上原序
    p2a = _slugs(_rand(client, page=2, page_size=5, rs=seed).json())
    p2b = _slugs(_rand(client, page=2, page_size=5, rs=seed).json())
    assert p2a == p2b
    assert not set(page1) & set(p2a)


def test_different_seeds_differ_and_invalid_rs_422(client, seeder):
    seeder("rdiff", 12)
    a = _slugs(_rand(client, page=1, page_size=12, rs="seed-a").json())
    b = _slugs(_rand(client, page=1, page_size=12, rs="seed-b").json())
    assert a != b, "不同种子应给出不同顺序（12 件全同序概率 1/12!，可忽略）"
    assert _rand(client, page=1, rs="bad seed!").status_code == 422
    assert _rand(client, page=1, rs="x" * 65).status_code == 422


def test_filtered_random_respects_seed_and_filter(client, seeder, monkeypatch):
    seeder("rqmark", 6)
    r1 = _rand(client, page=1, page_size=4, q="rqmark", rs="filter-seed")
    p1 = r1.json()
    assert p1["total"] == 6, "种子不得干扰过滤（total 必须是过滤后计数）"
    assert all(d["title"].startswith("rqmark") for d in p1["items"])

    import app.routers.demos as demos_mod

    real_time = demos_mod.time.time
    monkeypatch.setattr(demos_mod.time, "time", lambda: real_time() + 3600)
    p2 = _slugs(_rand(client, page=2, page_size=4, q="rqmark", rs="filter-seed").json())
    assert not set(_slugs(p1)) & set(p2), "过滤 + 跨桶翻页不得重复"
