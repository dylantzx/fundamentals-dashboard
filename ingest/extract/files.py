"""`files` extractor: copy precomputed contract JSON (a gold set, hand-corrected JSON) into place."""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import List

from ingest.extract.base import DocumentInput


class FilesExtractor:
    name = "files"

    def __init__(self, source_dir: Path):
        self.source_dir = Path(source_dir)

    def extract(self, doc: DocumentInput, out_dir: Path) -> List[Path]:
        files = sorted(self.source_dir.glob("*.json"))
        if not files:
            raise FileNotFoundError("no *.json chunk files in %s" % self.source_dir)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        written = []
        for f in files:
            dest = out_dir / f.name
            if f.resolve() != dest.resolve():
                shutil.copyfile(f, dest)
            written.append(dest)
        return written
