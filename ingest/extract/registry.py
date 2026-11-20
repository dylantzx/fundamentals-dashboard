"""Extractor registry: name -> backend instance. Backends are imported lazily so optional
dependencies (e.g. the anthropic SDK) are only needed when that backend is used."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from ingest.extract.base import Extractor

EXTRACTORS = ("claude", "files")


def get_extractor(name: str, **opts) -> Extractor:
    if name == "files":
        from ingest.extract.files import FilesExtractor
        source_dir: Optional[Path] = opts.get("source_dir")
        if not source_dir:
            raise ValueError("the files extractor needs a source directory (--from DIR)")
        return FilesExtractor(Path(source_dir))
    if name == "claude":
        try:
            from ingest.extract.claude import ClaudeExtractor
        except ImportError as e:
            raise RuntimeError("claude extractor unavailable (%s)" % e) from e
        kwargs = {"model": opts.get("model")}
        if opts.get("cache_dir"):
            kwargs["cache_dir"] = Path(opts["cache_dir"])
        return ClaudeExtractor(**kwargs)
    raise ValueError("unknown extractor %r (choose from %s)" % (name, ", ".join(EXTRACTORS)))
