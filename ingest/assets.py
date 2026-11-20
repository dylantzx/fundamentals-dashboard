"""Content-addressed asset store.

Files live at <root>/<sha[:2]>/<sha>.<ext>; the DB stores only the reference (sha256 + relative
path). The storage backend is a tiny interface (put / get / local_path) so an S3/GCS backend can
replace LocalAssetStore without touching callers: the relative path doubles as the object key.
"""
from __future__ import annotations

import hashlib
import io
import os
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, List, Optional, Protocol

from PIL import Image

MIME_BY_EXT = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
               "webp": "image/webp"}


@dataclass(frozen=True)
class AssetRef:
    sha256: str
    path: str          # relative key, e.g. "ab/ab12....png"
    mime: str
    width: int
    height: int
    bytes: int


class AssetStore(Protocol):
    def put(self, data: bytes, ext: str) -> AssetRef: ...
    def get(self, rel_path: str) -> bytes: ...
    def local_path(self, rel_path: str) -> Path: ...
    def delete(self, rel_path: str) -> None: ...
    def keys(self) -> Iterator[str]: ...


def asset_key(sha256: str, ext: str) -> str:
    return "%s/%s.%s" % (sha256[:2], sha256, ext.lower().lstrip("."))


def _image_size(data: bytes):
    with Image.open(io.BytesIO(data)) as im:
        return im.size


class LocalAssetStore:
    def __init__(self, root: Path):
        self.root = Path(root)

    def put(self, data: bytes, ext: str) -> AssetRef:
        ext = ext.lower().lstrip(".")
        if ext == "jpeg":
            ext = "jpg"
        sha = hashlib.sha256(data).hexdigest()
        rel = asset_key(sha, ext)
        dest = self.root / rel
        if not dest.exists():  # immutable: same content -> same path, written once
            dest.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(dest.parent), suffix=".tmp")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
        w, h = _image_size(data)
        return AssetRef(sha, rel, MIME_BY_EXT.get(ext, "application/octet-stream"), w, h, len(data))

    def get(self, rel_path: str) -> bytes:
        return (self.root / rel_path).read_bytes()

    def local_path(self, rel_path: str) -> Path:
        return self.root / rel_path

    def delete(self, rel_path: str) -> None:
        path = self.root / rel_path
        if path.exists():
            path.unlink()
        try:
            path.parent.rmdir()  # drop the <sha[:2]> directory once empty
        except OSError:
            pass

    def keys(self) -> Iterator[str]:
        if self.root.is_dir():
            for path in sorted(self.root.glob("??/*")):
                if path.is_file() and not path.name.endswith(".tmp"):
                    yield "%s/%s" % (path.parent.name, path.name)


def put_image(store: AssetStore, im: Image.Image) -> AssetRef:
    """Encode a PIL image as PNG (deterministic, lossless) and store it."""
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return store.put(buf.getvalue(), "png")


def register(conn: sqlite3.Connection, ref: AssetRef, kind: str) -> str:
    """Record an asset in the `assets` table (idempotent). Returns its sha256."""
    conn.execute(
        "INSERT INTO assets (sha256, path, mime, width, height, bytes, kind) VALUES (?,?,?,?,?,?,?) "
        "ON CONFLICT(sha256) DO NOTHING",
        (ref.sha256, ref.path, ref.mime, ref.width, ref.height, ref.bytes, kind))
    return ref.sha256


def lookup(conn: sqlite3.Connection, sha256: str) -> Optional[AssetRef]:
    row = conn.execute("SELECT sha256, path, mime, width, height, bytes FROM assets WHERE sha256=?",
                       (sha256,)).fetchone()
    return AssetRef(*row) if row else None


def garbage(conn: sqlite3.Connection, store: AssetStore) -> dict:
    """Assets nothing references: rows no page/question/answer points at, and stored files with
    no row at all (e.g. crops from an interrupted load). Read-only; see delete_garbage."""
    referenced = {r[0] for r in conn.execute(
        "SELECT asset_sha256 FROM pages UNION SELECT asset_sha256 FROM question_assets "
        "UNION SELECT asset_sha256 FROM answer_assets") if r[0]}
    rows = [dict(r) for r in conn.execute("SELECT sha256, path, bytes, kind FROM assets ORDER BY path")]
    unreferenced = [r for r in rows if r["sha256"] not in referenced]
    known = {r["path"] for r in rows}
    untracked = [k for k in store.keys() if k not in known]
    return {"rows": unreferenced, "files": untracked}


def delete_garbage(conn: sqlite3.Connection, store: AssetStore, garbage_found: dict) -> List[str]:
    """Delete what `garbage` found (re-checking references at delete time). Returns deleted paths.
    Do not run while a load is in progress: its new crops are untracked until it commits."""
    deleted = []
    conn.execute("BEGIN IMMEDIATE")
    try:
        for r in garbage_found["rows"]:
            cur = conn.execute(
                "DELETE FROM assets WHERE sha256 = ? AND sha256 NOT IN (SELECT asset_sha256 FROM pages "
                "UNION SELECT asset_sha256 FROM question_assets WHERE asset_sha256 IS NOT NULL "
                "UNION SELECT asset_sha256 FROM answer_assets WHERE asset_sha256 IS NOT NULL)", (r["sha256"],))
            if cur.rowcount:
                deleted.append(r["path"])
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    for path in deleted + list(garbage_found["files"]):
        store.delete(path)
    return deleted + list(garbage_found["files"])
