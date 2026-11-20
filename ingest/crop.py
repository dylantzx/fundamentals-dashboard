"""Stage 3: turn approximate (model) bboxes into clean crops of the lossless page master.

* Question/answer regions: keep the given column (x range, widened only if a side edge cuts ink);
  move the top and bottom edges to the nearest horizontal whitespace band within +-3% of the page
  height, so a crop never slices a line of text in half. Edges are then tightened to the ink
  inside the band (small margin).
* Figures: look a little beyond the box, keep the ink connected to what is inside it (completes a
  figure the model box clipped), ignore scan specks, and trim to the bounding box of that ink.

Bboxes are normalised to the *page*; `PageRaster.placement` maps them onto master pixels.
All thresholds scale with the image height, so any scan resolution works.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image

Box = Tuple[int, int, int, int]
NormBox = Tuple[float, float, float, float]

INK_THRESHOLD = 128        # gray < threshold is ink
SNAP_SEARCH = 0.03         # fraction of page height searched for whitespace above/below an edge
SNAP_SIDE = 0.02           # fraction of page width a side edge may move out to avoid cutting ink
EDGE_MARGIN = 0.004        # whitespace kept around ink (fraction of page height)
FIGURE_PAD = 0.02          # how far beyond a figure box we look for ink connected to the figure
CONTRACT_PENALTY = 1.5     # prefer expanding a box over shrinking it (contract boxes are generous)
FIGURE_MIN_INSIDE = 0.25   # a blob the box only grazes (e.g. a stem line it cuts) needs this share
                           # of its ink inside the model's box to be kept
RULE_SEARCH = 0.02         # how far (page height) a table-row edge may move to reach a ruled line
MIN_KEEP = 0.8             # a snapped answer box must keep this share of its (clamped) raw height,
OVERSHOOT = 0.005          # not counting the generous overshoot the contract asks for on each edge


@dataclass
class PageRaster:
    image: Image.Image                 # master in its own mode (1, L or RGB): crops keep it
    ink: np.ndarray                    # bool HxW
    placement: NormBox                 # master image rect on the page (normalised)

    @property
    def size(self) -> Tuple[int, int]:
        return self.image.size

    def to_px(self, bbox: Sequence[float]) -> Box:
        W, H = self.size
        px0, py0, px1, py1 = self.placement
        fx = lambda v: (v - px0) / (px1 - px0) * W
        fy = lambda v: (v - py0) / (py1 - py0) * H
        x0, x1 = sorted((fx(bbox[0]), fx(bbox[2])))
        y0, y1 = sorted((fy(bbox[1]), fy(bbox[3])))
        return _clamp((int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))), W, H)

    def to_norm(self, box: Box) -> List[float]:
        W, H = self.size
        px0, py0, px1, py1 = self.placement
        return [round(px0 + box[0] / W * (px1 - px0), 4), round(py0 + box[1] / H * (py1 - py0), 4),
                round(px0 + box[2] / W * (px1 - px0), 4), round(py0 + box[3] / H * (py1 - py0), 4)]


@dataclass
class Crop:
    page_index: int
    bbox_raw: List[float]
    bbox_snapped: Optional[List[float]]
    image: Optional[Image.Image]
    status: str                        # ok | unsnapped | empty | failed
    detail: str = ""


def load_page(path: Path, placement: Sequence[float]) -> PageRaster:
    im = Image.open(path)
    im.load()
    gray = np.asarray(im.convert("L"))
    return PageRaster(im, gray < INK_THRESHOLD, tuple(placement))


def _clamp(box: Box, W: int, H: int) -> Box:
    x0, y0, x1, y1 = box
    return (max(0, min(W, x0)), max(0, min(H, y0)), max(0, min(W, x1)), max(0, min(H, y1)))


# ---------------------------------------------------------------- row profile / whitespace bands

def _runs(mask: np.ndarray) -> List[Tuple[int, int]]:
    """[start, end) runs of True values."""
    if mask.size == 0:
        return []
    m = np.concatenate(([False], mask, [False])).astype(np.int8)
    d = np.diff(m)
    return list(zip(np.where(d == 1)[0].tolist(), np.where(d == -1)[0].tolist()))


def blank_rows(ink: np.ndarray, x0: int, x1: int) -> np.ndarray:
    """Bool per row: True if the row (within columns x0..x1) has no real ink.

    Rows with a handful of ink pixels count as blank (scan noise), and very short ink runs with
    little ink are treated as specks (but a thin table rule spanning the column is kept as ink).
    """
    width = max(1, x1 - x0)
    counts = ink[:, x0:x1].sum(axis=1)
    blank = counts <= max(2, int(0.003 * width))
    speck = max(2, int(round(ink.shape[0] * 0.0008)))
    for a, b in _runs(~blank):
        if b - a <= speck and 0 < a and b < len(blank) and counts[a:b].max() < 0.02 * width:
            blank[a:b] = True
    return blank


def whitespace_bands(ink: np.ndarray, x0: int, x1: int, min_rows: int = 3) -> List[Tuple[int, int]]:
    return [(a, b) for a, b in _runs(blank_rows(ink, x0, x1)) if b - a >= min_rows]


def strip_vertical_lines(mask: np.ndarray, min_len: int) -> np.ndarray:
    """Remove ink belonging to vertical runs >= min_len pixels (table borders, column rules).

    A slightly skewed rule still forms long vertical runs in each pixel column it crosses.
    """
    return mask & ~long_runs(mask, min_len)


def long_runs(mask: np.ndarray, min_len: int) -> np.ndarray:
    """Pixels that belong to a vertical run of ink at least min_len long (use mask.T for rows)."""
    h, w = mask.shape
    if h < min_len or w == 0:
        return np.zeros_like(mask)
    c = np.zeros((h + 1, w), dtype=np.int32)
    np.cumsum(mask, axis=0, out=c[1:])
    full = (c[min_len:] - c[:-min_len]) == min_len          # window [s, s+min_len) is all ink
    f = np.zeros((full.shape[0] + 1, w), dtype=np.int32)
    np.cumsum(full, axis=0, out=f[1:])
    ys = np.arange(h)
    hi = np.minimum(ys, h - min_len) + 1
    lo = np.maximum(ys - min_len + 1, 0)
    return (f[hi] - f[lo]) > 0                              # pixel lies in some all-ink window


def horizontal_rules(ink: np.ndarray, x0: int, x1: int) -> List[Tuple[int, int]]:
    """[start, end) row bands of ruled horizontal lines (table borders) within columns x0..x1.

    A row belongs to a rule when long horizontal ink runs cover >= 5% of the column. A scan skew
    of ~0.5 degrees spreads a 4 px rule over ~25 rows, each holding a long segment of it; small
    breaks inside one rule are merged.
    """
    width = x1 - x0
    if width < 20:
        return []
    covered = long_runs(ink[:, x0:x1].T, max(8, int(0.06 * width))).T
    rows = covered.sum(axis=1) >= 0.05 * width
    gap = max(2, int(0.003 * ink.shape[0]))
    bands: List[List[int]] = []
    for a, b in _runs(rows):
        if bands and a - bands[-1][1] <= gap:
            bands[-1][1] = b
        else:
            bands.append([a, b])
    return [(a, b) for a, b in bands]


def _snap_edge(y: int, bands: List[Tuple[int, int]], search: int, margin: int, side: str,
               expand_only: bool = False) -> Optional[int]:
    best, best_score = None, None
    for a, b in bands:
        if a <= y <= b:
            best = (a, b)
            break
        if b < y:
            dist, expanding = y - b, side == "top"
        else:
            dist, expanding = a - y, side == "bottom"
        if dist > search or (expand_only and not expanding):
            continue
        score = (dist if expanding else dist * CONTRACT_PENALTY, not expanding)  # ties: expand
        if best_score is None or score < best_score:
            best, best_score = (a, b), score
    if best is None:
        return None
    a, b = best
    # Tighten inside the band: keep a small margin next to the ink on the inner side.
    return max(a, b - margin) if side == "top" else min(b, a + margin)


def _widen_to_whitespace(ink: np.ndarray, x0: int, x1: int, y0: int, y1: int, limit: int) -> Tuple[int, int]:
    """If a side edge cuts through ink (e.g. a question number), move it out to a blank column."""
    blank = ink[y0:y1].sum(axis=0) <= 1
    W = ink.shape[1]
    nx0, nx1 = x0, x1
    while nx0 > 0 and x0 - nx0 < limit and not blank[nx0]:
        nx0 -= 1
    while nx1 < W and nx1 - x1 < limit and not blank[nx1 - 1]:
        nx1 += 1
    nx0 = nx0 if blank[nx0] or nx0 == 0 else x0     # no whitespace within reach: keep the edge
    nx1 = nx1 if nx1 == W or blank[nx1 - 1] else x1
    return nx0, nx1


def _snap_both(ink: np.ndarray, x0: int, x1: int, y0: int, y1: int, search: int, margin: int):
    bands = whitespace_bands(ink, x0, x1)
    top, bottom = _snap_edge(y0, bands, search, margin, "top"), _snap_edge(y1, bands, search, margin, "bottom")
    if top is not None and bottom is not None and bottom - top < 2:
        # Tight box (e.g. one table row): edges snapped past each other, so only grow outwards.
        top = _snap_edge(y0, bands, search, margin, "top", expand_only=True)
        bottom = _snap_edge(y1, bands, search, margin, "bottom", expand_only=True)
    return top, bottom


def snap_region(page: PageRaster, bbox: Sequence[float]) -> Tuple[Box, str, str]:
    """Snap a question/answer region's top and bottom edges to whitespace."""
    W, H = page.size
    x0, y0, x1, y1 = page.to_px(bbox)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return (x0, y0, x1, y1), "failed", "bbox is degenerate"
    search, margin = int(SNAP_SEARCH * H), max(1, int(EDGE_MARGIN * H))
    ny0, ny1 = _snap_both(page.ink, x0, x1, y0, y1, search, margin)
    if ny0 is None or ny1 is None:
        # Inside a ruled table every row has ink from the vertical cell borders: ignore those.
        col = strip_vertical_lines(page.ink[:, x0:x1], max(8, int(0.02 * H)))
        ry0, ry1 = _snap_both(col, 0, x1 - x0, y0, y1, search, margin)
        ny0, ny1 = (ny0 if ny0 is not None else ry0), (ny1 if ny1 is not None else ry1)
    missing = [n for n, v in (("top", ny0), ("bottom", ny1)) if v is None]
    ny0 = y0 if ny0 is None else ny0
    ny1 = y1 if ny1 is None else ny1
    if ny1 - ny0 < 2:
        return (x0, y0, x1, y1), "unsnapped", "snapped edges crossed; kept raw box"
    x0, x1 = _widen_to_whitespace(page.ink, x0, x1, ny0, ny1, int(SNAP_SIDE * W))
    box = (x0, ny0, x1, ny1)
    if not page.ink[ny0:ny1, x0:x1].any():
        return box, "empty", "region contains no ink"
    if missing:
        return box, "unsnapped", "no whitespace within search window at %s edge" % "/".join(missing)
    return box, "ok", ""


# ---------------------------------------------------------------- figure trimming

def figure_ink(mask: np.ndarray, min_pixels: int, roi: Box, block: int = 6) -> np.ndarray:
    """Ink of `mask` that belongs to the figure.

    Blobs are 8-connected at `block` px granularity. A blob is dropped if it has fewer than
    `min_pixels` ink pixels (scan specks) or if less than FIGURE_MIN_INSIDE of its ink lies inside
    `roi` (the model's box, in mask coordinates) and its inside part spans < half the box: such
    ink was only reached by padding or is a word the box edge grazes, e.g. the stem line above a
    figure. A figure the box clipped is still completed (most of its ink, or a long stretch of
    it, is inside).
    """
    h, w = mask.shape
    if h == 0 or w == 0:
        return mask
    gh, gw = -(-h // block), -(-w // block)
    padded = np.zeros((gh * block, gw * block), dtype=bool)
    padded[:h, :w] = mask
    counts = padded.reshape(gh, block, gw, block).sum(axis=(1, 3))
    occupied = counts > 0
    rx0, ry0, rx1, ry1 = roi
    inside = np.zeros_like(padded)
    inside[ry0:ry1, rx0:rx1] = padded[ry0:ry1, rx0:rx1]
    counts_in = inside.reshape(gh, block, gw, block).sum(axis=(1, 3))
    keep = np.zeros_like(occupied)
    seen = np.zeros_like(occupied)
    for start in zip(*np.nonzero(occupied)):
        if seen[start]:
            continue
        comp, total, total_in, span = [start], 0, 0, [gh, gw, -1, -1]
        seen[start] = True
        queue = deque([start])
        while queue:
            r, c = queue.popleft()
            total += int(counts[r, c])
            total_in += int(counts_in[r, c])
            if counts_in[r, c]:
                span = [min(span[0], r), min(span[1], c), max(span[2], r), max(span[3], c)]
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    rr, cc = r + dr, c + dc
                    if 0 <= rr < gh and 0 <= cc < gw and occupied[rr, cc] and not seen[rr, cc]:
                        seen[rr, cc] = True
                        comp.append((rr, cc))
                        queue.append((rr, cc))
        # span of the blob's inside part, as a share of the box: a figure the box cuts on every
        # side (e.g. a frame) still spans the box, a grazed word does not
        spans_box = total_in and max((span[2] - span[0] + 1) * block / max(1, ry1 - ry0),
                                     (span[3] - span[1] + 1) * block / max(1, rx1 - rx0)) >= 0.5
        if total >= min_pixels and (total_in >= FIGURE_MIN_INSIDE * total or spans_box):
            for cell in comp:
                keep[cell] = True
    full = np.repeat(np.repeat(keep, block, axis=0), block, axis=1)[:h, :w]
    return mask & full


def trim_figure(page: PageRaster, bbox: Sequence[float]) -> Tuple[Box, str, str]:
    """Look a little beyond the model's box, keep every ink blob that touches the box (so a
    figure the box clipped is completed), drop specks and blobs only reached by the padding
    (e.g. the stem line above), then trim to that ink plus a small margin."""
    W, H = page.size
    box = page.to_px(bbox)
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        return box, "failed", "bbox is degenerate"
    pad = int(FIGURE_PAD * H)
    bx0, by0, bx1, by1 = _clamp((box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad), W, H)
    roi = (box[0] - bx0, box[1] - by0, box[2] - bx0, box[3] - by0)
    clean = figure_ink(page.ink[by0:by1, bx0:bx1], max(4, int((0.0015 * H) ** 2)), roi)
    if not clean.any():
        return box, "empty", "no ink found in figure box"
    ys, xs = np.nonzero(clean.any(axis=1))[0], np.nonzero(clean.any(axis=0))[0]
    m = max(1, int(EDGE_MARGIN * H))
    out = _clamp((bx0 + int(xs[0]) - m, by0 + int(ys[0]) - m, bx0 + int(xs[-1]) + 1 + m,
                  by0 + int(ys[-1]) + 1 + m), W, H)
    grown = [side for side, d in (("top", box[1] - out[1]), ("bottom", out[3] - box[3]),
                                  ("left", box[0] - out[0]), ("right", out[2] - box[2])) if d > m]
    return out, "ok", ("box clipped the figure; grew at " + "/".join(grown)) if grown else ""


# ---------------------------------------------------------------- answer-key rows

def _nearest_rule(y: int, rules: List[Tuple[int, int]], search: int) -> Optional[Tuple[int, int]]:
    best = min(rules, key=lambda r: abs((r[0] + r[1]) / 2 - y), default=None)
    return best if best is not None and abs((best[0] + best[1]) / 2 - y) <= search else None


def _same_column(a: Box, b: Box) -> bool:
    return min(a[2], b[2]) - max(a[0], b[0]) >= 0.5 * min(a[2] - a[0], b[2] - b[0])


def _iou_y(a: Box, b: Box) -> float:
    inter = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = max(a[3], b[3]) - min(a[1], b[1])
    return inter / union if union else 0.0


def crop_answer_rows(page: PageRaster, page_index: int, bboxes: List[Sequence[float]]) -> List[Crop]:
    """Crop every answer region on one page together (mark schemes are ruled tables, and the
    model's row boxes overlap their neighbours).

    1. Clamp each box to the midpoints between it and the vertically adjacent answer boxes in the
       same column, so a box can never extend into a neighbour's row.
    2. Snap top/bottom to the centre of the ruled lines nearest the clamped edges; without
       rules, snap to whitespace as for questions, then re-clamp.
    3. Reject a snap that keeps < MIN_KEEP of the clamped raw height (less the expected overshoot)
       or that duplicates another
       answer's crop: use the clamped raw box instead (status "fallback").
    """
    W, H = page.size
    raws = [page.to_px(b) for b in bboxes]
    lo = [0] * len(raws)
    hi = [H] * len(raws)
    order = sorted(range(len(raws)), key=lambda i: (raws[i][1] + raws[i][3]) / 2)
    for n, i in enumerate(order):
        for j in order[n + 1:]:
            a, b = raws[i], raws[j]
            if not _same_column(a, b):
                continue                          # different column of the key (e.g. MCQ grid)
            mid = (a[3] + b[1]) // 2
            hi[i], lo[j] = min(hi[i], mid), max(lo[j], mid)
            break                                 # only the next box down in this column
    tol, search = max(1, int(0.006 * H)), int(RULE_SEARCH * H)
    results = []
    for i, raw in enumerate(raws):
        x0, _, x1, _ = raw
        cy0, cy1 = max(raw[1], lo[i]), min(raw[3], hi[i])
        if cy1 - cy0 < 2:
            cy0, cy1 = raw[1], raw[3]
        clamped = (x0, cy0, x1, cy1)
        box, status, detail = None, "ok", ""
        rules = horizontal_rules(page.ink, x0, x1)
        top, bottom = _nearest_rule(cy0, rules, search), _nearest_rule(cy1, rules, search)
        if top and bottom and top != bottom and top[0] < bottom[1]:
            # rule centres: a skewed rule spans ~25 rows, and its outer edge would take in the
            # neighbouring rows' text at one end of the line
            box, detail = (x0, (top[0] + top[1]) // 2, x1, (bottom[0] + bottom[1] + 1) // 2), "snapped to table rules"
        else:
            sb, status, detail = snap_region(page, [page.to_norm(clamped)[k] for k in range(4)])
            if status != "failed":
                box = sb
        snapped = box
        if box is not None:
            box = (box[0], max(box[1], lo[i] - tol), box[2], min(box[3], hi[i] + tol))
            kept = max(0, min(box[3], cy1) - max(box[1], cy0))
            # the contract asks for ~0.005 overshoot per edge; trimming that is not a loss
            expected = max(1, (cy1 - cy0) - 2 * int(OVERSHOOT * H))
            if box[3] - box[1] < 2 or kept < MIN_KEEP * expected:
                box, detail = None, "snap kept < %d%% of the raw height" % (MIN_KEEP * 100)
        results.append([box, status, detail, clamped, snapped])
    # two answers snapping to the same row (before the neighbour clamp hides it) is a collapse
    dup = {i for i, r in enumerate(results) for j, o in enumerate(results)
           if i != j and r[4] is not None and o[4] is not None and _iou_y(r[4], o[4]) > 0.9
           and _same_column(r[4], o[4])}
    for i in dup:
        results[i][0], results[i][2] = None, "snap duplicated another answer's crop"
    crops = []
    for (box, status, detail, clamped, _), bbox in zip(results, bboxes):
        raw = [round(float(v), 4) for v in bbox]
        if box is None:
            box, status = clamped, "fallback"
        if box[2] - box[0] < 2 or box[3] - box[1] < 2:
            crops.append(Crop(page_index, raw, None, None, "failed", "bbox is degenerate"))
            continue
        crops.append(Crop(page_index, raw, page.to_norm(box), page.image.crop(box), status, detail))
    return crops


# ---------------------------------------------------------------- public helpers

def make_crop(page: PageRaster, page_index: int, bbox: Sequence[float], kind: str) -> Crop:
    """kind: 'region' (question/answer area) or 'figure'."""
    raw = [round(float(v), 4) for v in bbox]
    try:
        box, status, detail = (trim_figure if kind == "figure" else snap_region)(page, bbox)
        if status == "failed":
            return Crop(page_index, raw, None, None, status, detail)
        return Crop(page_index, raw, page.to_norm(box), page.image.crop(box), status, detail)
    except Exception as e:  # a bad box must not abort a whole document load
        return Crop(page_index, raw, None, None, "failed", "%s: %s" % (type(e).__name__, e))
