"""Synthetic fixtures: a 2-page "exam paper" PDF and a matching extraction-contract set.

Page 0 is a scan-like page: one full-page 1-bit image (150 dpi) with black bars standing in for
text lines, a boxed "figure", and a few scan specks. Page 1 is vector-drawn (no image), so it
exercises the 300 dpi render path. All positions are normalised page coordinates.
"""
from __future__ import annotations

import copy
import io
import json
import sys
from pathlib import Path

import fitz
import pytest
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.config import Config  # noqa: E402

DOC_ID = "synthetic-test-paper"
SCAN_W, SCAN_H = 1240, 1754            # A4 at 150 dpi
LINE_H = 0.010                         # text line height
LINE_X = (0.08, 0.85)

# page 0 text lines (top y of each bar)
P0_LINES = {
    "mcq": [0.060, 0.080, 0.100, 0.120],
    "q1": [0.200, 0.220],
    "q1a": [0.450, 0.470],
    "q1b": [0.550, 0.570],
    "q1bi": [0.620, 0.640],
    "q1bii": [0.800, 0.820, 0.840],
}
FIGURE = (0.30, 0.26, 0.70, 0.40)      # boxed figure on page 0
SPECKS = [(0.72, 0.42), (0.50, 0.17), (0.40, 0.52)]
# page 1 text lines
P1_LINES = {
    "q1bii": [0.050, 0.070],
    "q1c": [0.150, 0.170],
    "answers": [0.600, 0.620, 0.640, 0.660, 0.680],
}


def _px(x, y):
    return int(round(x * SCAN_W)), int(round(y * SCAN_H))


def make_scan_page() -> Image.Image:
    im = Image.new("1", (SCAN_W, SCAN_H), 1)
    d = ImageDraw.Draw(im)
    for ys in P0_LINES.values():
        for y in ys:
            d.rectangle([_px(LINE_X[0], y), _px(LINE_X[1], y + LINE_H)], fill=0)
    x0, y0, x1, y1 = FIGURE
    d.rectangle([_px(x0, y0), _px(x1, y1)], outline=0, width=3)
    d.line([_px(x0, y0), _px(x1, y1)], fill=0, width=2)
    d.ellipse([_px(0.45, 0.30), _px(0.55, 0.36)], outline=0, width=2)
    for x, y in SPECKS:
        d.point(_px(x, y), fill=0)
    return im


def make_pdf(path: Path) -> Image.Image:
    scan = make_scan_page()
    buf = io.BytesIO()
    scan.save(buf, format="PNG")
    doc = fitz.open()
    page = doc.new_page(width=595.28, height=841.89)
    page.insert_image(page.rect, stream=buf.getvalue())
    page = doc.new_page(width=595.28, height=841.89)
    W, H = page.rect.width, page.rect.height
    for ys in P1_LINES.values():
        for y in ys:
            page.draw_rect(fitz.Rect(LINE_X[0] * W, y * H, LINE_X[1] * W, (y + LINE_H) * H), color=None, fill=(0, 0, 0))
    doc.save(str(path))
    doc.close()
    return scan


def region(page, y0, y1, x0=0.05, x1=0.95):
    return {"page_index": page, "bbox": [x0, y0, x1, y1]}


def make_contract() -> dict:
    """{filename: chunk dict} (contract v1.1). Two chunks so cross-chunk checks are exercised.

    P2 1(c) has confidence "low", so it is needs_review (hidden from default search)."""
    q = lambda **kw: dict({"section": None, "options": [], "figures": [], "topics": [], "has_handwriting": False,
                           "confidence": "high", "review_flags": [], "notes": "", "answer_space": "lines"}, **kw)
    chunk_a = {
        "contract_version": 1, "document_id": DOC_ID, "source_pdf": "synthetic.pdf", "chunk": "a",
        "extracted_by": "human",
        "pages": [{"page_index": 0, "paper": "P1", "printed_page_number": "1", "page_type": "questions",
                   "has_handwriting": False, "notes": ""}],
        "papers": [
            {"paper": "P1", "paper_code": "6092/01", "school": "Test School", "exam": "Prelim 2025", "year": 2025,
             "level": "Sec 4", "subject": "Chemistry", "date": "2025-08-29", "duration_minutes": 60,
             "total_marks": 1, "instructions": ""},
            {"paper": "P2", "paper_code": "6092/02", "school": "Test School", "exam": "Prelim 2025", "year": 2025,
             "level": "Sec 4", "subject": "Chemistry", "date": "2025-08-30", "duration_minutes": 105,
             "total_marks": 6, "instructions": ""},
        ],
        "questions": [
            q(paper="P1", label="1", parent_label=None, type="mcq", marks=1, answer_space="none",
              stem="Which substance is formed when calcium carbonate, CaCO₃, is heated strongly?",
              options=[{"label": "A", "text": "CaO"}, {"label": "B", "text": "H₂O"},
                       {"label": "C", "text": "Ca(OH)₂"}, {"label": "D", "text": "SO₄²⁻"}],
              regions=[region(0, 0.05, 0.135)], full_regions=[region(0, 0.05, 0.135)], topics=["4.1"]),
            q(paper="P2", section="A", label="1", parent_label=None, type="context", marks=None, answer_space="none",
              stem="Fig. 1.1 shows the apparatus used to follow the reaction of marble chips with acid.",
              regions=[region(0, 0.19, 0.41)],
              full_regions=[region(0, 0.19, 0.86), region(1, 0.04, 0.19)],
              figures=[{"id": "fig-1.1", "page_index": 0, "bbox": [0.33, 0.27, 0.69, 0.385], "kind": "apparatus",
                        "caption": "Fig. 1.1", "description": "Conical flask on a balance with a cotton wool plug."}]),
            q(paper="P2", section="A", label="1(a)", parent_label="1", type="structured", marks=1,
              stem="Name the gas produced in this reaction.", regions=[region(0, 0.44, 0.49)], topics=["10.1"]),
            q(paper="P2", section="A", label="1(b)", parent_label="1", type="context", marks=None, answer_space="none",
              stem="The reaction also produces water, H₂O, and calcium chloride.",
              regions=[region(0, 0.553, 0.59)]),          # sloppy: top edge cuts through a text line
            q(paper="P2", section="A", label="1(b)(i)", parent_label="1(b)", type="structured", marks=1,
              stem="Explain why the mass of the flask decreases.", regions=[region(0, 0.61, 0.66)],
              topics=["10.2"]),
            q(paper="P2", section="A", label="1(b)(ii)", parent_label="1(b)", type="structured", marks=2,
              stem="Suggest how the rate changes when powdered marble is used.",
              regions=[region(0, 0.79, 0.86), region(1, 0.04, 0.085)], topics=["10.2", "10.1"]),
        ],
        "answers": [],
    }
    chunk_b = {
        "contract_version": 1, "document_id": DOC_ID, "source_pdf": "synthetic.pdf", "chunk": "b",
        "extracted_by": "human",
        "pages": [{"page_index": 1, "paper": "P2", "printed_page_number": "2", "page_type": "questions",
                   "has_handwriting": True, "notes": ""}],
        "papers": [],
        "questions": [
            q(paper="P2", section="A", label="1(c)", parent_label="1", type="structured", marks=2,
              stem="Calculate the volume of carbon dioxide produced at room conditions.",
              regions=[region(1, 0.14, 0.19)], topics=["4.3"], has_handwriting=True, confidence="low",
              notes="last word unclear"),
        ],
        "answers": [
            {"paper": "P1", "label": "1", "correct_option": "A", "answer_text": None, "marks": 1, "page_index": 1,
             "regions": [region(1, 0.595, 0.615)]},
            {"paper": "P2", "label": "1(a)", "correct_option": None, "answer_text": "carbon dioxide (1)", "marks": 1,
             "page_index": 1, "regions": [region(1, 0.615, 0.635)]},
            {"paper": "P2", "label": "1(b)", "correct_option": None, "page_index": 1, "marks": 3,
             "answer_text": "(i) carbon dioxide escapes (1)\n(ii) faster, larger surface area (1) more collisions (1)",
             "regions": [region(1, 0.635, 0.655)], "notes": "key answers 1(b) as one row"},
            {"paper": "P2", "label": "1(c)(i)", "correct_option": None, "answer_text": "moles of CaCO3 = 0.01 (1)",
             "marks": 1, "page_index": 1, "regions": [region(1, 0.655, 0.675)]},
            {"paper": "P2", "label": "1(c)(ii)", "correct_option": None, "answer_text": "volume = 240 cm³ (1)",
             "marks": 1, "page_index": 1, "regions": [region(1, 0.675, 0.695)]},
        ],
    }
    for ans in chunk_b["answers"]:
        ans.setdefault("confidence", "high")
        ans.setdefault("review_flags", [])
    return {"a.json": chunk_a, "b.json": chunk_b}


def write_contract(dirpath: Path, contract: dict) -> Path:
    dirpath.mkdir(parents=True, exist_ok=True)
    for old in dirpath.glob("*.json"):
        old.unlink()
    for name, data in contract.items():
        (dirpath / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return dirpath


@pytest.fixture(scope="session")
def synth_pdf(tmp_path_factory):
    d = tmp_path_factory.mktemp("pdf")
    path = d / "synthetic_paper.pdf"
    scan = make_pdf(path)
    return path, scan


@pytest.fixture
def contract():
    return copy.deepcopy(make_contract())


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_DATA_DIR", str(tmp_path / "data"))
    return Config.from_env()


@pytest.fixture
def rasterized(cfg, synth_pdf):
    """A DB connection with the synthetic PDF rasterized and registered."""
    from ingest import db as dbm
    from ingest.assets import LocalAssetStore
    from ingest.rasterize import rasterize
    conn = dbm.connect(cfg.db_path)
    raster = rasterize(synth_pdf[0], DOC_ID, cfg, LocalAssetStore(cfg.assets_dir))
    dbm.upsert_document(conn, raster)
    yield conn, raster
    conn.close()


@pytest.fixture
def loaded(cfg, rasterized, contract, tmp_path):
    from ingest.load import load_document
    conn, raster = rasterized
    src = write_contract(tmp_path / "json", contract)
    result = load_document(conn, cfg, DOC_ID, src_dir=src)
    return conn, result, src
