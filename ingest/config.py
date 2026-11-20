"""Paths and defaults for the ingestion engine.

Everything lives under one data directory (default: <repo>/data). Set INGEST_DATA_DIR to point
the whole engine somewhere else (tests do this).
"""
from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
TAXONOMY_PATH = REPO_ROOT / "taxonomy" / "o_level_chemistry_6092.json"

MASTER_DPI = 300   # fallback render resolution for pages that are not a single scan image
VIEW_DPI = 150     # page images handed to extractors


@dataclass(frozen=True)
class Config:
    data_dir: Path
    db_path: Path

    @classmethod
    def from_env(cls, db_path: Optional[Path] = None) -> "Config":
        data_dir = Path(os.environ.get("INGEST_DATA_DIR") or (REPO_ROOT / "data"))
        return cls(data_dir=data_dir, db_path=Path(db_path) if db_path else data_dir / "db" / "questions.sqlite")

    @property
    def assets_dir(self) -> Path:
        return self.data_dir / "assets"

    @property
    def reports_dir(self) -> Path:
        return self.data_dir / "db" / "reports"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    def extracted_dir(self, document_id: str) -> Path:
        return self.data_dir / "extracted" / document_id

    def work_dir(self, document_id: str) -> Path:
        return self.data_dir / "work" / document_id


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "document"


def display_path(path: Path) -> str:
    """Repo-relative path when possible (stable across machines), else absolute."""
    path = Path(path).resolve()
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)
