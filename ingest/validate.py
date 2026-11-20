"""Hand-rolled validator for extraction-contract chunks (docs/EXTRACTION_CONTRACT.md).

Errors block a load; warnings are reported. Every message names the file and the item
(e.g. "p2_a.json: question P2 2(b)(ii): bbox y0 >= y1").
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

CONTRACT_VERSION = 1    # v1.1 added optional fields only; the version number is still 1
PAGE_TYPES = {"cover", "questions", "answer_key", "data_sheet", "blank", "other"}
QUESTION_TYPES = {"mcq", "structured", "context"}
CONFIDENCE = {"high", "medium", "low"}
ANSWER_SPACE = {"lines", "drawing", "table", "graph", "working", "none"}
REVIEW_FLAGS = {"source_defect", "illegible", "inferred", "answer_mismatch"}
FIGURE_KINDS = {"diagram", "graph", "table", "structure", "photo", "apparatus"}
BBOX_TOLERANCE = 0.02   # values slightly outside 0..1 are clamped with a warning

_ROMAN = r"(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})"
LABEL_RE = re.compile(r"^[1-9]\d{0,2}(?:\((?:[a-z]|%s)\)(?:\(%s\))?)?$" % (_ROMAN, _ROMAN))
_ROMAN_RE = re.compile("^%s$" % _ROMAN)
PAPER_RE = re.compile(r"^P[1-9]$")


@dataclass
class Issue:
    level: str          # error | warning
    file: str
    where: str
    message: str

    def __str__(self) -> str:
        loc = "%s: %s" % (self.file, self.where) if self.where else self.file
        return "%s %s: %s" % (self.level.upper(), loc, self.message)

    def as_dict(self) -> dict:
        return {"level": self.level, "file": self.file, "where": self.where, "message": self.message}


def is_canonical_label(label: object) -> bool:
    return isinstance(label, str) and bool(LABEL_RE.match(label))


def suggest_label(label: str) -> Optional[str]:
    """Best-effort canonical form for a sloppy label: '3ai' -> '3(a)(i)', '5 (B)' -> '5(b)'."""
    m = re.match(r"^\s*(?:Q\.?\s*)?([1-9]\d{0,2})\s*(.*)$", str(label), re.I)
    if not m:
        return None
    num, rest = m.group(1), re.sub(r"[\s().\[\]]", "", m.group(2).lower())
    if not rest:
        cand = num
    elif _ROMAN_RE.match(rest):
        cand = "%s(%s)" % (num, rest)
    elif rest[0].isalpha() and (len(rest) == 1 or _ROMAN_RE.match(rest[1:])):
        cand = "%s(%s)" % (num, rest[0]) + ("(%s)" % rest[1:] if len(rest) > 1 else "")
    else:
        return None
    return cand if LABEL_RE.match(cand) else None


def parent_of(label: str) -> Optional[str]:
    i = label.rfind("(")
    return label[:i] if i > 0 else None


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class _Ctx:
    def __init__(self, document_id: Optional[str], page_count: Optional[int], topic_codes: Set[str]):
        self.document_id = document_id
        self.page_count = page_count
        self.topic_codes = topic_codes
        self.issues: List[Issue] = []
        self.file = ""
        self.pages: Dict[int, str] = {}
        self.papers: Dict[str, str] = {}
        self.questions: Dict[Tuple[str, str], Tuple[str, dict]] = {}
        self.answers: Dict[Tuple[str, str], str] = {}
        self.choice_groups: Dict[Tuple[str, str], int] = {}   # (paper, group id) -> choose

    def err(self, where: str, msg: str) -> None:
        self.issues.append(Issue("error", self.file, where, msg))

    def warn(self, where: str, msg: str) -> None:
        self.issues.append(Issue("warning", self.file, where, msg))


def _check_page_index(ctx: _Ctx, where: str, v, field: str = "page_index") -> bool:
    if not _is_int(v):
        ctx.err(where, "%s must be an integer, got %r" % (field, v))
        return False
    if v < 0 or (ctx.page_count is not None and v >= ctx.page_count):
        ctx.err(where, "%s %d out of range (document has %s pages, 0-based)" % (field, v, ctx.page_count))
        return False
    return True


def _check_bbox(ctx: _Ctx, where: str, bbox) -> None:
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4 or not all(_is_num(v) for v in bbox):
        ctx.err(where, "bbox must be [x0, y0, x1, y1] numbers, got %r" % (bbox,))
        return
    x0, y0, x1, y1 = bbox
    if any(v < -BBOX_TOLERANCE or v > 1 + BBOX_TOLERANCE for v in bbox):
        ctx.err(where, "bbox %r outside 0..1 (coordinates are normalised to the page)" % (list(bbox),))
        return
    if any(v < 0 or v > 1 for v in bbox):
        ctx.warn(where, "bbox %r slightly outside 0..1; will be clamped" % (list(bbox),))
    if x0 >= x1 or y0 >= y1:
        ctx.err(where, "bbox %r must have x0 < x1 and y0 < y1" % (list(bbox),))


def _check_regions(ctx: _Ctx, where: str, regions, field: str) -> None:
    if not isinstance(regions, list):
        ctx.err(where, "%s must be a list" % field)
        return
    for i, r in enumerate(regions):
        w = "%s %s[%d]" % (where, field, i)
        if not isinstance(r, dict):
            ctx.err(w, "region must be an object {page_index, bbox}")
            continue
        _check_page_index(ctx, w, r.get("page_index"))
        _check_bbox(ctx, w, r.get("bbox"))


def _check_label(ctx: _Ctx, where: str, label) -> bool:
    if is_canonical_label(label):
        return True
    hint = suggest_label(label) if isinstance(label, str) else None
    ctx.err(where, "label %r is not canonical (e.g. \"7\", \"2(a)\", \"2(a)(ii)\")%s"
            % (label, "; did you mean %r?" % hint if hint else ""))
    return False


def _check_page(ctx: _Ctx, p) -> None:
    if not isinstance(p, dict):
        ctx.err("pages[]", "page record must be an object")
        return
    pi = p.get("page_index")
    where = "page %s" % pi
    if _check_page_index(ctx, where, pi):
        if pi in ctx.pages:
            ctx.err(where, "page record duplicated (also in %s)" % ctx.pages[pi])
        ctx.pages[pi] = ctx.file
    if p.get("page_type") not in PAGE_TYPES:
        ctx.err(where, "page_type %r not one of %s" % (p.get("page_type"), sorted(PAGE_TYPES)))
    if p.get("paper") is not None and not (isinstance(p.get("paper"), str) and PAPER_RE.match(p["paper"])):
        ctx.err(where, "paper must be \"P1\", \"P2\", ... or null, got %r" % p.get("paper"))
    if not isinstance(p.get("has_handwriting", False), bool):
        ctx.warn(where, "has_handwriting should be true/false")


def _check_paper(ctx: _Ctx, p) -> None:
    if not isinstance(p, dict):
        ctx.err("papers[]", "paper record must be an object")
        return
    code = p.get("paper")
    where = "paper %s" % code
    if not (isinstance(code, str) and PAPER_RE.match(code)):
        ctx.err(where, "paper must be \"P1\", \"P2\", ...")
        return
    if code in ctx.papers:
        ctx.err(where, "paper record duplicated (also in %s)" % ctx.papers[code])
    ctx.papers[code] = ctx.file
    for f in ("year", "duration_minutes", "total_marks"):
        if p.get(f) is not None and not _is_int(p[f]):
            ctx.err(where, "%s must be an integer or null, got %r" % (f, p[f]))
    if p.get("date") is not None and not (isinstance(p["date"], str) and re.match(r"^\d{4}-\d{2}-\d{2}$", p["date"])):
        ctx.warn(where, "date %r is not YYYY-MM-DD" % p.get("date"))
    groups = p.get("choice_groups") or []
    if not isinstance(groups, list):
        ctx.err(where, "choice_groups must be a list")
        groups = []
    for g in groups:
        if not (isinstance(g, dict) and isinstance(g.get("id"), str) and g["id"]
                and _is_int(g.get("choose")) and g["choose"] >= 1):
            ctx.err(where, "choice group %r must be {\"id\": \"B\", \"choose\": 1, \"note\": ...}" % (g,))
            continue
        if (code, g["id"]) in ctx.choice_groups:
            ctx.err(where, "choice group %s duplicated" % g["id"])
        ctx.choice_groups[(code, g["id"])] = g["choose"]


def _check_question(ctx: _Ctx, q) -> None:
    if not isinstance(q, dict):
        ctx.err("questions[]", "question must be an object")
        return
    paper, label = q.get("paper"), q.get("label")
    where = "question %s %s" % (paper, label)
    if not (isinstance(paper, str) and PAPER_RE.match(paper)):
        ctx.err(where, "paper must be \"P1\", \"P2\", ...")
    label_ok = _check_label(ctx, where, label)
    key = (paper, label)
    if key in ctx.questions:
        ctx.err(where, "question duplicated (also in %s)" % ctx.questions[key][0])
    else:
        ctx.questions[key] = (ctx.file, q)
    if label_ok:
        expected = parent_of(label)
        if q.get("parent_label") != expected:
            ctx.err(where, "parent_label is %r but label %s implies %r"
                    % (q.get("parent_label"), label, expected))
    qtype = q.get("type")
    if qtype not in QUESTION_TYPES:
        ctx.err(where, "type %r not one of %s" % (qtype, sorted(QUESTION_TYPES)))
    if not isinstance(q.get("stem"), str):
        ctx.err(where, "stem must be a string")
    elif not q["stem"].strip() and qtype != "context":
        ctx.warn(where, "stem is empty")

    options = q.get("options", [])
    if not isinstance(options, list):
        ctx.err(where, "options must be a list")
    elif qtype == "mcq":
        if len(options) < 2:
            ctx.err(where, "mcq needs options (A to D), got %d" % len(options))
        seen = set()
        for o in options:
            if not (isinstance(o, dict) and isinstance(o.get("label"), str) and re.match(r"^[A-Z]$", o["label"])
                    and isinstance(o.get("text"), str)):
                ctx.err(where, "option %r must be {\"label\": \"A\", \"text\": \"...\"}" % (o,))
                continue
            if o["label"] in seen:
                ctx.err(where, "option %s duplicated" % o["label"])
            seen.add(o["label"])
    elif options:
        ctx.warn(where, "options given on a %s question (ignored for search display only)" % qtype)

    marks = q.get("marks")
    if marks is not None and not (_is_int(marks) and marks >= 0):
        ctx.err(where, "marks must be a non-negative integer or null, got %r" % (marks,))
    elif qtype == "mcq" and marks not in (1, None):
        ctx.warn(where, "mcq marks is %r, expected 1" % marks)
    elif qtype == "context" and marks is not None:
        ctx.warn(where, "context node has marks %r (expected null)" % marks)

    regions = q.get("regions")
    if regions is None or regions == []:
        ctx.warn(where, "no regions: no question crop can be made")
    else:
        _check_regions(ctx, where, regions, "regions")
    if "full_regions" in q and q["full_regions"] is not None:
        if q.get("parent_label") is not None:
            ctx.warn(where, "full_regions is only used on top-level questions")
        _check_regions(ctx, where, q["full_regions"], "full_regions")

    figures = q.get("figures", [])
    if not isinstance(figures, list):
        ctx.err(where, "figures must be a list")
        figures = []
    for i, f in enumerate(figures):
        w = "%s figures[%d]" % (where, i)
        if not isinstance(f, dict):
            ctx.err(w, "figure must be an object")
            continue
        w = "%s figure %s" % (where, f.get("id", i))
        _check_page_index(ctx, w, f.get("page_index"))
        _check_bbox(ctx, w, f.get("bbox"))
        if f.get("kind") not in FIGURE_KINDS:
            ctx.warn(w, "kind %r not one of %s" % (f.get("kind"), sorted(FIGURE_KINDS)))
        if not (isinstance(f.get("description"), str) and f["description"].strip()):
            ctx.warn(w, "figure has no description (alt text)")

    topics = q.get("topics", [])
    if not isinstance(topics, list):
        ctx.err(where, "topics must be a list of subtopic codes")
    else:
        for t in topics:
            if not isinstance(t, str) or t not in ctx.topic_codes:
                ctx.err(where, "topic %r is not a code in the taxonomy" % (t,))
        if len(topics) > 3:
            ctx.warn(where, "%d topics given; contract allows 1 to 3" % len(topics))
        if len(set(map(str, topics))) != len(topics):
            ctx.warn(where, "duplicate topic codes")
    if q.get("confidence") not in CONFIDENCE:
        ctx.warn(where, "confidence %r not one of %s" % (q.get("confidence"), sorted(CONFIDENCE)))
    if q.get("answer_space") is not None and q.get("answer_space") not in ANSWER_SPACE:
        ctx.warn(where, "answer_space %r not one of %s" % (q.get("answer_space"), sorted(ANSWER_SPACE)))
    if not isinstance(q.get("has_handwriting", False), bool):
        ctx.warn(where, "has_handwriting should be true/false")
    _check_review_flags(ctx, where, q.get("review_flags"))
    if q.get("choice_group") is not None and not isinstance(q["choice_group"], str):
        ctx.err(where, "choice_group must be a group id string or null")


def _check_review_flags(ctx: _Ctx, where: str, flags) -> None:
    if flags is None:
        return
    if not isinstance(flags, list) or not all(isinstance(f, str) for f in flags):
        ctx.err(where, "review_flags must be a list of strings, got %r" % (flags,))
        return
    for f in flags:
        if f not in REVIEW_FLAGS:
            ctx.warn(where, "unknown review flag %r (known: %s); it still marks the item for review"
                     % (f, ", ".join(sorted(REVIEW_FLAGS))))


def _check_answer(ctx: _Ctx, a) -> None:
    if not isinstance(a, dict):
        ctx.err("answers[]", "answer must be an object")
        return
    paper, label = a.get("paper"), a.get("label")
    where = "answer %s %s" % (paper, label)
    if not (isinstance(paper, str) and PAPER_RE.match(paper)):
        ctx.err(where, "paper must be \"P1\", \"P2\", ...")
    _check_label(ctx, where, label)
    key = (paper, label)
    if key in ctx.answers:
        ctx.err(where, "answer duplicated (also in %s)" % ctx.answers[key])
    ctx.answers[key] = ctx.file
    opt, text = a.get("correct_option"), a.get("answer_text")
    if opt is not None and not (isinstance(opt, str) and re.match(r"^[A-Z]$", opt)):
        ctx.err(where, "correct_option must be a single letter or null, got %r" % (opt,))
    if text is not None and not isinstance(text, str):
        ctx.err(where, "answer_text must be a string or null")
    if opt is None and not (isinstance(text, str) and text.strip()):
        ctx.err(where, "answer has neither correct_option nor answer_text")
    if a.get("marks") is not None and not (_is_int(a["marks"]) and a["marks"] >= 0):
        ctx.err(where, "marks must be a non-negative integer or null")
    if a.get("page_index") is not None:
        _check_page_index(ctx, where, a["page_index"])
    _check_regions(ctx, where, a.get("regions") or [], "regions")
    if a.get("confidence") is not None and a["confidence"] not in CONFIDENCE:
        ctx.warn(where, "confidence %r not one of %s" % (a["confidence"], sorted(CONFIDENCE)))
    _check_review_flags(ctx, where, a.get("review_flags"))


def validate_chunk(ctx: _Ctx, data) -> None:
    if not isinstance(data, dict):
        ctx.err("", "top level must be a JSON object")
        return
    if data.get("contract_version") != CONTRACT_VERSION:
        ctx.err("", "contract_version must be %d, got %r" % (CONTRACT_VERSION, data.get("contract_version")))
    if ctx.document_id is not None and data.get("document_id") != ctx.document_id:
        ctx.err("", "document_id %r does not match %r" % (data.get("document_id"), ctx.document_id))
    if not isinstance(data.get("chunk"), str):
        ctx.warn("", "chunk name missing")
    if not isinstance(data.get("extracted_by"), str):
        ctx.warn("", "extracted_by missing")
    for section, check in (("pages", _check_page), ("papers", _check_paper),
                           ("questions", _check_question), ("answers", _check_answer)):
        items = data.get(section)
        if items is None:
            ctx.err("", "missing %r list (use [] if the chunk has none)" % section)
            continue
        if not isinstance(items, list):
            ctx.err("", "%r must be a list" % section)
            continue
        for item in items:
            check(ctx, item)


def _cross_checks(ctx: _Ctx) -> None:
    labels = set(ctx.questions)
    has_children = {(p, parent_of(l)) for (p, l) in labels if isinstance(l, str) and parent_of(l)}
    fig_ids: Dict[str, str] = {}
    members: Dict[Tuple[str, str], int] = {}
    for (paper, label), (file, q) in sorted(ctx.questions.items(), key=lambda kv: str(kv[0])):
        ctx.file = file
        where = "question %s %s" % (paper, label)
        parent = q.get("parent_label")
        if parent is not None and (paper, parent) not in labels:
            ctx.err(where, "parent %s %s does not exist in any chunk" % (paper, parent))
        if q.get("type") == "context" and (paper, label) not in has_children:
            ctx.warn(where, "type is context but the node has no children")
        if paper not in ctx.papers and ctx.papers:
            ctx.warn(where, "no papers[] record for %s" % paper)
        if parent is None and not q.get("full_regions"):
            ctx.warn(where, "top-level question has no full_regions; the whole-question crop "
                            "falls back to its own regions")
        group = q.get("choice_group")
        if isinstance(group, str):
            if (paper, group) not in ctx.choice_groups:
                ctx.err(where, "choice_group %r is not declared in papers[] choice_groups for %s" % (group, paper))
            if parent is not None:
                ctx.err(where, "choice_group is only allowed on top-level questions")
            members[(paper, group)] = members.get((paper, group), 0) + 1
        for f in q.get("figures") or []:
            if isinstance(f, dict) and f.get("id"):
                k, me = str(f["id"]), "%s %s" % (paper, label)
                if k in fig_ids and fig_ids[k] != me:
                    ctx.warn(where, "figure id %s also used by %s (ids must be unique in the document)"
                             % (k, fig_ids[k]))
                fig_ids[k] = me
    for (paper, group), choose in sorted(ctx.choice_groups.items()):
        n = members.get((paper, group), 0)
        if n <= choose:
            ctx.file = ctx.papers.get(paper, ctx.file)
            ctx.warn("paper %s" % paper, "choice group %s has %d member question(s) but choose is %d"
                     % (group, n, choose))
    if ctx.page_count is not None and ctx.pages:
        missing = sorted(set(range(ctx.page_count)) - set(ctx.pages))
        if missing:
            ctx.file = "(document)"
            ctx.warn("", "no page record for page_index %s" % _ranges(missing))


def _ranges(nums: List[int]) -> str:
    out, start, prev = [], None, None
    for n in nums + [None]:
        if start is None:
            start = prev = n
        elif n is not None and n == prev + 1:
            prev = n
        else:
            out.append(str(start) if start == prev else "%d-%d" % (start, prev))
            start = prev = n
    return ", ".join(out)


def read_chunks(src_dir: Path) -> Tuple[List[Tuple[Path, dict]], List[Issue]]:
    chunks, issues = [], []
    files = sorted(Path(src_dir).glob("*.json"))
    if not files:
        issues.append(Issue("error", str(src_dir), "", "no extraction JSON files found"))
    for f in files:
        try:
            chunks.append((f, json.loads(f.read_text(encoding="utf-8"))))
        except (ValueError, UnicodeDecodeError) as e:
            issues.append(Issue("error", f.name, "", "invalid JSON: %s" % e))
    return chunks, issues


def validate(chunks: Iterable[Tuple[Path, dict]], document_id: Optional[str] = None,
             page_count: Optional[int] = None, topic_codes: Iterable[str] = ()) -> List[Issue]:
    ctx = _Ctx(document_id, page_count, set(topic_codes))
    for path, data in chunks:
        ctx.file = Path(path).name
        validate_chunk(ctx, data)
    _cross_checks(ctx)
    return ctx.issues


def errors(issues: Iterable[Issue]) -> List[Issue]:
    return [i for i in issues if i.level == "error"]
