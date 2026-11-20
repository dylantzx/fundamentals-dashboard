"""Score an extraction against a hand-made gold set.

Both directories hold contract chunk files (docs/EXTRACTION_CONTRACT.md) for the same document.
Chunks are merged per directory first, so gold and prediction may be chunked differently.
Questions and answers are matched by (paper, label); pages by page_index.

    result = evaluate(Path("data/gold/<doc>"), Path("data/extracted/<doc>"))
    print(format_report(result))

Metrics are reported per paper and for the whole document ("ALL"). The overall verdict checks
every scope against thresholds (DEFAULT_THRESHOLDS, overridable). A metric with nothing to
measure (for example MCQ accuracy on a paper without MCQs) is None and is not checked.
"""
from __future__ import annotations

import difflib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

Key = Tuple[Optional[str], str]

ALL = "ALL"

DEFAULT_THRESHOLDS: Dict[str, float] = {
    "leaf_label_f1": 0.95,
    "label_f1": 0.93,
    "type_accuracy": 0.95,
    "marks_accuracy": 0.95,
    "mcq_option_exact": 0.90,
    "mcq_answer_accuracy": 0.98,
    "answer_coverage": 0.95,
    "answer_text_similarity": 0.85,
    "stem_similarity": 0.90,
    "topic_top_agreement": 0.70,
    "figure_count_agreement": 0.80,
    "figure_iou_mean": 0.50,
    "page_type_accuracy": 0.95,
    "answer_space_accuracy": 0.90,
    # Choice groups decide which questions count towards the paper total; any miss matters.
    "choice_group_agreement": 1.0,
}
# Reported but never checked: flags are judgement calls, and over-flagging is safe.
REPORT_ONLY = ("review_flag_recall", "review_flag_type_recall")

WORST_N = 10


# =============================================================================================
# Loading
# =============================================================================================

def load_chunks(directory: Path) -> Dict[str, Any]:
    """Merge every *.json chunk in a directory. Later duplicates are reported, not kept."""
    directory = Path(directory)
    files = sorted(f for f in directory.glob("*.json") if not f.name.startswith("."))
    merged: Dict[str, Any] = {"pages": {}, "papers": {}, "questions": {}, "answers": {},
                              "files": [f.name for f in files], "duplicates": []}
    for f in files:
        with open(f, encoding="utf-8") as fh:
            ch = json.load(fh)
        if not isinstance(ch, dict) or "questions" not in ch and "pages" not in ch:
            continue
        for p in ch.get("pages") or []:
            _put(merged, "pages", p.get("page_index"), p, f.name)
        for p in ch.get("papers") or []:
            _put(merged, "papers", p.get("paper"), p, f.name)
        for q in ch.get("questions") or []:
            _put(merged, "questions", (q.get("paper"), q.get("label")), q, f.name)
        for a in ch.get("answers") or []:
            _put(merged, "answers", (a.get("paper"), a.get("label")), a, f.name)
    return merged


def _put(merged: Dict[str, Any], kind: str, key: Any, item: Dict[str, Any], fname: str) -> None:
    if key in merged[kind]:
        merged["duplicates"].append(f"{kind} {_fmt_key(key)} again in {fname}")
        return
    merged[kind][key] = item


# =============================================================================================
# Text and geometry helpers
# =============================================================================================

_DASHES = str.maketrans({"−": "-", "–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"'})


def norm_exact(text: Any) -> str:
    """For exact matches: NFC, unified dashes/quotes, collapsed whitespace."""
    s = unicodedata.normalize("NFC", str(text or "")).translate(_DASHES)
    return re.sub(r"\s+", " ", s).strip()


def norm_similar(text: Any) -> str:
    """For similarity: NFKC as well, so H₂O ~ H2O and full-width forms fold."""
    return norm_exact(unicodedata.normalize("NFKC", str(text or "")))


def similarity(a: Any, b: Any) -> float:
    x, y = norm_similar(a), norm_similar(b)
    if not x and not y:
        return 1.0
    return difflib.SequenceMatcher(None, x, y, autojunk=False).ratio()


def iou(a: List[float], b: List[float]) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0)
    area = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / area if area > 0 else 0.0


def _prf(gold: Set[Any], pred: Set[Any]) -> Dict[str, Optional[float]]:
    if not gold and not pred:
        return {"precision": None, "recall": None, "f1": None}
    tp = len(gold & pred)
    p = tp / len(pred) if pred else 0.0
    r = tp / len(gold) if gold else 0.0
    return {"precision": p, "recall": r, "f1": 2 * p * r / (p + r) if p + r else 0.0}


def _rate(hits: int, total: int) -> Optional[float]:
    return hits / total if total else None


def _mean(xs: List[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def _parent(q: Dict[str, Any]) -> Optional[str]:
    par = q.get("parent_label")
    if par:
        return par
    lab = q.get("label") or ""
    i = lab.rfind("(")
    return lab[:i] if i > 0 else None


def _leaves(qs: Dict[Key, Dict[str, Any]]) -> Set[Key]:
    parents = {(k[0], _parent(q)) for k, q in qs.items() if _parent(q)}
    return {k for k in qs if k not in parents}


def _top_topic(code: str) -> str:
    return code.split(".")[0]


def _fmt_key(key: Any) -> str:
    if isinstance(key, tuple):
        return f"{key[0] or '-'} {key[1]}"
    return str(key)


def _label_order(key: Key) -> Tuple:
    paper, label = key
    m = re.match(r"(\d+)(.*)", label or "")
    return (paper or "", int(m.group(1)) if m else 10**6, m.group(2) if m else label or "")


# =============================================================================================
# Metrics
# =============================================================================================

def _scope_metrics(gold: Dict[str, Any], pred: Dict[str, Any], paper: Optional[str]) -> Dict[str, Any]:
    def sel(d: Dict[Key, Any]) -> Dict[Key, Any]:
        return {k: v for k, v in d.items() if paper == ALL or k[0] == paper}

    gq, pq = sel(gold["questions"]), sel(pred["questions"])
    ga, pa = sel(gold["answers"]), sel(pred["answers"])
    m: Dict[str, Any] = {"n_gold_questions": len(gq), "n_pred_questions": len(pq),
                         "n_gold_answers": len(ga), "n_pred_answers": len(pa)}

    gl, pl = set(gq), set(pq)
    labels = _prf(gl, pl)
    m["label_precision"], m["label_recall"], m["label_f1"] = labels["precision"], labels["recall"], labels["f1"]
    gleaf, pleaf = _leaves(gq), _leaves(pq)
    leaves = _prf(gleaf, pleaf)
    m["leaf_label_precision"], m["leaf_label_recall"], m["leaf_label_f1"] = (
        leaves["precision"], leaves["recall"], leaves["f1"])
    m["missing_labels"] = [_fmt_key(k) for k in sorted(gl - pl, key=_label_order)]
    m["extra_labels"] = [_fmt_key(k) for k in sorted(pl - gl, key=_label_order)]

    matched = sorted(gl & pl, key=_label_order)
    m["type_accuracy"] = _rate(sum(gq[k].get("type") == pq[k].get("type") for k in matched), len(matched))
    type_mismatches = [f"{_fmt_key(k)}: {gq[k].get('type')} vs {pq[k].get('type')}"
                       for k in matched if gq[k].get("type") != pq[k].get("type")]

    matched_leaves = [k for k in matched if k in gleaf]
    marks_bad = [k for k in matched_leaves if gq[k].get("marks") != pq[k].get("marks")]
    m["marks_accuracy"] = _rate(len(matched_leaves) - len(marks_bad), len(matched_leaves))
    m["marks_mismatches"] = [f"{_fmt_key(k)}: {gq[k].get('marks')} vs {pq[k].get('marks')}" for k in marks_bad]
    m["type_mismatches"] = type_mismatches

    # answer_space (v1.1): every node; compared where the gold sets it.
    spaced = [k for k in matched if gq[k].get("answer_space")]
    space_bad = [k for k in spaced if gq[k].get("answer_space") != pq[k].get("answer_space")]
    m["answer_space_accuracy"] = _rate(len(spaced) - len(space_bad), len(spaced))
    m["answer_space_mismatches"] = [f"{_fmt_key(k)}: {gq[k].get('answer_space')} vs {pq[k].get('answer_space')}"
                                    for k in space_bad]

    # choice_group (v1.1): matched top-level questions that either side puts in a group.
    grouped = [k for k in matched if _parent(gq[k]) is None
               and (gq[k].get("choice_group") or pq[k].get("choice_group"))]
    group_bad = [k for k in grouped if gq[k].get("choice_group") != pq[k].get("choice_group")]
    m["choice_group_agreement"] = _rate(len(grouped) - len(group_bad), len(grouped))
    m["choice_group_mismatches"] = [f"{_fmt_key(k)}: {gq[k].get('choice_group')} vs {pq[k].get('choice_group')}"
                                    for k in group_bad]

    # MCQ options: exact text per gold option.
    opt_total = opt_hits = 0
    opt_bad: List[str] = []
    for k in matched:
        if gq[k].get("type") != "mcq":
            continue
        popts = {o.get("label"): norm_exact(o.get("text")) for o in pq[k].get("options") or []}
        for o in gq[k].get("options") or []:
            opt_total += 1
            if popts.get(o.get("label")) == norm_exact(o.get("text")):
                opt_hits += 1
            else:
                opt_bad.append(f"{_fmt_key(k)}{o.get('label')}")
    m["mcq_option_exact"] = _rate(opt_hits, opt_total)
    m["mcq_option_mismatches"] = opt_bad

    # Stems.
    stem_scores = [(similarity(gq[k].get("stem"), pq[k].get("stem")), k) for k in matched]
    m["stem_similarity"] = _mean([s for s, _ in stem_scores])
    m["worst_stems"] = [
        {"key": _fmt_key(k), "similarity": round(s, 3),
         "gold": norm_exact(gq[k].get("stem"))[:160], "pred": norm_exact(pq[k].get("stem"))[:160]}
        for s, k in sorted(stem_scores, key=lambda x: (x[0], _label_order(x[1])))[:WORST_N] if s < 1.0
    ]

    # Topics on matched leaves that the gold tags.
    top_hits = top_total = 0
    jacc: List[float] = []
    for k in matched_leaves:
        gt = [t for t in gq[k].get("topics") or []]
        if not gt:
            continue
        pt = [t for t in pq[k].get("topics") or []]
        top_total += 1
        top_hits += bool(pt) and _top_topic(pt[0]) == _top_topic(gt[0])
        union = set(gt) | set(pt)
        jacc.append(len(set(gt) & set(pt)) / len(union))
    m["topic_top_agreement"] = _rate(top_hits, top_total)
    m["topic_jaccard"] = _mean(jacc)

    # Figures: counts per matched node, then geometry over the whole scope.
    m["figure_count_agreement"] = _rate(
        sum(len(gq[k].get("figures") or []) == len(pq[k].get("figures") or []) for k in matched), len(matched))
    gfigs = [f for q in gq.values() for f in q.get("figures") or []]
    pfigs = [f for q in pq.values() for f in q.get("figures") or []]
    m["n_gold_figures"], m["n_pred_figures"] = len(gfigs), len(pfigs)
    ious = _match_figures(gfigs, pfigs)
    m["figure_iou_mean"] = _mean(ious)
    m["figure_recall_iou50"] = _rate(sum(x >= 0.5 for x in ious), len(gfigs))

    # Answers.
    gak, pak = set(ga), set(pa)
    m["answer_coverage"] = _rate(len(gak & pak), len(gak))
    m["missing_answers"] = [_fmt_key(k) for k in sorted(gak - pak, key=_label_order)]
    m["extra_answers"] = [_fmt_key(k) for k in sorted(pak - gak, key=_label_order)]
    mcq_keys = [k for k in sorted(gak, key=_label_order) if ga[k].get("correct_option")]
    mcq_bad = [k for k in mcq_keys if (pa.get(k) or {}).get("correct_option") != ga[k]["correct_option"]]
    m["mcq_answer_accuracy"] = _rate(len(mcq_keys) - len(mcq_bad), len(mcq_keys))
    m["mcq_answer_mismatches"] = [
        f"{_fmt_key(k)}: gold {ga[k]['correct_option']} pred {(pa.get(k) or {}).get('correct_option') or 'missing'}"
        for k in mcq_bad]
    text_scores = [(similarity(ga[k].get("answer_text"), pa[k].get("answer_text")), k)
                   for k in sorted(gak & pak, key=_label_order) if ga[k].get("answer_text")]
    m["answer_text_similarity"] = _mean([s for s, _ in text_scores])
    m["worst_answers"] = [{"key": _fmt_key(k), "similarity": round(s, 3)}
                          for s, k in sorted(text_scores, key=lambda x: x[0])[:WORST_N] if s < 1.0]

    # review_flags (v1.1): of the gold items a reviewer must see, how many does the prediction
    # also send to review (any flag, or confidence "low": both make it needs_review)?
    flagged = [("question", k, gq[k], pq.get(k)) for k in sorted(gq, key=_label_order) if gq[k].get("review_flags")]
    flagged += [("answer", k, ga[k], pa.get(k)) for k in sorted(ga, key=_label_order) if ga[k].get("review_flags")]
    caught = [x for x in flagged if x[3] and (x[3].get("review_flags") or x[3].get("confidence") == "low")]
    same = [x for x in flagged if x[3] and set(x[2]["review_flags"]) & set(x[3].get("review_flags") or [])]
    m["n_gold_flagged"] = len(flagged)
    m["review_flag_recall"] = _rate(len(caught), len(flagged))
    m["review_flag_type_recall"] = _rate(len(same), len(flagged))
    m["review_flag_missed"] = [f"{kind} {_fmt_key(k)}: gold {','.join(g['review_flags'])}, pred "
                               + ((",".join(p.get("review_flags") or []) or "not flagged") if p else "missing")
                               for kind, k, g, p in flagged if (kind, k, g, p) not in caught]
    return m


def _choice_group_mismatches(gold: Dict[str, Any], pred: Dict[str, Any]) -> List[str]:
    """papers[].choice_groups compared as sets of (id, choose), per gold paper record."""
    out = []
    for paper, g in sorted(gold["papers"].items(), key=lambda x: str(x[0])):
        gs = {(c.get("id"), c.get("choose")) for c in g.get("choice_groups") or []}
        p = pred["papers"].get(paper)
        ps = {(c.get("id"), c.get("choose")) for c in (p or {}).get("choice_groups") or []}
        if gs != ps:
            fmt = lambda x: ", ".join(f"{i} choose {n}" for i, n in sorted(x, key=str)) or "none"
            out.append(f"{paper}: gold {fmt(gs)} vs pred {fmt(ps) if p else 'no paper record'}")
    return out


def _match_figures(gold: List[Dict[str, Any]], pred: List[Dict[str, Any]]) -> List[float]:
    """Greedy one-to-one match, within each page, by descending IoU. Returns matched IoUs."""
    out: List[float] = []
    pages = {f.get("page_index") for f in gold}
    for page in pages:
        g = [f for f in gold if f.get("page_index") == page and f.get("bbox")]
        p = [f for f in pred if f.get("page_index") == page and f.get("bbox")]
        pairs = sorted(((iou(a["bbox"], b["bbox"]), i, j) for i, a in enumerate(g) for j, b in enumerate(p)),
                       reverse=True)
        used_g: Set[int] = set()
        used_p: Set[int] = set()
        for v, i, j in pairs:
            if v <= 0 or i in used_g or j in used_p:
                continue
            used_g.add(i)
            used_p.add(j)
            out.append(v)
    return out


def _page_metrics(gold: Dict[str, Any], pred: Dict[str, Any]) -> Dict[str, Any]:
    gp, pp = gold["pages"], pred["pages"]
    bad = []
    for idx in sorted(k for k in gp if k is not None):
        got = (pp.get(idx) or {}).get("page_type")
        if got != gp[idx].get("page_type"):
            bad.append(f"page {idx}: {gp[idx].get('page_type')} vs {got or 'missing'}")
    n = len([k for k in gp if k is not None])
    return {"page_type_accuracy": _rate(n - len(bad), n), "page_type_mismatches": bad,
            "n_gold_pages": n, "n_pred_pages": len(pp)}


# =============================================================================================
# Public API
# =============================================================================================

def evaluate(gold_dir: Path, pred_dir: Path, thresholds: Optional[Dict[str, float]] = None) -> dict:
    """Compare predicted chunks with gold chunks for one document. Returns a JSON-able dict."""
    gold, pred = load_chunks(Path(gold_dir)), load_chunks(Path(pred_dir))
    th = dict(DEFAULT_THRESHOLDS)
    th.update(thresholds or {})

    papers = sorted({k[0] for k in list(gold["questions"]) + list(gold["answers"])}, key=lambda p: (p is None, p or ""))
    scopes: Dict[str, Dict[str, Any]] = {ALL: _scope_metrics(gold, pred, ALL)}
    for p in papers:
        scopes[p or "-"] = _scope_metrics(gold, pred, p)
    pages = _page_metrics(gold, pred)

    checks = []
    for scope, metrics in scopes.items():
        for name, minimum in th.items():
            if name in metrics and metrics[name] is not None and name not in REPORT_ONLY:
                checks.append({"scope": scope, "metric": name, "value": metrics[name],
                               "threshold": minimum, "passed": metrics[name] >= minimum})
    if "page_type_accuracy" in th and pages["page_type_accuracy"] is not None:
        checks.append({"scope": "document", "metric": "page_type_accuracy", "value": pages["page_type_accuracy"],
                       "threshold": th["page_type_accuracy"],
                       "passed": pages["page_type_accuracy"] >= th["page_type_accuracy"]})
    return {
        "gold_dir": str(gold_dir),
        "pred_dir": str(pred_dir),
        "papers": scopes,
        "pages": pages,
        "thresholds": th,
        "checks": checks,
        "passed": all(c["passed"] for c in checks),
        "paper_choice_group_mismatches": _choice_group_mismatches(gold, pred),
        "warnings": [f"gold: {d}" for d in gold["duplicates"]] + [f"pred: {d}" for d in pred["duplicates"]],
    }


_ROWS = [
    ("label_f1", "labels F1 (all nodes)"),
    ("label_precision", "  precision"),
    ("label_recall", "  recall"),
    ("leaf_label_f1", "labels F1 (leaves)"),
    ("leaf_label_precision", "  precision"),
    ("leaf_label_recall", "  recall"),
    ("type_accuracy", "type accuracy"),
    ("marks_accuracy", "marks accuracy (leaves)"),
    ("mcq_option_exact", "MCQ option text exact"),
    ("mcq_answer_accuracy", "MCQ answer accuracy"),
    ("answer_coverage", "answer coverage"),
    ("answer_text_similarity", "answer text similarity"),
    ("stem_similarity", "stem similarity (mean)"),
    ("topic_top_agreement", "topic agreement (top level)"),
    ("topic_jaccard", "topic Jaccard (subtopics)"),
    ("figure_count_agreement", "figure count agreement"),
    ("figure_iou_mean", "figure bbox IoU (matched)"),
    ("figure_recall_iou50", "figures found (IoU >= 0.5)"),
    ("answer_space_accuracy", "answer_space accuracy"),
    ("choice_group_agreement", "choice_group agreement"),
    ("review_flag_recall", "review flags caught (report)"),
    ("review_flag_type_recall", "  same flag type (report)"),
]


def _cell(v: Optional[float], threshold: Optional[float]) -> str:
    if v is None:
        return "-"
    s = f"{v:.3f}"
    return s + ("*" if threshold is not None and v < threshold else " ")


def format_report(result: dict, max_items: int = 12) -> str:
    """Compact table (metrics x scopes), verdict, then the worst offenders."""
    scopes = list(result["papers"])
    th = result["thresholds"]
    width = 30
    out = [f"Extraction eval  gold={result['gold_dir']}  pred={result['pred_dir']}", ""]
    head = f"{'metric':<{width}}" + "".join(f"{s:>10}" for s in scopes) + f"{'min':>8}"
    out += [head, "-" * len(head)]
    counts = [("questions gold/pred", "n_gold_questions", "n_pred_questions"),
              ("answers gold/pred", "n_gold_answers", "n_pred_answers"),
              ("figures gold/pred", "n_gold_figures", "n_pred_figures"),
              ("gold items with review flags", "n_gold_flagged", "n_gold_flagged")]
    for title, a, b in counts:
        out.append(f"{title:<{width}}" + "".join(
            f"{str(result['papers'][s][a]) + ('' if a == b else '/' + str(result['papers'][s][b])):>10}"
            for s in scopes))
    for key, title in _ROWS:
        t = th.get(key)
        out.append(f"{title:<{width}}" + "".join(f"{_cell(result['papers'][s].get(key), t):>10}" for s in scopes)
                   + (f"{t:>8.2f}" if t is not None else f"{'':>8}"))
    pages = result["pages"]
    t = th.get("page_type_accuracy")
    out.append(f"{'page_type accuracy (document)':<{width}}{_cell(pages['page_type_accuracy'], t):>10}"
               + " " * 10 * (len(scopes) - 1) + (f"{t:>8.2f}" if t is not None else ""))
    out.append("")
    failed = [c for c in result["checks"] if not c["passed"]]
    if result["passed"]:
        out.append(f"RESULT: PASS ({len(result['checks'])} checks)")
    else:
        out.append(f"RESULT: FAIL ({len(failed)} of {len(result['checks'])} checks below threshold, marked *)")
        for c in failed:
            out.append(f"  {c['scope']:>8} {c['metric']}: {c['value']:.3f} < {c['threshold']:.2f}")

    allm = result["papers"][ALL]

    def section(title: str, items: List[str]) -> None:
        if not items:
            return
        more = f" (+{len(items) - max_items} more)" if len(items) > max_items else ""
        out.append("")
        out.append(f"{title} [{len(items)}]{more}")
        out.extend(f"  {x}" for x in items[:max_items])

    section("Missing labels", allm["missing_labels"])
    section("Extra labels", allm["extra_labels"])
    section("Type mismatches (gold vs pred)", allm["type_mismatches"])
    section("Marks mismatches (gold vs pred)", allm["marks_mismatches"])
    section("MCQ answer mismatches", allm["mcq_answer_mismatches"])
    section("MCQ option text mismatches", allm["mcq_option_mismatches"])
    section("Missing answers", allm["missing_answers"])
    section("Extra answers", allm["extra_answers"])
    section("Page type mismatches", pages["page_type_mismatches"])
    section("answer_space mismatches (gold vs pred)", allm["answer_space_mismatches"])
    section("choice_group mismatches (gold vs pred)", allm["choice_group_mismatches"])
    section("papers[].choice_groups mismatches", result.get("paper_choice_group_mismatches") or [])
    section("Gold review flags the prediction missed", allm["review_flag_missed"])
    worst = [f"{w['similarity']:.3f}  {w['key']}\n      gold: {w['gold']}\n      pred: {w['pred']}"
             for w in allm["worst_stems"]]
    section(f"Worst stems (lowest {WORST_N})", worst)
    section("Worst answer texts", [f"{w['similarity']:.3f}  {w['key']}" for w in allm["worst_answers"]])
    section("Warnings", result.get("warnings") or [])
    return "\n".join(out)
