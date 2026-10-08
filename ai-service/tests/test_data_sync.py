"""The learned-files backup (app/services/data_sync.py) against a fake Supabase Storage."""
import json

import httpx
import pytest

from app.services import data_sync


class FakeStorage:
    """Just enough of Supabase Storage: create bucket, list (with folders), download, upload with upsert."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.bucket = False
        self.uploads = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer service-key"
        path = request.url.path.removeprefix("/storage/v1")
        if request.method == "POST" and path == "/bucket":
            body = json.loads(request.content)
            assert body["public"] is False
            if self.bucket:
                return httpx.Response(400, json={"message": "The resource already exists"})
            self.bucket = True
            return httpx.Response(200, json={"name": body["name"]})
        if request.method == "POST" and path == "/object/list/aura-ai-data":
            prefix = json.loads(request.content)["prefix"]
            names, folders = [], set()
            for f in self.files:
                if not f.startswith(prefix):
                    continue
                rest = f[len(prefix):]
                if "/" in rest:
                    folders.add(rest.split("/")[0])
                else:
                    names.append({"name": rest, "id": "x"})
            return httpx.Response(200, json=names + [{"name": d, "id": None} for d in sorted(folders)])
        if path.startswith("/object/aura-ai-data/"):
            key = path.removeprefix("/object/aura-ai-data/")
            if request.method == "GET":
                return httpx.Response(200, content=self.files[key]) if key in self.files else httpx.Response(404)
            assert request.headers["x-upsert"] == "true"
            self.files[key] = request.content
            self.uploads += 1
            return httpx.Response(200, json={"Key": key})
        return httpx.Response(404)


@pytest.fixture
def storage(monkeypatch, tmp_path):
    fake = FakeStorage()
    monkeypatch.setattr(data_sync.settings, "data_sync", "supabase")
    monkeypatch.setattr(data_sync.settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(data_sync.settings, "supabase_service_role_key", "service-key")
    monkeypatch.setattr(data_sync, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(data_sync, "_uploaded", {})
    real = httpx.Client
    monkeypatch.setattr(data_sync.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(fake.handler), **kw))
    return fake


def test_off_unless_configured(monkeypatch):
    monkeypatch.setattr(data_sync.settings, "data_sync", "")
    assert not data_sync.enabled()
    assert data_sync.restore() == 0 and data_sync.sync_changed() == 0


def test_changed_files_are_uploaded_once(storage, tmp_path):
    d = tmp_path / "data"
    (d / "shopping").mkdir(parents=True)
    (d / "shopping" / "model.txt").write_text("tree 1")
    (d / "meta.json").write_text("{}")
    assert data_sync.sync_changed() == 2
    assert set(storage.files) == {"shopping/model.txt", "meta.json"}
    assert data_sync.sync_changed() == 0                     # nothing changed: nothing sent
    (d / "shopping" / "model.txt").write_text("tree 2, retrained")
    assert data_sync.sync_changed() == 1
    assert storage.files["shopping/model.txt"] == b"tree 2, retrained"


def test_restore_brings_back_files_after_a_fresh_start(storage, tmp_path):
    storage.files = {"shopping/model.txt": b"learned", "interest_model_shopping_meta.json": b"{\"v\": 1}"}
    storage.bucket = True
    assert data_sync.restore() == 2
    d = tmp_path / "data"
    assert (d / "shopping" / "model.txt").read_bytes() == b"learned"
    assert data_sync.sync_changed() == 0                     # just restored: no needless re-upload


def test_restore_creates_a_private_bucket_when_missing(storage):
    assert data_sync.restore() == 0
    assert storage.bucket
