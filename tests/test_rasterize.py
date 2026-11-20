from __future__ import annotations

import io
from pathlib import Path

import fitz
import numpy as np
import pytest
from PIL import Image

from conftest import DOC_ID
from ingest.assets import LocalAssetStore
from ingest.rasterize import rasterize

SAMPLE = Path(__file__).resolve().parents[1] / "papers" / "Sec4_PureChemistry_2025_SA2_montfort.pdf"


def _asset_files(cfg):
    return sorted(p for p in cfg.assets_dir.rglob("*") if p.is_file())


def test_embedded_scan_is_kept_lossless(cfg, synth_pdf):
    pdf, scan = synth_pdf
    store = LocalAssetStore(cfg.assets_dir)
    r = rasterize(pdf, DOC_ID, cfg, store)
    m0, m1 = r.masters
    assert m0.source.startswith("embedded:")
    assert (m0.asset.width, m0.asset.height) == scan.size
    stored = Image.open(store.local_path(m0.asset.path))
    assert stored.format == "PNG" and stored.mode == "1"          # bilevel stays 1-bit
    assert np.array_equal(np.asarray(stored.convert("L")), np.asarray(scan.convert("L")))  # pixel-exact
    assert m0.placement == pytest.approx((0, 0, 1, 1), abs=1e-3)
    # vector page: rendered at 300 dpi
    assert m1.source == "rendered" and m1.asset.width == pytest.approx(2480, abs=2)
    # views for extractors: ~150 dpi RGB PNG, one per page
    assert [v.page_index for v in r.doc_input.pages] == [0, 1]
    v = Image.open(r.doc_input.pages[0].path)
    assert v.mode == "RGB" and v.width == pytest.approx(1240, abs=2)
    assert r.doc_input.source_sha256 == r.sha256


def test_rasterize_is_idempotent(cfg, synth_pdf):
    store = LocalAssetStore(cfg.assets_dir)
    a = rasterize(synth_pdf[0], DOC_ID, cfg, store)
    files_a = _asset_files(cfg)
    b = rasterize(synth_pdf[0], DOC_ID, cfg, store)
    assert b.reused and _asset_files(cfg) == files_a
    c = rasterize(synth_pdf[0], DOC_ID, cfg, store, force=True)   # recomputed from scratch: same hashes
    assert [m.asset.sha256 for m in a.masters] == [m.asset.sha256 for m in b.masters] == \
           [m.asset.sha256 for m in c.masters]
    assert _asset_files(cfg) == files_a


def test_upsert_document_does_not_duplicate(rasterized):
    conn, raster = rasterized
    from ingest import db as dbm
    dbm.upsert_document(conn, raster)
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM pages").fetchone()[0] == 2
    raster.document_id = "another-name"   # same PDF under a different id is refused
    with pytest.raises(ValueError, match="already ingested"):
        dbm.upsert_document(conn, raster)


def test_jpeg_scan_bytes_are_kept_verbatim(cfg, tmp_path):
    im = Image.fromarray((np.random.RandomState(0).rand(300, 200, 3) * 255).astype("uint8"))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=80)
    doc = fitz.open()
    page = doc.new_page(width=200, height=300)
    page.insert_image(page.rect, stream=buf.getvalue())
    pdf = tmp_path / "jpeg.pdf"
    doc.save(str(pdf))
    r = rasterize(pdf, "jpeg-doc", cfg, LocalAssetStore(cfg.assets_dir))
    m = r.masters[0]
    assert m.source == "embedded:DCTDecode" and m.asset.path.endswith(".jpg")
    assert LocalAssetStore(cfg.assets_dir).get(m.asset.path) == buf.getvalue()


@pytest.mark.skipif(not SAMPLE.exists(), reason="sample paper not present")
def test_sample_ccitt_page_is_lossless(cfg, tmp_path):
    # one page of the real paper: CCITT G4 bilevel scan -> 1-bit PNG with identical pixels
    src = fitz.open(str(SAMPLE))
    one = fitz.open()
    one.insert_pdf(src, from_page=0, to_page=0)
    pdf = tmp_path / "sample_p0.pdf"
    one.save(str(pdf))
    xref = one[0].get_images()[0][0]
    pix = fitz.Pixmap(one, xref)
    expected = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    r = rasterize(pdf, "sample", cfg, LocalAssetStore(cfg.assets_dir))
    m = r.masters[0]
    assert m.source == "embedded:CCITTFaxDecode"
    got = np.asarray(Image.open(LocalAssetStore(cfg.assets_dir).local_path(m.asset.path)).convert("L"))
    assert np.array_equal(got, expected)
