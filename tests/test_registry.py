from __future__ import annotations

import pytest

from ingest.extract.base import DocumentInput
from ingest.extract.registry import get_extractor


def test_files_extractor_copies_chunks(tmp_path):
    src = tmp_path / "gold"
    src.mkdir()
    (src / "p1.json").write_text("{}")
    (src / "notes.txt").write_text("ignored")
    ex = get_extractor("files", source_dir=src)
    out = ex.extract(DocumentInput("d", "x.pdf", "0" * 64), tmp_path / "out")
    assert [p.name for p in out] == ["p1.json"] and (tmp_path / "out" / "p1.json").read_text() == "{}"
    assert ex.extract(DocumentInput("d", "x.pdf", "0" * 64), tmp_path / "out") == out   # re-runnable


def test_registry_errors(tmp_path):
    with pytest.raises(ValueError, match="--from"):
        get_extractor("files")
    with pytest.raises(ValueError, match="unknown extractor"):
        get_extractor("ocr")
    with pytest.raises(FileNotFoundError):
        get_extractor("files", source_dir=tmp_path).extract(DocumentInput("d", "x.pdf", ""), tmp_path / "o")
