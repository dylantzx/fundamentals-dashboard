"""SQLite connection, schema bootstrap, deterministic IDs, taxonomy seeding."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from ingest.config import TAXONOMY_PATH

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def connect(db_path: Path, taxonomy_path: Path = TAXONOMY_PATH) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None: we manage transactions explicitly (BEGIN/COMMIT in load).
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA_PATH.read_text())
    _migrate(conn)
    seed_topics(conn, load_taxonomy(taxonomy_path))
    return conn


# Columns added after a table was first created. CREATE TABLE IF NOT EXISTS does not touch an
# existing table, so older databases get them here (ALTER TABLE ADD COLUMN is portable SQL).
ADDED_COLUMNS = [
    ("questions", "choice_group", "TEXT"),
    ("questions", "review_flags", "TEXT NOT NULL DEFAULT '[]'"),
    ("questions", "review_status", "TEXT NOT NULL DEFAULT 'ok'"),
    ("questions", "review_reasons", "TEXT NOT NULL DEFAULT '[]'"),
    ("answers", "confidence", "TEXT"),
    ("answers", "review_flags", "TEXT NOT NULL DEFAULT '[]'"),
]


def _migrate(conn: sqlite3.Connection) -> None:
    for table, column, decl in ADDED_COLUMNS:
        have = {r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)}
        if column not in have:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, decl))


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _hid(*parts: str) -> str:
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


def question_id(document_id: str, paper: str, label: str) -> str:
    return "q_" + _hid(document_id, paper, label)


def answer_id(document_id: str, paper: str, label: str) -> str:
    return "a_" + _hid(document_id, paper, "answer", label)


# ---------------------------------------------------------------- taxonomy

def load_taxonomy(path: Path = TAXONOMY_PATH) -> List[dict]:
    """Flatten the taxonomy file into [{code, name, parent_code}], parents first."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    out = []
    for t in data["topics"]:
        out.append({"code": str(t["code"]), "name": t["name"], "parent_code": None})
        for s in t.get("subtopics", []):
            out.append({"code": str(s["code"]), "name": s["name"], "parent_code": str(t["code"])})
    return out


def topic_names(path: Path = TAXONOMY_PATH) -> Dict[str, str]:
    return {t["code"]: t["name"] for t in load_taxonomy(path)}


def seed_topics(conn: sqlite3.Connection, topics: List[dict]) -> None:
    conn.execute("BEGIN")
    for t in topics:
        conn.execute(
            "INSERT INTO topics (code, name, parent_code) VALUES (?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET name=excluded.name, parent_code=excluded.parent_code",
            (t["code"], t["name"], t["parent_code"]))
    conn.execute("COMMIT")


# ---------------------------------------------------------------- documents

def document_by_sha(conn: sqlite3.Connection, sha256: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM documents WHERE sha256=?", (sha256,)).fetchone()


def get_document(conn: sqlite3.Connection, document_id: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()


def upsert_document(conn: sqlite3.Connection, raster) -> None:
    """Record a rasterized PDF and its page masters (ingest.rasterize.RasterResult).

    Idempotent. Extraction-derived page fields (page_type, paper, ...) are left untouched; the
    loader owns those.
    """
    from ingest.assets import register

    existing = document_by_sha(conn, raster.sha256)
    if existing is not None and existing["id"] != raster.document_id:
        raise ValueError("this PDF is already ingested as document %r; use --document-id %s"
                         % (existing["id"], existing["id"]))
    other = get_document(conn, raster.document_id)
    if other is not None and other["sha256"] != raster.sha256:
        raise ValueError("document id %r already belongs to a different PDF (%s); pick another "
                         "--document-id" % (raster.document_id, other["source_pdf"]))
    conn.execute("BEGIN")
    try:
        conn.execute(
            "INSERT INTO documents (id, source_pdf, sha256, page_count, ingested_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET source_pdf=excluded.source_pdf, page_count=excluded.page_count",
            (raster.document_id, raster.source_pdf, raster.sha256, raster.page_count, utcnow()))
        for m in raster.masters:
            register(conn, m.asset, "page")
            x0, y0, x1, y1 = m.placement
            conn.execute(
                "INSERT INTO pages (document_id, page_index, asset_sha256, source, img_x0, img_y0, img_x1, img_y1) "
                "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(document_id, page_index) DO UPDATE SET "
                "asset_sha256=excluded.asset_sha256, source=excluded.source, img_x0=excluded.img_x0, "
                "img_y0=excluded.img_y0, img_x1=excluded.img_x1, img_y1=excluded.img_y1",
                (raster.document_id, m.page_index, m.asset.sha256, m.source, x0, y0, x1, y1))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
