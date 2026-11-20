"""Stage 1: PDF -> lossless page masters in the asset store + ~150 dpi views for extractors.

Master image per page:
* If the page is just one upright image covering (almost) the whole page, the embedded image is
  kept losslessly: JPEG/PNG streams are stored byte-for-byte; anything browsers can't show
  (CCITT G4, JBIG2, JPX, raw Flate) is decoded by MuPDF and re-encoded as PNG (1-bit when the
  image is bilevel). `placement` records where that image sits on the page, in normalised page
  coordinates, so contract bboxes (normalised to the *page*) map exactly onto master pixels.
* Otherwise the page is rendered at 300 dpi to PNG (placement = whole page).

Idempotent: assets are content addressed, and the views are skipped when the work-dir manifest
already describes this exact PDF (by sha256).
"""
from __future__ import annotations

import hashlib
import io
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

import fitz  # pymupdf
from PIL import Image

from ingest.assets import AssetRef, AssetStore, put_image
from ingest.config import MASTER_DPI, VIEW_DPI, Config, display_path
from ingest.extract.base import DocumentInput, PageImage

MIN_COVERAGE = 0.95
MANIFEST_VERSION = 1


@dataclass
class PageMaster:
    page_index: int
    asset: AssetRef
    source: str                                   # "embedded:<orig format>" | "rendered"
    placement: Tuple[float, float, float, float]  # image rect on the page, normalised 0..1


@dataclass
class RasterResult:
    document_id: str
    sha256: str
    source_pdf: str
    page_count: int
    masters: List[PageMaster]
    doc_input: DocumentInput
    reused: bool = False                          # True if the manifest was already up to date
    notes: List[str] = field(default_factory=list)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _single_scan_image(doc: fitz.Document, page: fitz.Page) -> Optional[dict]:
    """Return the image info if the page is exactly one upright image covering the page."""
    if page.rotation != 0:
        return None
    infos = page.get_image_info(xrefs=True)
    if len(infos) != 1:
        return None
    info = infos[0]
    a, b, c, d, _, _ = info["transform"]
    if not info.get("xref") or info.get("has-mask") or abs(b) > 1e-6 or abs(c) > 1e-6 or a <= 0 or d <= 0:
        return None
    rect = page.rect
    bbox = fitz.Rect(info["bbox"])
    if abs(bbox & rect) < MIN_COVERAGE * abs(rect):
        return None
    if page.get_text("text").strip() or page.get_drawings():
        return None  # something is drawn on top of the scan: render instead
    return info


def _encode_embedded(doc: fitz.Document, xref: int) -> Tuple[bytes, str, str]:
    """(bytes, ext, pdf_filter). JPEG is kept verbatim; everything else becomes lossless PNG."""
    ftype, fval = doc.xref_get_key(xref, "Filter")
    filt = "raw" if ftype == "null" else (fval.strip("/[] ").replace("/", "+") or "raw")
    if filt == "DCTDecode":
        return doc.extract_image(xref)["image"], "jpg", filt  # keep the original JPEG bytes
    # CCITT / JBIG2 / JPX / Flate: let MuPDF decode, re-encode as lossless PNG.
    pix = fitz.Pixmap(doc, xref)
    if pix.alpha or pix.n not in (1, 3):
        pix = fitz.Pixmap(fitz.csRGB, pix, 0)
    mode = "L" if pix.n == 1 else "RGB"
    im = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
    if mode == "L":
        colors = im.getcolors(256) or []
        if {v for _, v in colors} <= {0, 255}:
            im = im.convert("1")  # bilevel scan: 1-bit PNG, still lossless
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue(), "png", filt


def _render(page: fitz.Page, dpi: int) -> Image.Image:
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def _master_for_page(doc: fitz.Document, page: fitz.Page, store: AssetStore) -> PageMaster:
    info = _single_scan_image(doc, page)
    if info is not None:
        data, ext, orig = _encode_embedded(doc, info["xref"])
        ref = store.put(data, ext)
        r, bb = page.rect, fitz.Rect(info["bbox"])
        placement = (round((bb.x0 - r.x0) / r.width, 6), round((bb.y0 - r.y0) / r.height, 6),
                     round((bb.x1 - r.x0) / r.width, 6), round((bb.y1 - r.y0) / r.height, 6))
        return PageMaster(page.number, ref, "embedded:" + orig, placement)
    ref = put_image(store, _render(page, MASTER_DPI))
    return PageMaster(page.number, ref, "rendered", (0.0, 0.0, 1.0, 1.0))


def view_name(page_index: int) -> str:
    return "p%02d.png" % page_index


def rasterize(pdf_path: Path, document_id: str, cfg: Config, store: AssetStore,
              force: bool = False) -> RasterResult:
    pdf_path = Path(pdf_path)
    sha = file_sha256(pdf_path)
    work = cfg.work_dir(document_id)
    pages_dir = work / "pages"
    manifest_path = work / "manifest.json"

    manifest = None
    if manifest_path.exists() and not force:
        try:
            manifest = json.loads(manifest_path.read_text())
        except ValueError:
            manifest = None
    if manifest and manifest.get("version") == MANIFEST_VERSION and manifest.get("sha256") == sha:
        masters = [PageMaster(m["page_index"], AssetRef(**m["asset"]), m["source"], tuple(m["placement"]))
                   for m in manifest["masters"]]
        views = [PageImage(v["page_index"], pages_dir / v["file"], v["width"], v["height"])
                 for v in manifest["views"]]
        if all(store.local_path(m.asset.path).exists() for m in masters) and all(v.path.exists() for v in views):
            doc_input = DocumentInput(document_id, display_path(pdf_path), sha, views)
            return RasterResult(document_id, sha, display_path(pdf_path), len(masters), masters, doc_input, True)

    pages_dir.mkdir(parents=True, exist_ok=True)
    masters: List[PageMaster] = []
    views: List[PageImage] = []
    with fitz.open(str(pdf_path)) as doc:
        for page in doc:
            masters.append(_master_for_page(doc, page, store))
            view = _render(page, VIEW_DPI)
            path = pages_dir / view_name(page.number)
            view.save(path, format="PNG")
            views.append(PageImage(page.number, path, view.width, view.height))
        page_count = doc.page_count

    manifest = {
        "version": MANIFEST_VERSION, "sha256": sha, "source_pdf": display_path(pdf_path),
        "masters": [{"page_index": m.page_index, "asset": asdict(m.asset), "source": m.source,
                     "placement": list(m.placement)} for m in masters],
        "views": [{"page_index": v.page_index, "file": v.path.name, "width": v.width, "height": v.height}
                  for v in views],
    }
    manifest_path.write_text(json.dumps(manifest, indent=1))
    doc_input = DocumentInput(document_id, display_path(pdf_path), sha, views)
    return RasterResult(document_id, sha, display_path(pdf_path), page_count, masters, doc_input)
