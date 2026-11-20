"""Claude API vision extractor: scanned page images -> contract JSON chunks (contract v1.1).

RUNBOOK
=======

Commands are run from the repo root with `.venv/bin/python`. Requests not in the cache need
ANTHROPIC_API_KEY (ANTHROPIC_BASE_URL is honoured). Cached requests need no key.

New paper
---------
    .venv/bin/python -m ingest run papers/<file>.pdf --extractor claude [--model claude-opus-5-5]

This rasterizes, extracts into data/extracted/<document_id>/ and loads into the DB. If some
chunks fail at the API after the SDK's retries (ExtractionIncompleteError), the CLI writes
.incomplete.json next to the chunks and loads nothing. Re-run the same command (no --force) to
retry; completed requests come from the cache. To re-extract a finished document, for example
after a prompt change, add --force: the old JSON is moved to _replaced/ first. Without --force,
existing complete JSON is loaded as it is.

Per-run details (classification, chunk plan, retries, issues per chunk, token usage and
estimated cost) are in <data>/cache/claude/runs/<document_id>.json. Remaining problems are in
the JSON as confidence "low", review_flags, and "[check] ..." notes.

Score against a gold set
------------------------
    .venv/bin/python -m ingest eval --gold data/gold/<document_id> --pred <dir of chunk JSON>

This prints a table (see ingest/eval.py) and RESULT: PASS/FAIL against DEFAULT_THRESHOLDS.
The exit status is non-zero on FAIL.

Recommended first step: a real run on the Montfort paper, scored against its gold set
------------------------------------------------------------------------------------------
data/extracted/montfort-2025-sec4-chem-prelim already holds JSON derived from the gold set and
is loaded in data/db. A second --document-id for the same PDF does not work: the DB refuses
one PDF under two ids ("this PDF is already ingested as document ..."). Use a separate data
directory instead. INGEST_DATA_DIR moves the DB, assets, extracted JSON and cache together.
data/work/ is gitignored.

    export ANTHROPIC_API_KEY=...
    INGEST_DATA_DIR=data/work/claude-trial .venv/bin/python -m ingest run \
        papers/Sec4_PureChemistry_2025_SA2_montfort.pdf --extractor claude \
        --document-id montfort-2025-sec4-chem-prelim
    .venv/bin/python -m ingest eval --gold data/gold/montfort-2025-sec4-chem-prelim \
        --pred data/work/claude-trial/extracted/montfort-2025-sec4-chem-prelim

That run makes about 13 classifier calls and about 11 extraction calls, plus retries. To keep
the responses for later runs in the main data directory, copy the cache:
`cp -R data/work/claude-trial/cache/claude data/cache/`. The cache key includes the image
bytes, and both runs render the same images, so the copied entries hit.

Iterating on prompts
--------------------
1. Edit ingest/extract/prompts.py, then bump PROMPT_VERSION. Edits miss the cache anyway,
   because the key hashes the full request, but the bump makes the re-extraction deliberate
   and visible in the run summary.
2. Re-run the trial command above with --force. The classifier prompt and the question prompt
   are separate requests, so changing one leaves the other cached.
3. Re-run eval and compare with the previous report. Old cache entries are kept, so reverting
   a prompt costs nothing.
Check fixes against more than one paper before trusting them. The prompts must stay generic:
no page indices, question counts or school-specific layout.

Model options (extraction model; estimated cost for a ~50-page paper)
---------------------------------------------------------------------
DEFAULT_MODEL is claude-fable-5-2, the strongest vision model per the claude-api skill. Revisit
this once real eval numbers exist. Override it with --model / ClaudeExtractor(model=...) /
INGEST_CLAUDE_MODEL. The classifier is claude-haiku-5-5; override it with classifier_model= or
INGEST_CLAUDE_CLASSIFIER_MODEL. Its share is about $0.03 per paper.

| model             | $/MTok in/out | est. per paper | notes                                          |
|-------------------|---------------|----------------|------------------------------------------------|
| claude-fable-5-2  | 8 / 40        | ~$9-12         | default; needs 30-day retention (no ZDR)       |
| claude-opus-5-5   | 4 / 20        | ~$5-6          | the skill's general default; try first if cost matters |
| claude-sonnet-5-5 | 2 / 10        | ~$2.5-3        | worth an eval run; may miss small print        |

Estimates assume ~46 question/key pages at ~4.6k image tokens, ~11 chunks, ~15k output
tokens per chunk including thinking at effort "high", and ~25% retries. Thinking volume is the
main unknown. The run summary records actual usage and an estimated_cost_usd.

PIPELINE
========
1. Classify (cheap model, low effort, small page renders, a few pages per request). For each
   page: page_type, paper, printed page number, section headings, the top-level question
   numbers that start on it, whether its top continues the previous page, cover metadata, and
   choice instructions ("Section B: answer one question").
2. Plan chunks in code (plan_chunks). Consecutive question pages of one paper are cut only
   where a page starts a fresh top-level question, then packed into chunks of <= max_pages
   pages, so a question that spans pages stays in one chunk. Answer-key pages are planned the
   same way. Cover, data-sheet, blank and other pages go into a per-paper "<paper>_misc"
   chunk, which owns that paper's papers[] record.
3. Extract questions with the strongest model, high-resolution page renders, and structured
   outputs whose schema mirrors the contract. The model returns pixel boxes; code converts them
   to the contract's normalised boxes. Each response is normalised (labels, Unicode, chlorine)
   and validated. On errors the model gets one retry with the errors fed back, in the same
   conversation so the cached image prefix is reused. Anything still wrong is written with
   confidence "low" and the problem in notes; it is never dropped and never crashes the run.
   Broken source content is flagged (review_flags), not silently fixed.
4. Extract answers from answer-key chunks after the questions, with the transcribed labels in
   the prompt so mark-scheme labels line up with question labels.
5. Reconcile across chunks: duplicate labels from a mis-detected page continuation are merged,
   orphans flagged and figure ids made unique. Then the document rules run (answer_mismatch
   cross-check, papers[].choice_groups and choice_group on member questions), and the
   <chunk>.json files are written.

Every API response is cached on disk under cache_dir. The key is the sha256 of the full
request (model, PROMPT_VERSION, system prompt, schema, effort, image sha256s, ...), so a
re-run is free and deterministic, and only failed or changed requests reach the API.
"""
from __future__ import annotations

import base64
import concurrent.futures
import copy
import hashlib
import io
import json
import logging
import math
import os
import re
import tempfile
import threading
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

from . import prompts
from .base import DocumentInput, PageImage

log = logging.getLogger("ingest.extract.claude")

# Strongest current vision model per the claude-api skill; see "Model options" above.
DEFAULT_MODEL = "claude-fable-5-2"
# Page triage is easy; the current Haiku is ample and nearly free.
DEFAULT_CLASSIFIER_MODEL = "claude-haiku-5-5"

CONTRACT_VERSION = 1

# High-resolution vision tier (Opus 4.7+ / Fable / Sonnet 5+): <= 2576 px long edge and about
# 3.75 MP (4784 visual tokens). Stay a little under the pixel cap so the API never downscales.
HIRES_MAX_LONG_EDGE = 2576
HIRES_MAX_PIXELS = 3_600_000
# Classification only needs question numbers and headings.
CLASSIFY_MAX_LONG_EDGE = 1568
CLASSIFY_MAX_PIXELS = 1_200_000
# The API rejects base64 images over 5 MB.
MAX_IMAGE_BYTES = 4_800_000

# Generous-box padding added in code (normalised units); the loader snaps and trims.
BOX_PAD = 0.006
# Pixel boxes may overshoot the image by this fraction before it counts as an error.
BOX_TOLERANCE = 0.02

# Models that accept the server-side refusal fallback (beta). Haiku has none.
_FALLBACK_MODELS = ("claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5-5")
_FALLBACK_BETA = "server-side-fallback-2026-07-01"

# USD per million tokens: (input, output). Cache writes bill 1.25x input, reads 0.1x input
# unless listed in _CACHE_READ. Used only for the cost estimate in logs and run summaries.
_PRICES = {
    "claude-fable-5-2": (8.0, 40.0),
    "claude-fable-5-1": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-haiku-4-5": (1.0, 5.0),
}
_CACHE_READ = {"claude-fable-5-2": 0.20, "claude-opus-5-5": 0.20, "claude-sonnet-5-5": 0.10}


class ClaudeExtractorError(RuntimeError):
    """Configuration or unrecoverable extraction error."""


class ExtractionIncompleteError(ClaudeExtractorError):
    """Some chunks failed at the API level. Files were written; re-run to retry those chunks."""

    def __init__(self, message: str, paths: List[Path]):
        super().__init__(message)
        self.paths = paths


# =============================================================================================
# Labels and text
# =============================================================================================

_ROMAN_RE = re.compile(r"^(?=[ivx])(x{0,3})(ix|iv|v?i{0,3})$")
_ROMAN_VALUES = {"i": 1, "v": 5, "x": 10}


def _is_roman(s: str) -> bool:
    return bool(_ROMAN_RE.match(s))


def _roman_value(s: str) -> int:
    total, prev = 0, 0
    for ch in reversed(s):
        v = _ROMAN_VALUES[ch]
        total = total - v if v < prev else total + v
        prev = max(prev, v)
    return total


def is_canonical_label(label: Any) -> bool:
    """'7', '2(a)', '2(a)(ii)', '10(b)(iii)', '3(iv)'.

    Same rule as the loader (ingest/validate.py): a number, then optionally a letter or roman
    numeral in brackets, then optionally a roman numeral in brackets.
    """
    if not isinstance(label, str):
        return False
    m = re.fullmatch(r"[1-9]\d{0,2}((?:\([a-z]+\)){0,2})", label)
    if not m:
        return False
    groups = re.findall(r"\(([a-z]+)\)", m.group(1))
    if groups and not (len(groups[0]) == 1 or _is_roman(groups[0])):
        return False
    return len(groups) < 2 or _is_roman(groups[1])


def normalize_label(raw: Any) -> Optional[str]:
    """Normalise question / mark-scheme labels to canonical form.

    '3ai' -> '3(a)(i)', '5bii' -> '5(b)(ii)', 'Q4 (c)' -> '4(c)', '2(a)ii' -> '2(a)(ii)',
    '07' -> '7', '3(A)(I)' -> '3(a)(i)'. Returns None when the text is not a label.
    """
    if raw is None:
        return None
    s = unicodedata.normalize("NFKC", str(raw)).strip().lower()
    s = re.sub(r"^(?:question|qn|q|no)\.?\s*", "", s)
    s = re.sub(r"[\s.\-_,:;]+", "", s)
    s = s.replace("[", "(").replace("]", ")").replace("{", "(").replace("}", ")")
    m = re.fullmatch(r"(\d+)(.*)", s)
    if not m:
        return None
    num, rest = str(int(m.group(1))), m.group(2)
    if num == "0":
        return None
    tokens = re.findall(r"\(([a-z]+)\)|([a-z]+)", rest)
    if "".join(f"({b})" if b else a for b, a in tokens) != rest:
        return None  # stray characters, e.g. digits after the number part
    parts: List[str] = []
    for bracketed, bare in tokens:
        if bracketed:
            parts.append(bracketed)
            continue
        # Unbracketed run: first a single sub-part letter (unless one exists), then roman.
        run = bare
        if not parts:
            if len(run) == 1 or _is_roman(run):
                parts.append(run)  # "3a" -> 3(a); "3iv" -> 3(iv): roman directly under the number
                continue
            parts.append(run[0])
            run = run[1:]
        if not _is_roman(run):
            return None
        parts.append(run)
    if len(parts) > 2:
        return None
    label = num + "".join(f"({p})" for p in parts)
    return label if is_canonical_label(label) else None


def parent_of(label: str) -> Optional[str]:
    i = label.rfind("(")
    return label[:i] if i > 0 else None


def top_of(label: str) -> str:
    i = label.find("(")
    return label if i < 0 else label[:i]


def label_sort_key(label: str) -> Tuple:
    m = re.match(r"(\d+)", label or "")
    if not m:
        return (10**6, label or "")
    key: List[Tuple[int, int]] = []
    for i, g in enumerate(re.findall(r"\(([a-z]+)\)", label)):
        if i > 0 and _is_roman(g):
            key.append((1, _roman_value(g)))
        else:
            key.append((0, ord(g[0])))
    return (int(m.group(1)), tuple(key))


_ELEMENTS = set(
    "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se "
    "Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy "
    "Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf "
    "Es Fm Md No Lr".split()
)
_TOKEN_RE = re.compile(r"[A-Za-z0-9₀-₉⁰-⁹⁺⁻]+")
_FORMULA_PIECE_RE = re.compile(r"[A-Z][a-z]?|[0-9₀-₉⁰-⁹⁺⁻]+")


def _is_formula_token(tok: str) -> bool:
    pieces = _FORMULA_PIECE_RE.findall(tok)
    if "".join(pieces) != tok:
        return False
    syms = [p for p in pieces if p[0].isalpha()]
    return bool(syms) and all(p in _ELEMENTS for p in syms)


def fix_chlorine(text: str) -> str:
    """Scans print chlorine's 'l' like a capital 'I': HCI -> HCl, CI₂ -> Cl₂, NaCIO -> NaClO.

    Only touches tokens made purely of element symbols, digits, sub/superscripts and brackets,
    so words ('CIRCLE', 'ICE') are left alone.
    """
    if "CI" not in text:
        return text

    def fix(m: "re.Match[str]") -> str:
        tok = m.group(0)
        if "CI" in tok and _is_formula_token(tok):
            return re.sub(r"CI(?![a-z])", "Cl", tok)
        return tok

    return _TOKEN_RE.sub(fix, text)


def clean_text(text: Any) -> str:
    if text is None:
        return ""
    s = unicodedata.normalize("NFC", str(text)).replace("\r\n", "\n")
    s = "\n".join(line.rstrip() for line in s.split("\n"))
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    return fix_chlorine(s)


def canon_enum(value: Any, allowed: List[str]) -> Optional[str]:
    """Structured outputs may change an enum value's capitalisation; match case-insensitively."""
    if not isinstance(value, str):
        return None
    if value in allowed:
        return value
    low = value.strip().lower()
    return next((a for a in allowed if a.lower() == low), None)


def blank_to_none(value: Any) -> Any:
    """Classifier schema uses "" / 0 for "not printed" (fewer nullable unions); map to null."""
    if isinstance(value, str):
        value = value.strip()
        return value or None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value == 0:
        return None
    return value


def clean_cover(cover: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(cover, dict):
        return None
    out = {k: blank_to_none(v) for k, v in cover.items()}
    out["paper"] = canon_enum(out.get("paper"), prompts.PAPERS)
    return out


def infer_paper_from_code(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    m = re.search(r"/\s*0?([1-9])\b", code)
    return f"P{m.group(1)}" if m else None


# =============================================================================================
# Classification results and chunk planning
# =============================================================================================

@dataclass
class PageInfo:
    page_index: int
    page_type: str = "other"
    paper: Optional[str] = None
    printed_page_number: Optional[str] = None
    section: Optional[str] = None
    question_starts: List[str] = field(default_factory=list)
    continues_previous: bool = False
    has_handwriting: bool = False
    cover: Optional[Dict[str, Any]] = None
    choice_instructions: List[Dict[str, Any]] = field(default_factory=list)
    notes: str = ""


@dataclass
class ChunkPlan:
    name: str
    kind: str                     # "questions" | "answers" | "misc"
    paper: Optional[str]
    page_indices: List[int]
    expected_starts: List[str] = field(default_factory=list)
    previous_question: Optional[str] = None
    section_at_start: Optional[str] = None


def page_info_from_model(page_index: int, p: Dict[str, Any]) -> PageInfo:
    """One classifier page entry -> PageInfo (normalised labels, enums and blanks)."""
    starts = [normalize_label(x) for x in p.get("question_starts") or []]
    page_type = canon_enum(p.get("page_type"), prompts.PAGE_TYPES) or "other"
    printed = p.get("printed_page_number")
    return PageInfo(
        page_index=page_index,
        page_type=page_type,
        paper=canon_enum(p.get("paper"), prompts.PAPERS),
        printed_page_number=blank_to_none(str(printed)) if printed is not None else None,
        section=blank_to_none(p.get("section")),
        question_starts=[top_of(x) for x in starts if x],
        continues_previous=bool(p.get("continues_previous")),
        has_handwriting=bool(p.get("has_handwriting")),
        cover=clean_cover(p.get("cover")) if page_type == "cover" else None,
        choice_instructions=[c for c in (_clean_choice(x) for x in p.get("choice_instructions") or []) if c],
        notes=clean_text(p.get("notes")),
    )


def _clean_choice(c: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(c, dict):
        return None
    gid = clean_text(c.get("group_id")).strip()
    gid = re.sub(r"(?i)^section\s+", "", gid)
    try:
        choose = int(c.get("choose") or 0)
    except (TypeError, ValueError):
        choose = 0
    if not gid or choose < 1:
        return None
    members = [top_of(n) for n in (normalize_label(x) for x in c.get("questions") or []) if n]
    return {"id": gid, "choose": choose, "questions": members, "note": clean_text(c.get("note"))}


def choice_groups(infos: List[PageInfo], questions: List[Dict[str, Any]]
                  ) -> Tuple[Dict[str, List[Dict[str, Any]]], Dict[Tuple[str, str], str]]:
    """Choice groups per paper (from classifier instructions) and their member questions.

    Members are the top-level questions the instruction names, else every top-level question
    whose section equals the group id ("Section B: answer one question"). The first
    instruction seen for a (paper, id) wins; covers and section headings often repeat it.
    Returns ({paper: [{"id", "choose", "note"}]}, {(paper, top label): group id}).
    """
    groups: Dict[str, List[Dict[str, Any]]] = {}
    members: Dict[Tuple[str, str], str] = {}
    seen: Set[Tuple[str, str]] = set()
    tops = [q for q in questions if q.get("parent_label") is None and q.get("paper")]
    for info in sorted(infos, key=lambda i: i.page_index):
        for c in info.choice_instructions:
            paper = info.paper
            if not paper or (paper, c["id"]) in seen:
                continue
            seen.add((paper, c["id"]))
            named = set(c["questions"])
            mem = [q["label"] for q in tops if q["paper"] == paper
                   and (q["label"] in named if named else (q.get("section") or "") == c["id"])]
            if len(mem) <= c["choose"]:
                log.warning("choice group %s %s: %d member question(s) for choose=%d; ignored",
                            paper, c["id"], len(mem), c["choose"])
                continue
            groups.setdefault(paper, []).append({"id": c["id"], "choose": c["choose"], "note": c["note"]})
            for lab in mem:
                members[(paper, lab)] = c["id"]
    return groups, members


def _paper_slug(paper: Optional[str]) -> str:
    return paper.lower() if paper else "px"


def _suffix(i: int) -> str:
    letters = "abcdefghijklmnopqrstuvwxyz"
    return letters[i] if i < 26 else f"{letters[i // 26 - 1]}{letters[i % 26]}"


def fill_forward(pages: List[PageInfo]) -> List[PageInfo]:
    """Carry paper and section forward through the document (in page order).

    A cover page starts a new paper (its paper code decides which; unknown resets the carry).
    Answer-key pages neither inherit nor change the carry: keys often cover several papers.
    """
    out = [copy.deepcopy(p) for p in sorted(pages, key=lambda p: p.page_index)]
    carry_paper: Optional[str] = None
    carry_section: Optional[str] = None
    for p in out:
        if p.page_type == "answer_key":
            continue
        if p.page_type == "cover":
            cover = p.cover or {}
            p.paper = p.paper or cover.get("paper") or infer_paper_from_code(cover.get("paper_code"))
            if p.paper != carry_paper:
                carry_section = None
            carry_paper = p.paper
            continue
        if p.paper is None:
            p.paper = carry_paper
        elif p.paper != carry_paper:
            carry_section = None
            carry_paper = p.paper
        if p.page_type == "questions":
            if p.section:
                carry_section = p.section
            elif carry_section:
                p.section = carry_section
    return out


def _starts_new_unit(prev: PageInfo, page: PageInfo, by_paper: bool) -> bool:
    if by_paper and page.paper != prev.paper:
        return True
    if page.page_index != prev.page_index + 1:
        return True
    # Only cut where the page top is a fresh question. A page with no starts and no
    # continuation flag is ambiguous; keeping it with the previous page is the safe choice.
    return bool(page.question_starts) and not page.continues_previous


def _units(pages: List[PageInfo], by_paper: bool) -> List[List[PageInfo]]:
    units: List[List[PageInfo]] = []
    for p in pages:
        if units and not _starts_new_unit(units[-1][-1], p, by_paper):
            units[-1].append(p)
        else:
            units.append([p])
    return units


def _pack(units: List[List[PageInfo]], max_pages: int, by_paper: bool) -> List[List[PageInfo]]:
    chunks: List[List[PageInfo]] = []
    for u in units:
        if chunks:
            cur = chunks[-1]
            contiguous = u[0].page_index == cur[-1].page_index + 1
            same_paper = (not by_paper) or u[0].paper == cur[-1].paper
            if contiguous and same_paper and len(cur) + len(u) <= max_pages:
                cur.extend(u)
                continue
        chunks.append(list(u))
    return chunks


def plan_chunks(pages: List[PageInfo], max_pages: int = 5) -> List[ChunkPlan]:
    """Turn (forward-filled) page classifications into chunks.

    Every page lands in exactly one chunk. Question chunks never split a question across chunks
    unless the classifier missed a continuation; a single question longer than max_pages gets
    a chunk of its own.
    """
    pages = sorted(pages, key=lambda p: p.page_index)
    plans: List[ChunkPlan] = []

    qpages = [p for p in pages if p.page_type == "questions"]
    counters: Dict[Optional[str], int] = {}
    starts_so_far: Dict[Optional[str], List[str]] = {}
    for chunk in _pack(_units(qpages, by_paper=True), max_pages, by_paper=True):
        paper = chunk[0].paper
        n = counters.get(paper, 0)
        counters[paper] = n + 1
        before = starts_so_far.setdefault(paper, [])
        first = chunk[0]
        prev_pages = [p for p in qpages if p.paper == paper and p.page_index < first.page_index]
        section = prev_pages[-1].section if prev_pages else None
        expected = [s for p in chunk for s in p.question_starts]
        plans.append(ChunkPlan(
            name=f"{_paper_slug(paper)}_{_suffix(n)}",
            kind="questions",
            paper=paper,
            page_indices=[p.page_index for p in chunk],
            expected_starts=expected,
            previous_question=before[-1] if before else None,
            section_at_start=section,
        ))
        before.extend(expected)

    # Answer keys: same grouping, but long runs are split at max_pages. An answer cut at a chunk
    # boundary is cheap to repair (reconcile merges answers with the same label), whereas one
    # huge chunk risks hitting the output limit.
    kpages = [p for p in pages if p.page_type == "answer_key"]
    kunits = [u[i:i + max_pages] for u in _units(kpages, by_paper=False) for i in range(0, len(u), max_pages)]
    seen_starts: List[str] = []
    for i, chunk in enumerate(_pack(kunits, max_pages, by_paper=False)):
        expected = [s for p in chunk for s in p.question_starts]
        plans.append(ChunkPlan(
            name=f"key_{_suffix(i)}", kind="answers", paper=None,
            page_indices=[p.page_index for p in chunk],
            expected_starts=expected,
            previous_question=seen_starts[-1] if seen_starts else None,
        ))
        seen_starts.extend(expected)

    misc: Dict[Optional[str], List[int]] = {}
    for p in pages:
        if p.page_type not in ("questions", "answer_key"):
            misc.setdefault(p.paper, []).append(p.page_index)
    for paper in sorted(misc, key=lambda k: (k is None, k or "")):
        name = f"{_paper_slug(paper)}_misc" if paper else "misc"
        plans.append(ChunkPlan(name=name, kind="misc", paper=paper, page_indices=misc[paper]))
    return plans


# =============================================================================================
# Response conversion and validation
# =============================================================================================

@dataclass
class Issue:
    kind: str                 # "question" | "answer" | "chunk"
    label: Optional[str]
    message: str
    fatal: bool = True        # fatal issues trigger the retry; others only become notes

    def text(self) -> str:
        where = f"{self.kind} {self.label}" if self.label else self.kind
        return f"{where}: {self.message}"


def _convert_box(box: Any, size: Tuple[int, int], what: str, issues: List[Issue], kind: str,
                 label: Optional[str]) -> Optional[List[float]]:
    """Pixel box in the sent image -> normalised, padded, clamped [x0, y0, x1, y1]."""
    w, h = size
    try:
        x0, y0, x1, y1 = (float(box[k]) for k in ("x0", "y0", "x1", "y1"))
    except (KeyError, TypeError, ValueError):
        issues.append(Issue(kind, label, f"{what}: box is not {{x0,y0,x1,y1}}"))
        return None
    if x1 <= x0 or y1 <= y0:
        issues.append(Issue(kind, label, f"{what}: box has zero or negative size ({x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f})"))
        return None
    tol_x, tol_y = w * BOX_TOLERANCE, h * BOX_TOLERANCE
    if x0 < -tol_x or y0 < -tol_y or x1 > w + tol_x or y1 > h + tol_y:
        issues.append(Issue(kind, label, f"{what}: box ({x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}) lies outside the "
                                         f"{w}×{h} px image"))
        return None
    nx0 = max(0.0, x0 / w - BOX_PAD)
    ny0 = max(0.0, y0 / h - BOX_PAD)
    nx1 = min(1.0, x1 / w + BOX_PAD)
    ny1 = min(1.0, y1 / h + BOX_PAD)
    return [round(nx0, 3), round(ny0, 3), round(nx1, 3), round(ny1, 3)]


def _convert_regions(raw: Any, sizes: Dict[int, Tuple[int, int]], what: str, issues: List[Issue],
                     kind: str, label: Optional[str]) -> List[Dict[str, Any]]:
    out = []
    for r in raw or []:
        pi = r.get("page_index") if isinstance(r, dict) else None
        if pi not in sizes:
            issues.append(Issue(kind, label, f"{what}: page_index {pi} is not one of the pages sent "
                                             f"({', '.join(map(str, sorted(sizes)))})"))
            continue
        bbox = _convert_box(r.get("box"), sizes[pi], what, issues, kind, label)
        if bbox:
            out.append({"page_index": pi, "bbox": bbox})
    return out


def convert_questions(
    raw: Dict[str, Any],
    sizes: Dict[int, Tuple[int, int]],
    plan: ChunkPlan,
    topic_codes: Set[str],
) -> Tuple[List[Dict[str, Any]], List[Issue]]:
    """Model output (pixel boxes) -> contract question nodes, plus validation issues."""
    issues: List[Issue] = []
    questions: List[Dict[str, Any]] = []
    for i, q in enumerate(raw.get("questions") or []):
        raw_label = q.get("label")
        label = normalize_label(raw_label)
        ref = label or str(raw_label)
        if label is None:
            issues.append(Issue("question", ref, f"label {raw_label!r} is not a canonical label such as 7, 2(a), 2(a)(ii)"))
            label = str(raw_label)
        derived_parent = parent_of(label) if is_canonical_label(label) else None
        given_parent = normalize_label(q.get("parent_label")) if q.get("parent_label") else None
        notes = [clean_text(q.get("notes"))] if q.get("notes") else []
        if given_parent != derived_parent and is_canonical_label(label):
            issues.append(Issue("question", ref, f"parent_label {q.get('parent_label')!r} corrected to {derived_parent!r}", fatal=False))

        qtype = canon_enum(q.get("type"), prompts.QUESTION_TYPES) or q.get("type")
        flags = _clean_flags(q.get("review_flags"))
        options = [{"label": canon_enum(o.get("label"), prompts.OPTION_LABELS) or o.get("label"),
                    "text": clean_text(o.get("text"))} for o in (q.get("options") or [])]
        marks = q.get("marks")
        paper = plan.paper or canon_enum(q.get("paper"), prompts.PAPERS)

        node: Dict[str, Any] = {
            "paper": paper,
                "section": (q.get("section") or None),
            "label": label,
            "parent_label": derived_parent,
            "type": qtype,
            "stem": clean_text(q.get("stem")),
            "options": options,
            "marks": marks,
            "regions": _convert_regions(q.get("regions"), sizes, "regions", issues, "question", ref),
        }
        if derived_parent is None:
            node["full_regions"] = _convert_regions(q.get("full_regions"), sizes, "full_regions", issues, "question", ref)
        space = canon_enum(q.get("answer_space"), prompts.ANSWER_SPACES) or "none"
        if qtype in ("mcq", "context") and space != "none":
            issues.append(Issue("question", ref, f"answer_space {space!r} set to 'none' for a {qtype} node", fatal=False))
            space = "none"
        node["answer_space"] = space
        figures = []
        for j, f in enumerate(q.get("figures") or []):
            pi = f.get("page_index")
            if pi not in sizes:
                issues.append(Issue("question", ref, f"figure {f.get('id')!r}: page_index {pi} is not one of the pages sent"))
                continue
            bbox = _convert_box(f.get("box"), sizes[pi], f"figure {f.get('id')!r}", issues, "question", ref)
            if not bbox:
                continue
            figures.append({
                "id": (f.get("id") or "").strip() or f"fig-q{label}-{j + 1}",
                "page_index": pi,
                "bbox": bbox,
                "kind": canon_enum(f.get("kind"), prompts.FIGURE_KINDS) or "diagram",
                "caption": clean_text(f.get("caption")),
                "description": clean_text(f.get("description")),
            })
        node["figures"] = figures
        topics = [t for t in (q.get("topics") or [])]
        node["topics"] = topics
        node["has_handwriting"] = bool(q.get("has_handwriting"))
        node["confidence"] = canon_enum(q.get("confidence"), prompts.CONFIDENCE) or "medium"
        node["review_flags"] = flags
        node["notes"] = "; ".join(n for n in notes if n)

        # Per-node rules.
        if qtype not in prompts.QUESTION_TYPES:
            issues.append(Issue("question", ref, f"type {qtype!r} must be one of {prompts.QUESTION_TYPES}"))
        if qtype == "mcq":
            letters = [o["label"] for o in options]
            if len(options) < 2 or len(set(letters)) != len(letters):
                issues.append(Issue("question", ref, "mcq needs its options A to D, each label once"))
            if any(not o["text"] for o in options) and not {"source_defect", "illegible"} & set(flags):
                issues.append(Issue("question", ref, "mcq option with empty text; give a text rendering of every "
                                                     "option, or write \"(blank in scan)\" and flag source_defect"))
            if marks is None:
                node["marks"] = 1
            elif marks != 1:
                issues.append(Issue("question", ref, f"mcq marks is {marks}, expected 1", fatal=False))
        elif options:
            issues.append(Issue("question", ref, f"{qtype} node has options; only mcq nodes have options"))
        if qtype == "context" and marks is not None:
            issues.append(Issue("question", ref, "context node has marks; if it has its own answer space and children use type structured"))
        if qtype == "structured" and marks is None:
            issues.append(Issue("question", ref, "structured node has no marks", fatal=False))
        if qtype in ("mcq", "structured") and not topics:
            issues.append(Issue("question", ref, "needs 1 to 3 topic codes"))
        bad_topics = [t for t in topics if t not in topic_codes]
        if bad_topics:
            issues.append(Issue("question", ref, f"unknown topic codes {bad_topics}; use subtopic codes from the list"))
            node["topics"] = [t for t in topics if t in topic_codes]
        if len(node["topics"]) > 3:
            node["topics"] = node["topics"][:3]
            issues.append(Issue("question", ref, "more than 3 topics; kept the first 3", fatal=False))
        if not node["regions"] and not any("regions:" in x.message for x in issues if x.label == ref):
            issues.append(Issue("question", ref, "regions is empty; give the area of this node's own text on each page"))
        if derived_parent is None and is_canonical_label(label) and not node.get("full_regions"):
            # Childless top-level questions (MCQs): full_regions equals regions. With parts it
            # must come from the model; checked in _tree_issues once children are known.
            node["full_regions"] = []
        if qtype == "mcq" and not node["stem"]:
            issues.append(Issue("question", ref, "mcq has an empty stem", fatal=False))
        questions.append(node)

    issues.extend(_tree_issues(questions, plan))
    return questions, issues


def _tree_issues(questions: List[Dict[str, Any]], plan: ChunkPlan) -> List[Issue]:
    issues: List[Issue] = []
    labels = [q["label"] for q in questions]
    seen: Set[str] = set()
    for lab in labels:
        if lab in seen:
            issues.append(Issue("question", lab, "label appears more than once; emit one node per label"))
        seen.add(lab)
    children: Dict[str, int] = {}
    for q in questions:
        par = q["parent_label"]
        if par:
            children[par] = children.get(par, 0) + 1
    continuing = {plan.previous_question} if plan.previous_question else set()
    for q in questions:
        lab, par = q["label"], q["parent_label"]
        if par and par not in seen:
            # Allowed only when this question started before the chunk (page continuation).
            if top_of(lab) not in continuing:
                issues.append(Issue("question", lab, f"parent node {par} is missing; emit a node for every level"))
        if q["type"] == "context" and not children.get(lab):
            issues.append(Issue("question", lab, "context node has no children; a node without parts is mcq or structured"))
        if q["type"] == "mcq" and children.get(lab):
            issues.append(Issue("question", lab, "mcq node has children"))
        if par is None and "full_regions" in q and not q["full_regions"]:
            if children.get(lab):
                issues.append(Issue("question", lab, "top-level question needs full_regions covering the whole "
                                                     "question including its parts"))
            else:
                q["full_regions"] = [dict(r) for r in q["regions"]]
    tops = {top_of(lab) for lab in labels if is_canonical_label(lab)}
    for s in plan.expected_starts:
        n = normalize_label(s)
        if n and top_of(n) not in tops:
            issues.append(Issue("chunk", None, f"the pre-scan saw question {n} start on these pages but no nodes for "
                                               f"{n} were returned; check whether it is printed here"))
    return issues


def convert_answers(
    raw: Dict[str, Any],
    sizes: Dict[int, Tuple[int, int]],
    known_labels: Dict[str, Set[str]],
) -> Tuple[List[Dict[str, Any]], List[Issue]]:
    issues: List[Issue] = []
    answers: List[Dict[str, Any]] = []
    seen: Set[Tuple[Optional[str], str]] = set()
    papers_known = sorted(known_labels)
    for a in raw.get("answers") or []:
        raw_label = a.get("label")
        label = normalize_label(raw_label)
        ref = label or str(raw_label)
        if label is None:
            issues.append(Issue("answer", ref, f"label {raw_label!r} is not a canonical label such as 7, 2(a), 2(a)(ii)"))
            label = str(raw_label)
        paper = canon_enum(a.get("paper"), prompts.PAPERS)
        if paper is None and len(papers_known) == 1:
            paper = papers_known[0]
        if paper is None and len(papers_known) > 1:
            issues.append(Issue("answer", ref, f"paper is null; say which paper ({', '.join(papers_known)}) this answer belongs to"))
        opt = canon_enum(a.get("correct_option"), prompts.OPTION_LABELS)
        text = clean_text(a.get("answer_text")) or None
        if opt is None and text is None:
            issues.append(Issue("answer", ref, "needs correct_option (MCQ) or answer_text"))
        regions = _convert_regions(a.get("regions"), sizes, "regions", issues, "answer", ref)
        if not regions and not any("regions:" in x.message for x in issues if x.label == ref):
            issues.append(Issue("answer", ref, "regions is empty"))
        key = (paper, label)
        if key in seen:
            issues.append(Issue("answer", ref, f"duplicate answer for {paper} {label}"))
        seen.add(key)
        if paper in known_labels and known_labels[paper] and label not in known_labels[paper]:
            issues.append(Issue("answer", ref, f"no question {label} was transcribed for {paper}", fatal=False))
        marks = a.get("marks")
        if marks is None and opt is not None:
            marks = 1
        conf = canon_enum(a.get("confidence"), prompts.CONFIDENCE) or "medium"
        flags = _clean_flags(a.get("review_flags"))
        answers.append({
            "paper": paper,
            "label": label,
            "correct_option": opt,
            "answer_text": text,
            "marks": marks,
            "page_index": regions[0]["page_index"] if regions else None,
            "regions": regions,
            "confidence": conf,
            "review_flags": flags,
            "notes": clean_text(a.get("notes")),
        })
    return answers, issues


def _clean_flags(raw: Any) -> List[str]:
    out: List[str] = []
    for f in raw or []:
        c = canon_enum(f, prompts.REVIEW_FLAGS)
        if c and c not in out:
            out.append(c)
    return out


def _add_flag(item: Dict[str, Any], flag: str, note: str) -> None:
    flags = item.setdefault("review_flags", [])
    if flag not in flags:
        flags.append(flag)
    _append_note(item, note)


def cross_check_answers(questions: List[Dict[str, Any]], answers: List[Dict[str, Any]]) -> None:
    """Flag answers that contradict their question (contract: review_flags answer_mismatch)."""
    by_key = {(q.get("paper"), q["label"]): q for q in questions}
    for a in answers:
        q = by_key.get((a.get("paper"), a["label"]))
        if q is None:
            continue
        opt = a.get("correct_option")
        if q.get("type") == "mcq":
            letters = [o.get("label") for o in q.get("options") or []]
            if opt is None:
                _add_flag(a, "answer_mismatch", f"[check] question {a['label']} is multiple choice but the key gives no letter")
            elif letters and opt not in letters:
                _add_flag(a, "answer_mismatch", f"[check] key answer {opt} is not one of the options {''.join(letters)}")
        elif opt is not None:
            _add_flag(a, "answer_mismatch", f"[check] key gives option {opt} but question {a['label']} is not multiple choice")


def apply_issues_as_notes(items: List[Dict[str, Any]], issues: List[Issue], kind: str,
                          set_low_confidence: bool) -> List[Issue]:
    """Attach remaining issues to the items they name. Returns issues that matched no item."""
    by_label: Dict[str, List[Dict[str, Any]]] = {}
    for it in items:
        by_label.setdefault(it["label"], []).append(it)
    unmatched = []
    for iss in issues:
        targets = by_label.get(iss.label or "", []) if iss.kind == kind else []
        if not targets:
            unmatched.append(iss)
            continue
        for it in targets:
            note = f"[check] {iss.message}"
            it["notes"] = f"{it['notes']}; {note}" if it.get("notes") else note
            if set_low_confidence and iss.fatal:
                it["confidence"] = "low"
    return unmatched


# =============================================================================================
# Cross-chunk reconciliation
# =============================================================================================

_CONF_RANK = {"low": 0, "medium": 1, "high": 2}


def _merge_regions(a: List[Dict[str, Any]], b: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = list(a)
    for r in b:
        if r not in out:
            out.append(r)
    return out


def _append_note(item: Dict[str, Any], note: str) -> None:
    item["notes"] = f"{item['notes']}; {note}" if item.get("notes") else note


def reconcile(chunks: List[Dict[str, Any]]) -> None:
    """Make chunk contents globally consistent, in place (chunks in document order).

    * A (paper, label) emitted by two chunks (a continuation the classifier missed) is merged
      into the first chunk, so each question / answer appears exactly once.
    * Nodes whose parent exists in no chunk are flagged low confidence.
    * Figure ids are made unique across the document.
    """
    first_q: Dict[Tuple[Optional[str], str], Dict[str, Any]] = {}
    for ch in chunks:
        keep = []
        for q in ch["questions"]:
            key = (q.get("paper"), q["label"])
            if key not in first_q:
                first_q[key] = q
                keep.append(q)
                continue
            base = first_q[key]
            base["regions"] = _merge_regions(base.get("regions", []), q.get("regions", []))
            if "full_regions" in base or "full_regions" in q:
                base["full_regions"] = _merge_regions(base.get("full_regions", []), q.get("full_regions", []))
            if q["stem"] and q["stem"] not in base["stem"]:
                base["stem"] = f"{base['stem']}\n\n{q['stem']}".strip()
            base["options"] = base["options"] or q["options"]
            base["marks"] = base["marks"] if base["marks"] is not None else q["marks"]
            base["topics"] = base["topics"] or q["topics"]
            ids = {f["id"] for f in base["figures"]}
            base["figures"] += [f for f in q["figures"] if f["id"] not in ids]
            base["has_handwriting"] = base["has_handwriting"] or q["has_handwriting"]
            base["review_flags"] = base.get("review_flags", []) + [
                f for f in q.get("review_flags", []) if f not in base.get("review_flags", [])]
            if _CONF_RANK.get(q["confidence"], 1) < _CONF_RANK.get(base["confidence"], 1):
                base["confidence"] = q["confidence"]
            _append_note(base, f"merged with a continuation extracted in chunk {ch['chunk']}")
            if q.get("notes"):
                _append_note(base, q["notes"])
        ch["questions"] = keep

    for q in first_q.values():
        par = q.get("parent_label")
        if par and (q.get("paper"), par) not in first_q:
            q["confidence"] = "low"
            _append_note(q, f"[check] parent {par} was not extracted in any chunk")

    used: Set[str] = set()
    for ch in chunks:
        for q in ch["questions"]:
            for f in q["figures"]:
                fid = f["id"]
                if fid in used:
                    base_id = f"{fid}-{_paper_slug(q.get('paper'))}" if q.get("paper") else fid
                    fid, n = base_id, 2
                    while fid in used:
                        fid = f"{base_id}-{n}"
                        n += 1
                    f["id"] = fid
                used.add(fid)

    first_a: Dict[Tuple[Optional[str], str], Dict[str, Any]] = {}
    for ch in chunks:
        keep = []
        for a in ch["answers"]:
            key = (a.get("paper"), a["label"])
            if key not in first_a:
                first_a[key] = a
                keep.append(a)
                continue
            base = first_a[key]
            if a.get("answer_text") and a["answer_text"] not in (base.get("answer_text") or ""):
                base["answer_text"] = f"{base['answer_text']}\n{a['answer_text']}" if base.get("answer_text") else a["answer_text"]
            base["correct_option"] = base["correct_option"] or a["correct_option"]
            base["regions"] = _merge_regions(base["regions"], a["regions"])
            base["review_flags"] = base.get("review_flags", []) + [
                f for f in a.get("review_flags", []) if f not in base.get("review_flags", [])]
            if _CONF_RANK.get(a.get("confidence"), 1) < _CONF_RANK.get(base.get("confidence"), 1):
                base["confidence"] = a["confidence"]
            _append_note(base, f"merged with a continuation extracted in chunk {ch['chunk']}")
        ch["answers"] = keep


def apply_document_rules(chunks: List[Dict[str, Any]], infos: List[PageInfo]) -> None:
    """Rules that need the whole document, in place: answers vs questions (answer_mismatch) and
    choice groups (papers[].choice_groups plus choice_group on member questions)."""
    questions = [q for ch in chunks for q in ch["questions"]]
    answers = [a for ch in chunks for a in ch["answers"]]
    cross_check_answers(questions, answers)

    groups, members = choice_groups(infos, questions)
    declared: Set[str] = set()
    for ch in chunks:
        for rec in ch["papers"]:
            rec["choice_groups"] = groups.get(rec["paper"], [])
            declared.add(rec["paper"])
    for q in questions:
        gid = members.get((q.get("paper"), q["label"]))
        if gid is None:
            continue
        if q["paper"] in declared:
            q["choice_group"] = gid
        else:
            _append_note(q, f"[check] optional question (choice group {gid}) but no cover page declares the group")


# =============================================================================================
# Disk cache
# =============================================================================================

class ResponseCache:
    """One JSON file per request: <cache_dir>/<key[:2]>/<key>.json."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / key[:2] / f"{key}.json"

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        p = self._path(key)
        if not p.exists():
            return None
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)["response"]
        except (OSError, ValueError, KeyError):
            log.warning("ignoring unreadable cache entry %s", p)
            return None

    def put(self, key: str, meta: Dict[str, Any], response: Dict[str, Any]) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"key": key, "meta": meta, "response": response}, f, ensure_ascii=False)
        os.replace(tmp, p)


def _redact_images(obj: Any) -> Any:
    """Copy of a request with base64 image data replaced by its sha256 (for cache keys/meta)."""
    if isinstance(obj, dict):
        if obj.get("type") == "base64" and isinstance(obj.get("data"), str):
            return {"type": "base64", "media_type": obj.get("media_type"),
                    "sha256": hashlib.sha256(obj["data"].encode("ascii")).hexdigest()}
        return {k: _redact_images(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact_images(v) for v in obj]
    return obj


def request_cache_key(kwargs: Dict[str, Any]) -> str:
    payload = {"prompt_version": prompts.PROMPT_VERSION, "request": _redact_images(kwargs)}
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# =============================================================================================
# Images
# =============================================================================================

@dataclass
class PreparedImage:
    page_index: int
    data: bytes
    media_type: str
    width: int
    height: int

    def block(self) -> Dict[str, Any]:
        return {"type": "image", "source": {"type": "base64", "media_type": self.media_type,
                                            "data": base64.standard_b64encode(self.data).decode("ascii")}}


def _fit_scale(w: float, h: float, max_long: int, max_pixels: int) -> float:
    return min(max_long / max(w, h), math.sqrt(max_pixels / (w * h)))


def _encode(img: "Any") -> Tuple[bytes, str]:
    from PIL import Image  # noqa: F401  (pillow is a project dependency)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    if buf.tell() <= MAX_IMAGE_BYTES:
        return buf.getvalue(), "image/png"
    gray = img.convert("L")
    buf = io.BytesIO()
    gray.save(buf, format="PNG", optimize=True)
    if buf.tell() <= MAX_IMAGE_BYTES:
        return buf.getvalue(), "image/png"
    for q in (92, 85, 75):
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=q)
        if buf.tell() <= MAX_IMAGE_BYTES:
            return buf.getvalue(), "image/jpeg"
    raise ClaudeExtractorError("page image too large to send even as JPEG")


def _load_scaled(path: Path, max_long: int, max_pixels: int, grayscale: bool) -> PreparedImageData:
    from PIL import Image

    with Image.open(path) as im:
        im.load()
        if grayscale:
            img = im.convert("L")
        else:
            img = im.copy() if im.mode in ("RGB", "L") else im.convert("RGB")
    w, h = img.size
    s = _fit_scale(w, h, max_long, max_pixels)
    if s < 1.0:
        img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    data, mt = _encode(img)
    return PreparedImageData(data, mt, img.size[0], img.size[1])


@dataclass
class PreparedImageData:
    data: bytes
    media_type: str
    width: int
    height: int


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# =============================================================================================
# The extractor
# =============================================================================================

@dataclass
class _Outcome:
    plan: ChunkPlan
    questions: List[Dict[str, Any]] = field(default_factory=list)
    answers: List[Dict[str, Any]] = field(default_factory=list)
    served_models: Set[str] = field(default_factory=set)
    issues: List[str] = field(default_factory=list)
    failed: Optional[str] = None
    attempts: int = 0
    issues_unmatched: List[str] = field(default_factory=list)


class ClaudeExtractor:
    """Extractor backend that reads page images with the Claude API (see module docstring)."""

    def __init__(
        self,
        model: Optional[str] = None,
        cache_dir: Path = Path("data/cache/claude"),
        *,
        classifier_model: Optional[str] = None,
        client: Any = None,
        effort: str = "high",
        classifier_effort: str = "low",
        max_pages_per_chunk: int = 5,
        classify_batch_size: int = 4,
        max_concurrency: int = 4,
        image_mode: str = "hires",
        max_tokens: int = 64000,
        use_fallbacks: bool = True,
        taxonomy_path: Optional[Path] = None,
    ):
        self.model = model or os.environ.get("INGEST_CLAUDE_MODEL") or DEFAULT_MODEL
        self.classifier_model = (classifier_model or os.environ.get("INGEST_CLAUDE_CLASSIFIER_MODEL")
                                 or DEFAULT_CLASSIFIER_MODEL)
        self.name = f"claude-api:{self.model}"
        self.cache_dir = Path(cache_dir)
        self.cache = ResponseCache(self.cache_dir)
        self.effort = effort
        self.classifier_effort = classifier_effort
        self.max_pages_per_chunk = max_pages_per_chunk
        self.classify_batch_size = classify_batch_size
        self.max_concurrency = max(1, max_concurrency)
        if image_mode not in ("hires", "provided"):
            raise ValueError("image_mode must be 'hires' or 'provided'")
        self.image_mode = image_mode
        self.max_tokens = max_tokens
        self.use_fallbacks = use_fallbacks
        self.taxonomy = prompts.load_taxonomy(taxonomy_path)
        self.topic_codes = prompts.subtopic_codes(self.taxonomy)
        self._client = client
        self._client_lock = threading.Lock()
        self._images: Dict[Tuple[int, str], PreparedImage] = {}
        self._images_lock = threading.Lock()
        self._pdf_ok: Optional[bool] = None
        self._stats_lock = threading.Lock()
        self.last_run_stats: Dict[str, Any] = {}

    # ----------------------------------------------------------------------------- public API

    def extract(self, doc: DocumentInput, out_dir: Path) -> List[Path]:
        out_dir = Path(out_dir)
        self._images = {}
        self._pdf_ok = None
        self.last_run_stats = {"api_calls": 0, "cache_hits": 0, "usage": {}, "retries": 0,
                               "fallback_served": [], "failed_chunks": [], "prompt_version": prompts.PROMPT_VERSION}
        pages_by_index = {p.page_index: p for p in doc.pages}
        if not pages_by_index:
            raise ClaudeExtractorError(f"{doc.document_id}: no pages to extract")

        page_infos = fill_forward(self._classify(doc))
        plans = plan_chunks(page_infos, self.max_pages_per_chunk)
        info_by_index = {p.page_index: p for p in page_infos}
        log.info("%s: %d pages -> %d chunks (%s)", doc.document_id, len(page_infos), len(plans),
                 ", ".join(f"{p.name}:{p.page_indices[0]}-{p.page_indices[-1]}" for p in plans))

        qplans = [p for p in plans if p.kind == "questions"]
        outcomes: Dict[str, _Outcome] = {}
        for o in self._parallel(lambda p: self._run_questions(doc, p), qplans):
            outcomes[o.plan.name] = o

        known: Dict[str, Set[str]] = {}
        for o in outcomes.values():
            for q in o.questions:
                if q.get("paper"):
                    known.setdefault(q["paper"], set()).add(q["label"])
        aplans = [p for p in plans if p.kind == "answers"]
        for o in self._parallel(lambda p: self._run_answers(doc, p, known), aplans):
            outcomes[o.plan.name] = o

        chunks = []
        for plan in plans:
            o = outcomes.get(plan.name) or _Outcome(plan)
            chunks.append(self._chunk_json(doc, plan, o, info_by_index))
        reconcile(chunks)
        apply_document_rules(chunks, page_infos)

        paths = self._write(chunks, out_dir)
        self._write_run_summary(doc, page_infos, plans, outcomes)
        stats = self.last_run_stats
        log.info("%s: wrote %d chunks; %d API calls, %d cache hits, %d retries, est. cost $%.2f",
                 doc.document_id, len(paths), stats["api_calls"], stats["cache_hits"], stats["retries"],
                 stats.get("estimated_cost_usd", 0.0))
        failed = [o.plan.name for o in outcomes.values() if o.failed]
        if failed:
            stats["failed_chunks"] = failed
            raise ExtractionIncompleteError(
                f"{doc.document_id}: chunks {', '.join(failed)} failed at the API and were written without "
                "content (see notes). Re-run to retry them; completed requests come from the cache.", paths)
        return paths

    # ----------------------------------------------------------------------------- pass 1

    def _classify(self, doc: DocumentInput) -> List[PageInfo]:
        indices = sorted(p.page_index for p in doc.pages)
        batches = [indices[i:i + self.classify_batch_size] for i in range(0, len(indices), self.classify_batch_size)]
        system = prompts.CLASSIFY_SYSTEM
        schema = prompts.classify_schema()

        def run(batch: List[int]) -> List[PageInfo]:
            content: List[Dict[str, Any]] = []
            for i in batch:
                img = self._image(doc, i, "classify")
                content.append({"type": "text", "text": f"page_index {i}"})
                content.append(img.block())
            content.append({"type": "text", "text": prompts.classify_user_text(batch)})

            def validate(data: Dict[str, Any]) -> Tuple[List[PageInfo], List[Issue]]:
                got = {p.get("page_index"): p for p in data.get("pages") or []}
                issues = [Issue("chunk", None, f"no entry for page_index {i}") for i in batch if i not in got]
                infos = []
                for i in batch:
                    p = got.get(i)
                    if p is None:
                        infos.append(PageInfo(page_index=i, page_type="other", notes="classification missing"))
                        continue
                    infos.append(page_info_from_model(i, p))
                return infos, issues

            result, issues, _, failed, _ = self._structured(
                model=self.classifier_model, effort=self.classifier_effort, max_tokens=16000,
                system=system, schema=schema, content=content, validate=validate)
            if failed:
                raise ClaudeExtractorError(f"{doc.document_id}: page classification failed for pages {batch}: {failed}")
            for iss in issues:
                log.warning("%s classify %s: %s", doc.document_id, batch, iss.text())
            return result

        out: List[PageInfo] = []
        for infos in self._parallel(run, batches):
            out.extend(infos)
        return sorted(out, key=lambda p: p.page_index)

    # ----------------------------------------------------------------------------- pass 2

    def _page_content(self, doc: DocumentInput, plan: ChunkPlan) -> Tuple[List[Dict[str, Any]], Dict[int, Tuple[int, int]]]:
        content: List[Dict[str, Any]] = []
        sizes: Dict[int, Tuple[int, int]] = {}
        for i in plan.page_indices:
            img = self._image(doc, i, "extract")
            sizes[i] = (img.width, img.height)
            content.append({"type": "text", "text": f"page_index {i} ({img.width}×{img.height} px)"})
            content.append(img.block())
        return content, sizes

    def _run_questions(self, doc: DocumentInput, plan: ChunkPlan) -> _Outcome:
        out = _Outcome(plan)
        content, sizes = self._page_content(doc, plan)
        content.append({"type": "text", "text": prompts.questions_user_text(
            document_id=doc.document_id, paper=plan.paper, page_indices=plan.page_indices,
            expected_starts=plan.expected_starts, previous_question=plan.previous_question,
            section=plan.section_at_start)})
        topic_set = set(self.topic_codes)

        def validate(data: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Issue]]:
            return convert_questions(data, sizes, plan, topic_set)

        try:
            result, issues, served, failed, attempts = self._structured(
                model=self.model, effort=self.effort, max_tokens=self.max_tokens,
                system=prompts.questions_system(self.taxonomy), schema=prompts.questions_schema(self.topic_codes),
                content=content, validate=validate)
        except Exception as e:  # noqa: BLE001 - narrowed by _api_failure
            out.failed = _api_failure(e)
            log.error("%s %s: %s", doc.document_id, plan.name, out.failed)
            return out
        out.served_models, out.failed, out.attempts = served, failed, attempts
        if result is not None:
            out.questions = result
            leftover = apply_issues_as_notes(out.questions, issues, "question", set_low_confidence=True)
            out.issues = [i.text() for i in issues]
            out.issues_unmatched = [i.text() for i in leftover]
            for i in issues:
                (log.warning if i.fatal else log.info)("%s %s: %s", doc.document_id, plan.name, i.text())
        return out

    def _run_answers(self, doc: DocumentInput, plan: ChunkPlan, known: Dict[str, Set[str]]) -> _Outcome:
        out = _Outcome(plan)
        content, sizes = self._page_content(doc, plan)
        known_sorted = {k: sorted(v, key=label_sort_key) for k, v in known.items()}
        content.append({"type": "text", "text": prompts.answers_user_text(
            document_id=doc.document_id, page_indices=plan.page_indices, known_labels=known_sorted,
            previous_question=plan.previous_question)})

        def validate(data: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Issue]]:
            return convert_answers(data, sizes, known)

        try:
            result, issues, served, failed, attempts = self._structured(
                model=self.model, effort=self.effort, max_tokens=self.max_tokens,
                system=prompts.answers_system(), schema=prompts.answers_schema(),
                content=content, validate=validate)
        except Exception as e:  # noqa: BLE001 - narrowed by _api_failure
            out.failed = _api_failure(e)
            log.error("%s %s: %s", doc.document_id, plan.name, out.failed)
            return out
        out.served_models, out.failed, out.attempts = served, failed, attempts
        if result is not None:
            out.answers = result
            leftover = apply_issues_as_notes(out.answers, issues, "answer", set_low_confidence=True)
            out.issues = [i.text() for i in issues]
            out.issues_unmatched = [i.text() for i in leftover]
            for i in issues:
                (log.warning if i.fatal else log.info)("%s %s: %s", doc.document_id, plan.name, i.text())
        return out

    # ----------------------------------------------------------------------------- requests

    def _structured(
        self, *, model: str, effort: str, max_tokens: int, system: str, schema: Dict[str, Any],
        content: List[Dict[str, Any]], validate: Callable[[Dict[str, Any]], Tuple[Any, List[Issue]]],
    ) -> Tuple[Any, List[Issue], Set[str], Optional[str], int]:
        """Request -> parse -> validate, with one feedback retry.

        Returns (result, issues, served_models, failure, attempts). result is the best converted
        output (None only when nothing parseable came back); failure is set when no usable
        response was obtained.
        """
        # Cache breakpoint at the end of the page content: the retry turn reuses that prefix.
        content = [dict(b) for b in content]
        content[-1] = {**content[-1], "cache_control": {"type": "ephemeral"}}
        messages: List[Dict[str, Any]] = [{"role": "user", "content": content}]
        served: Set[str] = set()
        best: Optional[Tuple[Any, List[Issue]]] = None
        failure: Optional[str] = None
        attempts = 0
        budget = max_tokens
        for attempt in range(2):
            attempts += 1
            kwargs = self._request_kwargs(model, effort, budget, system, schema, messages)
            resp = self._call(kwargs)
            if resp.get("model"):
                served.add(resp["model"])
            stop = resp.get("stop_reason")
            if stop == "refusal":
                details = resp.get("stop_details") or {}
                failure = f"refused (category {details.get('category')})"
                break
            if stop == "max_tokens":
                failure = f"output exceeded max_tokens={budget}"
                if attempt == 0 and budget < 128000:
                    budget = 128000
                    with self._stats_lock:
                        self.last_run_stats["retries"] = self.last_run_stats.get("retries", 0) + 1
                    continue
                break
            text = _final_text(resp)
            try:
                data = json.loads(text)
                if not isinstance(data, dict):
                    raise ValueError("top level is not an object")
            except ValueError as e:
                failure = f"unparseable JSON ({e})"
                issues = [Issue("chunk", None, f"the response was not valid JSON: {e}")]
            else:
                failure = None
                result, issues = validate(data)
                if best is None or _n_fatal(issues) <= _n_fatal(best[1]):
                    best = (result, issues)
                if not _n_fatal(issues):
                    break
            if attempt == 0:
                with self._stats_lock:
                    self.last_run_stats["retries"] = self.last_run_stats.get("retries", 0) + 1
                messages = messages + [
                    {"role": "assistant", "content": _echo_content(resp)},
                    {"role": "user", "content": [{"type": "text", "text": prompts.retry_feedback_text(
                        [i.text() for i in issues if i.fatal])}]},
                ]
        if best is not None:
            return best[0], best[1], served, None, attempts
        return None, [], served, failure or "no response", attempts

    def _request_kwargs(self, model: str, effort: str, max_tokens: int, system: str,
                        schema: Dict[str, Any], messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        }
        if self.use_fallbacks and model.startswith(_FALLBACK_MODELS):
            kwargs["betas"] = [_FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
        return kwargs

    def _call(self, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        key = request_cache_key(kwargs)
        cached = self.cache.get(key)
        if cached is not None:
            with self._stats_lock:
                self.last_run_stats["cache_hits"] += 1
            return cached
        client = self._get_client()
        with client.beta.messages.stream(**kwargs) as stream:
            message = stream.get_final_message()
        resp = message.to_dict(mode="json") if hasattr(message, "to_dict") else dict(message)
        self._record_usage(resp)
        if resp.get("stop_reason") in ("end_turn", "stop_sequence"):
            meta = {"model": kwargs["model"], "prompt_version": prompts.PROMPT_VERSION,
                    "request": _redact_images({k: v for k, v in kwargs.items() if k != "system"})}
            self.cache.put(key, meta, resp)
        if resp.get("model") and resp["model"] != kwargs["model"]:
            log.warning("request for %s was served by fallback model %s", kwargs["model"], resp["model"])
            with self._stats_lock:
                self.last_run_stats["fallback_served"].append(resp["model"])
        return resp

    def _get_client(self) -> Any:
        with self._client_lock:
            if self._client is None:
                if not any(os.environ.get(v) for v in (
                        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_IDENTITY_TOKEN",
                        "ANTHROPIC_IDENTITY_TOKEN_FILE")):
                    raise ClaudeExtractorError(
                        "ANTHROPIC_API_KEY is not set. The Claude extractor needs an API key for requests that are "
                        "not in the cache (cache dir: %s). Export ANTHROPIC_API_KEY (ANTHROPIC_BASE_URL is honoured "
                        "if set), or use the 'files' extractor for precomputed JSON." % self.cache_dir)
                import anthropic

                # The SDK retries 408/409/429/5xx and connection errors with exponential backoff
                # (honouring retry-after); a generous retry count rides out rate limits.
                self._client = anthropic.Anthropic(max_retries=8, timeout=900.0)
            return self._client

    def _record_usage(self, resp: Dict[str, Any]) -> None:
        usage = resp.get("usage") or {}
        model = resp.get("model") or "unknown"
        with self._stats_lock:
            self.last_run_stats["api_calls"] += 1
            u = self.last_run_stats["usage"].setdefault(model, {
                "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0})
            for k in u:
                u[k] += int(usage.get(k) or 0)
            self.last_run_stats["estimated_cost_usd"] = round(estimate_cost(self.last_run_stats["usage"]), 4)

    def _parallel(self, fn: Callable[[Any], Any], items: List[Any]) -> List[Any]:
        if not items:
            return []
        if self.max_concurrency == 1 or len(items) == 1:
            return [fn(x) for x in items]
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.max_concurrency) as pool:
            return list(pool.map(fn, items))

    # ----------------------------------------------------------------------------- images

    def _image(self, doc: DocumentInput, page_index: int, purpose: str) -> PreparedImage:
        key = (page_index, purpose)
        with self._images_lock:
            if key in self._images:
                return self._images[key]
        page = next(p for p in doc.pages if p.page_index == page_index)
        if purpose == "classify":
            d = _load_scaled(page.path, CLASSIFY_MAX_LONG_EDGE, CLASSIFY_MAX_PIXELS, grayscale=True)
        else:
            d = None
            if self.image_mode == "hires":
                d = self._render_from_pdf(doc, page)
            if d is None:
                d = _load_scaled(page.path, HIRES_MAX_LONG_EDGE, HIRES_MAX_PIXELS, grayscale=False)
        img = PreparedImage(page_index, d.data, d.media_type, d.width, d.height)
        with self._images_lock:
            self._images[key] = img
        return img

    def _render_from_pdf(self, doc: DocumentInput, page: PageImage) -> Optional[PreparedImageData]:
        """Re-render the page from the source PDF at the model's full resolution (~190 dpi for
        A4, vs the ~150 dpi review PNG), which keeps small subscripts and charges legible.
        Falls back to the provided PNG when the PDF or PyMuPDF is unavailable."""
        pdf_path = self._source_pdf(doc)
        if pdf_path is None:
            return None
        try:
            import fitz  # PyMuPDF
            from PIL import Image

            with fitz.open(str(pdf_path)) as pdf:
                pg = pdf[page.page_index]
                w, h = pg.rect.width, pg.rect.height
                # slightly under the cap: PyMuPDF rounds the pixmap size up
                s = _fit_scale(w, h, HIRES_MAX_LONG_EDGE, HIRES_MAX_PIXELS) * 0.995
                pix = pg.get_pixmap(matrix=fitz.Matrix(s, s), alpha=False)
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            data, mt = _encode(img)
            return PreparedImageData(data, mt, img.size[0], img.size[1])
        except Exception as e:  # noqa: BLE001 - any render problem means "use the PNG"
            log.warning("high-res render of page %d failed (%s); using provided PNG", page.page_index, e)
            return None

    def _source_pdf(self, doc: DocumentInput) -> Optional[Path]:
        if self._pdf_ok is False:
            return None
        candidates = [Path(doc.source_pdf), Path(__file__).resolve().parents[2] / doc.source_pdf]
        path = next((c for c in candidates if c.is_file()), None)
        ok = path is not None and (not doc.source_sha256 or _sha256_file(path) == doc.source_sha256)
        if not ok:
            log.info("source PDF %s not found or hash differs; sending provided page PNGs", doc.source_pdf)
        self._pdf_ok = ok
        return path if ok else None

    # ----------------------------------------------------------------------------- output

    def _chunk_json(self, doc: DocumentInput, plan: ChunkPlan, o: _Outcome,
                    info: Dict[int, PageInfo]) -> Dict[str, Any]:
        hand_pages: Set[int] = set()
        for item in o.questions:
            if item.get("has_handwriting"):
                hand_pages.update(r["page_index"] for r in item.get("regions", []))
        pages = []
        for i in plan.page_indices:
            p = info[i]
            pages.append({
                "page_index": i,
                "paper": p.paper,
                "printed_page_number": p.printed_page_number,
                "page_type": p.page_type,
                "has_handwriting": p.has_handwriting or i in hand_pages,
                "notes": p.notes,
            })
        chunk_notes: List[str] = []
        if o.failed:
            chunk_notes.append(f"[extraction failed] {o.failed}")
        chunk_notes += [f"[check] {t}" for t in o.issues_unmatched]
        if chunk_notes and pages:
            pages[0]["notes"] = "; ".join([n for n in [pages[0]["notes"]] + chunk_notes if n])

        papers = []
        if plan.kind == "misc":
            seen: Set[Optional[str]] = set()
            for i in plan.page_indices:
                p = info[i]
                if p.page_type != "cover" or not p.cover:
                    continue
                c = p.cover
                paper = p.paper or c.get("paper") or infer_paper_from_code(c.get("paper_code"))
                if paper in seen:
                    continue
                seen.add(paper)
                papers.append({
                    "paper": paper,
                    "paper_code": c.get("paper_code"),
                    "school": c.get("school"),
                    "exam": c.get("exam"),
                    "year": c.get("year"),
                    "level": c.get("level"),
                    "subject": c.get("subject"),
                    "date": c.get("date"),
                    "duration_minutes": c.get("duration_minutes"),
                    "total_marks": c.get("total_marks"),
                    "instructions": clean_text(c.get("instructions")) or None,
                    "choice_groups": [],   # filled in by apply_document_rules
                })

        served = sorted(m for m in o.served_models if m != self.model)
        extracted_by = self.name
        if served:
            extracted_by = f"claude-api:{served[0]}"
            if pages:
                pages[0]["notes"] = "; ".join(n for n in [pages[0]["notes"], f"served by fallback model {served[0]}"] if n)
        return {
            "contract_version": CONTRACT_VERSION,
            "document_id": doc.document_id,
            "source_pdf": doc.source_pdf,
            "chunk": plan.name,
            "extracted_by": extracted_by,
            "pages": pages,
            "papers": papers,
            "questions": o.questions,
            "answers": o.answers,
        }

    def _write(self, chunks: List[Dict[str, Any]], out_dir: Path) -> List[Path]:
        out_dir.mkdir(parents=True, exist_ok=True)
        # Remove this extractor's previous chunk files: the chunk plan can change between runs
        # (new prompt, better classification), and stale chunks would duplicate questions.
        for old in out_dir.glob("*.json"):
            if old.name.startswith("."):
                continue  # CLI bookkeeping such as .incomplete.json
            try:
                with open(old, encoding="utf-8") as f:
                    by = json.load(f).get("extracted_by", "")
            except (OSError, ValueError, AttributeError):
                continue
            if isinstance(by, str) and by.startswith("claude-api:"):
                old.unlink()
        paths = []
        for ch in chunks:
            p = out_dir / f"{ch['chunk']}.json"
            with open(p, "w", encoding="utf-8") as f:
                json.dump(ch, f, ensure_ascii=False, indent=2)
                f.write("\n")
            paths.append(p)
        return paths

    def _write_run_summary(self, doc: DocumentInput, infos: List[PageInfo], plans: List[ChunkPlan],
                           outcomes: Dict[str, _Outcome]) -> None:
        summary = {
            "document_id": doc.document_id,
            "model": self.model,
            "classifier_model": self.classifier_model,
            "stats": self.last_run_stats,
            "classification": [asdict(p) for p in infos],
            "plan": [asdict(p) for p in plans],
            "chunks": {name: {"attempts": o.attempts, "failed": o.failed, "issues": o.issues,
                              "served_models": sorted(o.served_models)} for name, o in outcomes.items()},
        }
        p = self.cache_dir / "runs" / f"{doc.document_id}.json"
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                json.dump(summary, f, ensure_ascii=False, indent=2)
        except OSError as e:
            log.warning("could not write run summary %s: %s", p, e)


# =============================================================================================
# Response helpers
# =============================================================================================

def _final_text(resp: Dict[str, Any]) -> str:
    texts = [b.get("text", "") for b in resp.get("content") or [] if b.get("type") == "text"]
    return texts[-1] if texts else ""


def _echo_content(resp: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The assistant turn to replay for the feedback retry.

    Thinking blocks are passed back unchanged (preserved-thinking models require that); after a
    server-side fallback, only text is replayed, since the blocks before the switch belong to
    another model.
    """
    blocks = resp.get("content") or []
    had_fallback = any(b.get("type") == "fallback" for b in blocks)
    out: List[Dict[str, Any]] = []
    for b in blocks:
        t = b.get("type")
        if t == "text":
            out.append({"type": "text", "text": b.get("text", "")})
        elif t == "thinking" and not had_fallback:
            out.append({"type": "thinking", "thinking": b.get("thinking", ""), "signature": b.get("signature", "")})
        elif t == "redacted_thinking" and not had_fallback:
            out.append({"type": "redacted_thinking", "data": b.get("data", "")})
    if not any(b["type"] == "text" for b in out):
        out.append({"type": "text", "text": _final_text(resp) or "{}"})
    return out


def _api_failure(e: BaseException) -> str:
    """Describe a per-chunk API failure, or re-raise errors that no retry can fix.

    Rate limits, overload and server errors were already retried by the SDK; if they still
    fail, the chunk is written empty with a note and the run raises ExtractionIncompleteError
    at the end, so a re-run retries only that chunk. Credentials, permissions, unknown models
    and non-API exceptions (bugs) propagate immediately.
    """
    try:
        import anthropic
    except ImportError:  # pragma: no cover
        raise e
    if isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.NotFoundError)):
        raise e
    if isinstance(e, anthropic.APIError):
        return f"{type(e).__name__}: {e}"
    raise e


def _n_fatal(issues: Iterable[Issue]) -> int:
    return sum(1 for i in issues if i.fatal)


def estimate_cost(usage_by_model: Dict[str, Dict[str, int]]) -> float:
    total = 0.0
    for model, u in usage_by_model.items():
        price = next((v for k, v in _PRICES.items() if model == k or model.startswith(k + "-")), None)
        if price is None:
            continue
        pin, pout = price
        pread = _CACHE_READ.get(model, pin * 0.1)
        total += (u.get("input_tokens", 0) * pin + u.get("output_tokens", 0) * pout
                  + u.get("cache_creation_input_tokens", 0) * pin * 1.25
                  + u.get("cache_read_input_tokens", 0) * pread) / 1e6
    return total
