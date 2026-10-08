"""Keeps the AI service's learned files (app/data: the fine-tuned shopping model, the interest models) in a private
Supabase Storage bucket, for hosts without a permanent disk (Render's free plan wipes the disk on every restart
and deploy).

- At startup, before the service loads its models: `python -m app.services.data_sync restore` downloads the files.
- While running: `sync_changed()` uploads files that changed since the last upload (called every few minutes and
  at shutdown from app.main).

Off unless DATA_SYNC=supabase and the Supabase URL and service-role key are set. The bucket is private: only the
service-role key can read it. Only app/data is copied; nothing else.
"""
from __future__ import annotations

import sys
from pathlib import Path

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger()

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_uploaded: dict[str, tuple[float, int]] = {}   # file -> (mtime, size) at its last upload


def enabled() -> bool:
    return settings.data_sync == "supabase" and bool(settings.supabase_url and settings.supabase_service_role_key)


def _base() -> str:
    return settings.supabase_url.rstrip("/") + "/storage/v1"


def _headers() -> dict[str, str]:
    key = settings.supabase_service_role_key
    return {"Authorization": f"Bearer {key}", "apikey": key}


def _ensure_bucket(client: httpx.Client) -> None:
    r = client.post(f"{_base()}/bucket", headers=_headers(),
                    json={"id": settings.data_sync_bucket, "name": settings.data_sync_bucket, "public": False})
    if r.status_code not in (200, 201) and "already exists" not in r.text.lower() and r.status_code != 409:
        logger.warning("data_sync.bucket", status=r.status_code)


def _list(client: httpx.Client, prefix: str = "") -> list[str]:
    """Every file path in the bucket under `prefix` (folders are walked)."""
    r = client.post(f"{_base()}/object/list/{settings.data_sync_bucket}", headers=_headers(),
                    json={"prefix": prefix, "limit": 1000, "offset": 0})
    r.raise_for_status()
    files: list[str] = []
    for item in r.json():
        path = f"{prefix}{item['name']}"
        if item.get("id") is None:          # a folder
            files += _list(client, path + "/")
        else:
            files.append(path)
    return files


def restore() -> int:
    """Downloads the bucket's files into app/data. Returns how many were restored."""
    if not enabled():
        return 0
    restored = 0
    with httpx.Client(timeout=60) as client:
        _ensure_bucket(client)
        for path in _list(client):
            r = client.get(f"{_base()}/object/{settings.data_sync_bucket}/{path}", headers=_headers())
            if r.status_code != 200:
                logger.warning("data_sync.restore.file_failed", path=path, status=r.status_code)
                continue
            target = DATA_DIR / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(r.content)
            st = target.stat()
            _uploaded[path] = (st.st_mtime, st.st_size)
            restored += 1
    logger.info("data_sync.restored", files=restored)
    return restored


def sync_changed() -> int:
    """Uploads the files in app/data that changed since their last upload. Returns how many were uploaded."""
    if not enabled() or not DATA_DIR.exists():
        return 0
    uploaded = 0
    with httpx.Client(timeout=60) as client:
        for f in DATA_DIR.rglob("*"):
            if not f.is_file():
                continue
            path = f.relative_to(DATA_DIR).as_posix()
            st = f.stat()
            if _uploaded.get(path) == (st.st_mtime, st.st_size):
                continue
            r = client.post(f"{_base()}/object/{settings.data_sync_bucket}/{path}", content=f.read_bytes(),
                            headers={**_headers(), "x-upsert": "true", "Content-Type": "application/octet-stream"})
            if r.status_code in (200, 201):
                _uploaded[path] = (st.st_mtime, st.st_size)
                uploaded += 1
            else:
                logger.warning("data_sync.upload_failed", path=path, status=r.status_code)
    if uploaded:
        logger.info("data_sync.uploaded", files=uploaded)
    return uploaded


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "restore":
        try:
            restore()
        except Exception as e:   # a failed restore must not stop the service from starting
            logger.warning("data_sync.restore_failed", error=str(e))
