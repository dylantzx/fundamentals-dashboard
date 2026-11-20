from __future__ import annotations

import itertools

import numpy as np
import pytest

from conftest import FIGURE, LINE_H, P0_LINES, make_scan_page
from ingest.crop import PageRaster, make_crop, snap_region, trim_figure


@pytest.fixture(scope="module")
def page():
    im = make_scan_page()
    return PageRaster(im, np.asarray(im.convert("L")) < 128, (0.0, 0.0, 1.0, 1.0))


def _blank_edges(crop) -> bool:
    ink = np.asarray(crop.image.convert("L")) < 128
    return not ink[0].any() and not ink[-1].any()


def test_sloppy_top_edge_snaps_to_whitespace_above_cut_line(page):
    # top edge 0.553 cuts through the text line at 0.55..0.56: expand to the gap above it
    c = make_crop(page, 0, [0.05, 0.553, 0.95, 0.59], "region")
    assert c.status == "ok"
    x0, y0, x1, y1 = c.bbox_snapped
    assert 0.48 < y0 < 0.55                       # whole line included, previous line (0.47) excluded
    assert 0.58 < y1 < 0.62                       # tightened into the gap after the last line
    assert (x0, x1) == pytest.approx((0.05, 0.95), abs=1e-3)   # column width kept
    assert _blank_edges(c)


def test_bottom_edge_cutting_line_never_slices_text(page):
    c = make_crop(page, 0, [0.05, 0.44, 0.95, 0.474], "region")  # bottom cuts line 0.47..0.48
    assert c.status == "ok" and _blank_edges(c)
    y1 = c.bbox_snapped[3]
    assert y1 >= 0.48 or y1 <= 0.47


def test_generous_box_is_tightened_without_losing_ink(page):
    raw = [0.05, 0.43, 0.95, 0.50]                # lots of whitespace around 1(a)
    c = make_crop(page, 0, raw, "region")
    y0, y1 = c.bbox_snapped[1], c.bbox_snapped[3]
    assert raw[1] < y0 < P0_LINES["q1a"][0] and P0_LINES["q1a"][-1] + LINE_H < y1 < raw[3]


def test_figure_is_grown_then_trimmed_to_ink_ignoring_specks(page):
    # model box cuts the left/top/bottom of the figure; a speck sits just right of it
    box, status, detail = trim_figure(page, [0.33, 0.27, 0.69, 0.385])
    assert status == "ok" and "grew at" in detail
    x0, y0, x1, y1 = page.to_norm(box)
    fx0, fy0, fx1, fy1 = FIGURE
    assert fx0 - 0.012 < x0 <= fx0 and fy0 - 0.012 < y0 <= fy0       # nothing of the figure cut off
    assert fx1 <= x1 < fx1 + 0.012 and fy1 <= y1 < fy1 + 0.012       # speck at x=0.72 ignored


def test_empty_figure_box_is_reported(page):
    c = make_crop(page, 0, [0.86, 0.90, 0.95, 0.95], "figure")
    assert c.status == "empty"


def test_degenerate_box_fails_cleanly(page):
    c = make_crop(page, 0, [0.5, 0.5, 0.5, 0.5], "region")
    assert c.status == "failed" and c.image is None


def test_placement_maps_page_coordinates_onto_image(page):
    # image covering only the top 99.9% of the page (as in the sample PDF)
    p2 = PageRaster(page.image, page.ink, (0.0, 0.0, 1.0, 0.999))
    box = p2.to_px([0, 0.5, 1, 0.999])
    assert box[3] == page.size[1] and box[1] == round(0.5 / 0.999 * page.size[1])
    assert p2.to_norm(box)[1] == pytest.approx(0.5, abs=1e-3)


def test_figure_ignores_text_only_reached_by_padding(page):
    # the stem line at y 0.22..0.23 is inside the padded search window but not in the box
    box, status, _ = trim_figure(page, [0.29, 0.245, 0.71, 0.41])
    assert status == "ok"
    assert page.to_norm(box)[1] > P0_LINES["q1"][-1] + LINE_H


# ---------------------------------------------------------------- ruled answer tables

TABLE_RULES = [0.20, 0.23, 0.26, 0.29, 0.32]     # row k spans TABLE_RULES[k]..TABLE_RULES[k+1]
SKEW = 0.004                                     # rules drop this much across the table (~0.5 deg)


@pytest.fixture(scope="module")
def ruled_page():
    """A mark-scheme style table: every row is bounded by rules and crossed by vertical cell
    borders, so no pixel row inside the table is blank (no whitespace between rows)."""
    from PIL import Image, ImageDraw
    W, H = 1240, 1754
    im = Image.new("1", (W, H), 1)
    d = ImageDraw.Draw(im)
    x0, x1 = int(0.10 * W), int(0.90 * W)
    for y in TABLE_RULES:
        d.line([(x0, int(y * H)), (x1, int((y + SKEW) * H))], fill=0, width=3)
    for x in (0.10, 0.22, 0.80, 0.90):
        d.line([(int(x * W), int(TABLE_RULES[0] * H)), (int(x * W), int((TABLE_RULES[-1] + SKEW) * H))], fill=0, width=3)
    for k in range(len(TABLE_RULES) - 1):
        top, bottom = TABLE_RULES[k], TABLE_RULES[k + 1]
        d.rectangle([int(0.25 * W), int((top + 0.009) * H), int(0.70 * W), int((bottom - 0.007) * H)], fill=0)
    return PageRaster(im, np.asarray(im.convert("L")) < 128, (0.0, 0.0, 1.0, 1.0))


def _row_box(k, overshoot):
    return [0.08, TABLE_RULES[k] - overshoot, 0.92, TABLE_RULES[k + 1] + overshoot]


def test_ruled_rows_snap_to_their_own_rules(ruled_page):
    from ingest.crop import crop_answer_rows
    boxes = [_row_box(k, 0.007) for k in range(4)]          # neighbours overlap by 0.014
    crops = crop_answer_rows(ruled_page, 0, boxes)
    H = ruled_page.size[1]
    for k, c in enumerate(crops):
        assert c.status == "ok" and "rules" in c.detail, (k, c.status, c.detail)
        y0, y1 = c.bbox_snapped[1], c.bbox_snapped[3]
        assert abs(y0 - (TABLE_RULES[k] + SKEW / 2)) < 0.004 and abs(y1 - (TABLE_RULES[k + 1] + SKEW / 2)) < 0.004
        # its own text bar is inside; the neighbouring rows' text bars are not
        assert y0 < TABLE_RULES[k] + 0.009 and TABLE_RULES[k + 1] - 0.007 < y1
        if k > 0:
            assert y0 > TABLE_RULES[k] - 0.007
        if k < 3:
            assert y1 < TABLE_RULES[k + 1] + 0.009
    assert len({tuple(c.bbox_snapped) for c in crops}) == 4


def test_ruled_table_has_no_whitespace_rows(ruled_page):
    # why answer rows need rule snapping: the whitespace snapper has nothing to snap to here
    from ingest.crop import whitespace_bands
    x0, x1 = int(0.08 * 1240), int(0.92 * 1240)
    H = ruled_page.size[1]
    inside = [b for b in whitespace_bands(ruled_page.ink, x0, x1) if TABLE_RULES[0] * H < b[0] < TABLE_RULES[-1] * H]
    assert inside == []


def test_bad_snaps_fall_back_to_clamped_raw_box(ruled_page, monkeypatch):
    import ingest.crop as crop
    H = ruled_page.size[1]
    # rules that would truncate the answer (keep well under 80% of its height)
    monkeypatch.setattr(crop, "horizontal_rules", lambda ink, x0, x1: [(int(0.200 * H), int(0.202 * H)),
                                                                        (int(0.214 * H), int(0.216 * H))])
    c = crop.crop_answer_rows(ruled_page, 0, [[0.08, 0.195, 0.92, 0.230]])[0]
    assert c.status == "fallback" and "80%" in c.detail
    assert c.bbox_snapped[1] == pytest.approx(0.195, abs=1e-3) and c.bbox_snapped[3] == pytest.approx(0.230, abs=1e-3)
    # two answers that snap onto the same row would share a crop: both fall back
    rules = [(int(0.199 * H), int(0.201 * H)), (int(0.259 * H), int(0.261 * H))]
    calls = itertools.cycle(rules)                     # every answer: top -> rule 0, bottom -> rule 1
    monkeypatch.setattr(crop, "_nearest_rule", lambda y, r, search: next(calls))
    crops = crop.crop_answer_rows(ruled_page, 0, [[0.08, 0.196, 0.92, 0.250], [0.08, 0.210, 0.92, 0.262]])
    assert [c.status for c in crops] == ["fallback", "fallback"]
    assert crops[0].bbox_snapped[3] <= crops[1].bbox_snapped[1] + 0.001   # clamped at the midpoint


def test_grid_columns_are_not_neighbours(ruled_page):
    from ingest.crop import crop_answer_rows
    # side-by-side cells of an MCQ key grid on the same row must not clamp each other
    crops = crop_answer_rows(ruled_page, 0, [[0.08, 0.193, 0.52, 0.237], [0.50, 0.193, 0.92, 0.237]])
    assert all(c.status == "ok" for c in crops)
