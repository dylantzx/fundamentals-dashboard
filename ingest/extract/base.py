"""Extractor interface: the seam between "reading the scan" and "building the DB".

Every backend turns a rasterized document into contract JSON chunk files
(see docs/EXTRACTION_CONTRACT.md). The loader only ever sees those files.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Protocol


@dataclass
class PageImage:
    page_index: int          # 0-based index in the PDF
    path: Path               # PNG rendered for model viewing (~150 dpi, RGB)
    width: int
    height: int


@dataclass
class DocumentInput:
    document_id: str         # slug, e.g. "montfort-2025-sec4-chem-prelim"
    source_pdf: str          # repo-relative path
    source_sha256: str
    pages: List[PageImage] = field(default_factory=list)


class Extractor(Protocol):
    name: str                # recorded as "extracted_by" in each chunk

    def extract(self, doc: DocumentInput, out_dir: Path) -> List[Path]:
        """Write contract chunk JSON files into out_dir and return their paths.

        Must be safe to re-run: overwrite this extractor's own chunk files.
        """
        ...
