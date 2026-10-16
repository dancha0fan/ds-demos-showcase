"""图像作品一期（demo_type=image）的最小闭环与安全口径。

重点钉住（按方案 §B/C）：
- png/jpg/webp 上传不再 422，生成展示大图（1280 webp）+ 两档缩略图
- 损坏文件 / 假扩展名（txt 伪装 png）/ 缺文件 → 400，且不留孤儿行/孤儿文件
- 缺省 prompt/tags 非启用新字段即可提交；model 兜底走同一路径
- 下载 = 展示大图（webp），web/zip 不影响
- chain.rows 带 cover_url；未过审（candidate）作品不进 chain → 不会经「并排看」漏给公开侧
- web/zip/link 既有行为不变
"""

import io

from PIL import Image

from app.database import SessionLocal
from app.models import DemoTask, Task


def _db():
    return SessionLocal()


def _png_bytes(w=400, h=300, color=(200, 30, 30)) -> bytes:
    img = Image.new("RGB", (w, h), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _upload_image(client, title, img=None, filename="work.png", prompt="", tags=None, extra=None):
    data = {
        "title": title,
        "description": "图像作品上传用例",
        "demo_type": "image",
        "prompt": prompt,
        "tags": '["model:unspecified", "type:effect"]' if tags is None else tags,
    }
    if extra:
        data.update(extra)
    files = {"file": (filename, img, "image/png")} if img is not None else None
    return client.post("/api/v1/demos", data=data, files=files)


def _demo_id(slug):
    db = _db()
    try:
        d = db.query(__import__("app.models", fromlist=["Demo"]).Demo).filter_by(slug=slug).first()
        return d.id if d else None
    finally:
        db.close()


def test_image_upload_png_ok(client):
    r = _upload_image(client, "图像PNG", img=_png_bytes(800, 600))
    assert r.status_code == 201, r.text
    slug = r.json()["slug"]
    detail = client.get(f"/api/v1/demos/{slug}").json()
    assert detail["demo_type"] == "image"
    assert detail["cover_url"].startswith("/media/covers/")
    assert detail["cover_url"].endswith(".webp")
    assert not detail.get("preview_url")  # preview_url 是 web 专属
    # 展示大图（1280 webp）+ 两档缩略图（-thumb 200 / -card 640）已派生到磁盘；
    # detail 序列化不单独吐 cover_thumb_url（schema 未声明该字段，由前端按需派生）
    from app.config import settings as _settings
    from pathlib import Path as _Path
    stem = detail["cover_url"].rsplit("/media/covers/", 1)[-1].removesuffix(".webp")
    covers_dir = _settings.media_path / "covers"
    assert (covers_dir / f"{stem}.webp").is_file()
    assert (covers_dir / f"{stem}-thumb.webp").is_file()
    assert (covers_dir / f"{stem}-card.webp").is_file()


def test_image_upload_rejects_fake_ext_and_leaves_no_orphans(client):
    before = {d["slug"] for d in client.get("/api/v1/demos?page_size=100").json()["items"]}
    r = _upload_image(client, "图像假PNG", img=b"this is not an image at all", filename="fake.png")
    assert r.status_code == 400, r.text
    after = {d["slug"] for d in client.get("/api/v1/demos?page_size=100").json()["items"]}
    assert before == after, f"坏图像上传产生了孤儿行: {after - before}"


def test_image_upload_rejects_wrong_ext(client):
    img = _png_bytes()
    r = client.post(
        "/api/v1/demos",
        data={"title": "图像TXT", "description": "x", "demo_type": "image", "tags": '["model:unspecified"]'},
        files={"file": ("note.txt", img, "image/png")},
    )
    assert r.status_code == 400, r.text
    assert "PNG" in r.text and "WEBP" in r.text  # 文案点明白名单


def test_image_upload_requires_file(client):
    r = client.post(
        "/api/v1/demos",
        data={"title": "图像无文件", "description": "x", "demo_type": "image", "tags": '["model:unspecified"]'},
    )
    assert r.status_code == 400, r.text
    assert "图像文件" in r.text or "必须上传" in r.text


def test_image_variants_jpg_webp_ok(client):
    jbuf = io.BytesIO()
    Image.new("RGB", (320, 240), (10, 200, 10)).save(jbuf, format="JPEG")
    r = client.post(
        "/api/v1/demos",
        data={"title": "图像JPG", "description": "x", "demo_type": "image", "tags": '["model:unspecified"]'},
        files={"file": ("photo.jpg", jbuf.getvalue(), "image/jpeg")},
    )
    assert r.status_code == 201, r.text
    wbuf = io.BytesIO()
    Image.new("RGB", (320, 240), (10, 10, 200)).save(wbuf, format="WEBP")
    r = client.post(
        "/api/v1/demos",
        data={"title": "图像WEBP", "description": "x", "demo_type": "image", "tags": '["model:unspecified"]'},
        files={"file": ("picture.webp", wbuf.getvalue(), "image/webp")},
    )
    assert r.status_code == 201, r.text


def test_image_download_returns_webp(client):
    r = _upload_image(client, "图像下载", img=_png_bytes(600, 400))
    assert r.status_code == 201, r.text
    slug = r.json()["slug"]
    dl = client.get(f"/api/v1/demos/{slug}/download")
    assert dl.status_code == 200
    assert "image/webp" in dl.headers.get("content-type", "")
    assert dl.content[:4] == b"RIFF"
    assert b"WEBP" in dl.content[:16]


def test_image_model_hint_fallback_path(client):
    r = client.post(
        "/api/v1/demos",
        data={
            "title": "图像兜底型号",
            "description": "x",
            "demo_type": "image",
            "tags": '["model:ds-unknown"]',
            "model_hint": "prompt 标注为灰测版，未公开型号",
        },
        files={"file": ("g.png", _png_bytes(), "image/png")},
    )
    assert r.status_code == 201, r.text
    detail = client.get(f"/api/v1/demos/{r.json()['slug']}").json()
    assert detail["model_hint"] == "prompt 标注为灰测版，未公开型号"


def test_same_author_duplicate_image_409(client):
    img = _png_bytes(500, 333)
    a = _upload_image(client, "图像去重A", img=img)
    assert a.status_code == 201, a.text
    b = _upload_image(client, "图像去重B", img=img)
    assert b.status_code == 409, b.text


def test_web_zip_link_unaffected(client):
    r = client.post(
        "/api/v1/demos",
        data={"title": "回归-web", "description": "x", "demo_type": "web", "tags": '["model:unspecified"]'},
        files={"file": ("index.html", b"<!doctype html><title>t</title>", "text/html")},
    )
    assert r.status_code == 201, r.text
    d = client.get(f"/api/v1/demos/{r.json()['slug']}").json()
    assert d["demo_type"] == "web"
    assert d.get("preview_url")
    r = client.post(
        "/api/v1/demos",
        data={"title": "回归-link", "description": "x", "demo_type": "link",
              "external_url": "https://example.com/x", "tags": '["model:unspecified"]'},
    )
    assert r.status_code == 201, r.text
    d = client.get(f"/api/v1/demos/{r.json()['slug']}").json()
    assert d["demo_type"] == "link" and d.get("external_url") == "https://example.com/x"
    import zipfile as _zf
    zbuf = io.BytesIO()
    with _zf.ZipFile(zbuf, "w") as zf:
        zf.writestr("index.html", "<!doctype html><title>z</title>")
    r = client.post(
        "/api/v1/demos",
        data={"title": "回归-zip", "description": "x", "demo_type": "zip", "tags": '["model:unspecified"]'},
        files={"file": ("p.zip", zbuf.getvalue(), "application/zip")},
    )
    assert r.status_code == 201, r.text
    assert client.get(f"/api/v1/demos/{r.json()['slug']}").json()["demo_type"] == "zip"


def test_image_upload_and_detail_roundtrip(client):
    r = _upload_image(client, "图像细节", img=_png_bytes(640, 480),
                      prompt="a very long prompt that should be preserved verbatim")
    assert r.status_code == 201, r.text
    d = client.get(f"/api/v1/demos/{r.json()['slug']}").json()
    assert d["prompt"] == "a very long prompt that should be preserved verbatim"
    assert isinstance(d.get("models"), list)
    assert "rating_avg" in d and "rating_count" in d


def test_task_chain_has_cover_url_and_no_pending_leak(client):
    """并排看的数据来源：chain.rows 有 cover_url；非 approved 作品不进 chain。"""
    from app.models import Demo as DemoRow

    tslug = "img-compare-task"
    db = _db()
    try:
        t = db.query(Task).filter(Task.slug == tslug).first()
        if t is None:
            t = Task(slug=tslug, title="图像并排题", description="d", status="active")
            db.add(t)
            db.commit()
        tid = t.id
    finally:
        db.close()

    a_slug = _upload_image(client, "并排图A", img=_png_bytes(300, 300, (255, 0, 0))).json()["slug"]
    b_slug = _upload_image(client, "并排图B", img=_png_bytes(300, 300, (0, 255, 0))).json()["slug"]

    # a 通过（AUTO_APPROVE=true → approved）；b 手动改为 pending 模拟未过审
    db = _db()
    try:
        b = db.query(DemoRow).filter(DemoRow.slug == b_slug).first()
        a = db.query(DemoRow).filter(DemoRow.slug == a_slug).first()
        db.add(DemoTask(task_id=tid, demo_id=a.id))
        db.add(DemoTask(task_id=tid, demo_id=b.id))
        b.status = "pending"  # 模拟未过审
        db.commit()
    finally:
        db.close()

    task = client.get(f"/api/v1/tasks/{tslug}").json()
    rows = task["chain"]["rows"]
    slugs = {row["slug"] for row in rows}
    assert a_slug in slugs, "approved 图像作品应进 chain"
    assert b_slug not in slugs, "pending 作品不得进 chain（并排看不得泄露未过审内容）"

    for row in rows:
        assert "cover_url" in row
        if row["slug"] == a_slug:
            assert row["cover_url"].startswith("/media/covers/"), row


def test_from_url_image_requires_file_url(client):
    r = client.post(
        "/api/v1/demos/from-url",
        json={
            "title": "图像fromurl",
            "description": "x",
            "demo_type": "image",
            "tags": ["model:unspecified"],
            "external_url": "https://example.com",
        },
    )
    assert r.status_code == 422, r.text
    assert "file_url" in r.text
