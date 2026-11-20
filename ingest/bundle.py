"""Build a self-contained handoff bundle for the platform team.

    <out>/<name>/
        HANDOFF.md        how to consume it (copied from docs/HANDOFF.md)
        manifest.json     counts, versions, checksums
        export.json       denormalized question trees; asset paths relative to ./assets
        questions.sqlite  consistent snapshot of the DB (incl. FTS5 index)
        assets/<sha[:2]>/<sha>.<ext>
    <out>/<name>.zip

Every bundle is a full snapshot, so consumers upsert by id. See docs/HANDOFF.md.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import subprocess
import zipfile
from pathlib import Path
from typing import Optional

from ingest import db as dbm
from ingest.config import REPO_ROOT, Config
from ingest.export import EXPORT_VERSION, export_documents


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _git_commit() -> Optional[str]:
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT,
                             capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or None
    except Exception:
        return None


def build_bundle(cfg: Config, out_dir: Path, name: str, make_zip: bool = True,
                 replace: bool = False) -> Path:
    root = out_dir / name
    if root.exists():
        if not replace:
            raise FileExistsError("%s already exists; pass --force to replace it" % root)
        if not (root / "manifest.json").exists():
            raise FileExistsError("%s exists but is not a bundle; refusing to replace it" % root)
        shutil.rmtree(root)
    (root / "assets").mkdir(parents=True)

    conn = dbm.connect(cfg.db_path)
    doc_ids = [r[0] for r in conn.execute("SELECT id FROM documents ORDER BY id")]
    if not doc_ids:
        raise RuntimeError("database has no documents")

    # 1. DB snapshot via the backup API (consistent even if someone else has it open).
    snap = sqlite3.connect(str(root / "questions.sqlite"))
    conn.backup(snap)
    snap.close()

    # 2. Export with paths relative to the bundle's assets/ folder.
    data = export_documents(conn, doc_ids, "assets")
    (root / "export.json").write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")

    # 3. Every asset the DB knows (page scans + crops). Unreferenced ones should have been gc'd.
    n_assets, n_bytes, missing = 0, 0, []
    for (rel,) in conn.execute("SELECT path FROM assets ORDER BY path"):
        src = cfg.assets_dir / rel
        if not src.exists():
            missing.append(rel)
            continue
        dst = root / "assets" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        n_assets += 1
        n_bytes += src.stat().st_size
    if missing:
        raise RuntimeError("%d asset file(s) missing from the store, e.g. %s" % (len(missing), missing[0]))

    # 4. Guide + manifest.
    shutil.copy2(REPO_ROOT / "docs" / "HANDOFF.md", root / "HANDOFF.md")
    counts = {
        "documents": len(doc_ids),
        "top_level_questions": len(data["questions"]),
        "question_nodes": conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0],
        "answers": conn.execute("SELECT COUNT(*) FROM answers").fetchone()[0],
        "needs_review_nodes": conn.execute(
            "SELECT COUNT(*) FROM questions WHERE review_status = 'needs_review'").fetchone()[0],
        "assets": n_assets,
        "asset_bytes": n_bytes,
    }
    manifest = {
        "bundle": name,
        "created_at": data["exported_at"],
        "export_version": EXPORT_VERSION,
        "engine_commit": _git_commit(),
        "documents": doc_ids,
        "counts": counts,
        "sha256": {f: _sha256(root / f) for f in ("export.json", "questions.sqlite")},
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")

    if make_zip:
        zpath = out_dir / (name + ".zip")
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(root.rglob("*")):
                if p.is_file():
                    z.write(p, Path(name) / p.relative_to(root))
    return root
