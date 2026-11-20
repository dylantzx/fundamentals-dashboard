"""Prompts and JSON schemas for the Claude API extractor (ingest/extract/claude.py).

Three model-facing tasks:

* classify  - cheap per-page triage: page type, paper, printed page number, which top-level
              questions start on the page, whether the page top continues the previous page,
              cover metadata, and "answer N of these questions" instructions (choice groups).
* questions - full transcription of a chunk of consecutive question pages into contract
              question nodes (tree, stems, options, marks, regions, figures, topics).
* answers   - transcription of answer-key / mark-scheme pages into contract answers.

Prompts are written for any O-Level-style chemistry paper (SEAB papers, any school's prelims):
nothing here knows page indices, question counts or one school's layout. Per-document facts
(which pages, which paper, which questions a pre-scan saw) go in the user message, never in the
cached system prompt.

Bounding boxes: the model returns integer pixel coordinates in the image it was shown (current
high-resolution vision models map coordinates 1:1 to image pixels). The extractor converts them
to the contract's normalised 0..1 boxes, so the model never does that arithmetic.

Bump PROMPT_VERSION whenever a prompt or schema here changes meaning. The cache key also hashes
the full request (system text, schema, images), so an unbumped edit still misses the cache, but
the version makes intentional re-extraction explicit and visible in logs.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

PROMPT_VERSION = "2026-11-20.3-contract-1.1"

TAXONOMY_PATH = Path(__file__).resolve().parents[2] / "taxonomy" / "o_level_chemistry_6092.json"

PAGE_TYPES = ["cover", "questions", "answer_key", "data_sheet", "blank", "other"]
PAPERS = [f"P{n}" for n in range(1, 10)]
QUESTION_TYPES = ["mcq", "structured", "context"]
ANSWER_SPACES = ["lines", "working", "drawing", "table", "graph", "none"]
FIGURE_KINDS = ["diagram", "graph", "table", "structure", "photo", "apparatus"]
CONFIDENCE = ["high", "medium", "low"]
OPTION_LABELS = ["A", "B", "C", "D"]
REVIEW_FLAGS = ["source_defect", "illegible", "inferred", "answer_mismatch"]


# --------------------------------------------------------------------------------------------
# Taxonomy
# --------------------------------------------------------------------------------------------

def load_taxonomy(path: Optional[Path] = None) -> Dict[str, Any]:
    with open(path or TAXONOMY_PATH, encoding="utf-8") as f:
        return json.load(f)


def subtopic_codes(taxonomy: Dict[str, Any]) -> List[str]:
    return [s["code"] for t in taxonomy["topics"] for s in t["subtopics"]]


def taxonomy_listing(taxonomy: Dict[str, Any]) -> str:
    lines = []
    for t in taxonomy["topics"]:
        lines.append(f"{t['code']} {t['name']}")
        for s in t["subtopics"]:
            lines.append(f"  {s['code']} {s['name']}")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# Schema helpers (structured outputs: every object needs additionalProperties false and every
# property listed in required; optional values are expressed as nullable).
# --------------------------------------------------------------------------------------------

def _obj(props: Dict[str, Any]) -> Dict[str, Any]:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def _nullable(schema: Dict[str, Any]) -> Dict[str, Any]:
    return {"anyOf": [schema, {"type": "null"}]}


def _arr(items: Dict[str, Any]) -> Dict[str, Any]:
    return {"type": "array", "items": items}


_STR = {"type": "string"}
_INT = {"type": "integer"}
_BOOL = {"type": "boolean"}

_BOX = _obj({"x0": _INT, "y0": _INT, "x1": _INT, "y1": _INT})
_REGION = _obj({"page_index": _INT, "box": _BOX})
_FLAGS = _arr({"type": "string", "enum": REVIEW_FLAGS})


def classify_schema() -> Dict[str, Any]:
    # Structured outputs allow at most 16 union-typed (nullable) parameters per request, so
    # "not printed" is "" for strings and 0 for numbers here; the extractor maps both to null.
    paper_or_blank = {"type": "string", "enum": PAPERS + [""]}
    cover = _obj({
        "paper": paper_or_blank,
        "paper_code": _STR,
        "school": _STR,
        "exam": _STR,
        "year": _INT,
        "level": _STR,
        "subject": _STR,
        "date": _STR,
        "duration_minutes": _INT,
        "total_marks": _INT,
        "instructions": _STR,
    })
    page = _obj({
        "page_index": _INT,
        "page_type": {"type": "string", "enum": PAGE_TYPES},
        "paper": paper_or_blank,
        "printed_page_number": _STR,
        "section": _STR,
        "question_starts": _arr(_STR),
        "continues_previous": _BOOL,
        "has_handwriting": _BOOL,
        "cover": _nullable(cover),
        "choice_instructions": _arr(_obj({
            "group_id": _STR,
            "choose": _INT,
            "questions": _arr(_STR),
            "note": _STR,
        })),
        "notes": _STR,
    })
    return _obj({"pages": _arr(page)})


def count_unions(schema: Any) -> int:
    """Parameters using anyOf or type arrays (the API allows 16 per request)."""
    n = 0
    if isinstance(schema, dict):
        if "anyOf" in schema or isinstance(schema.get("type"), list):
            n += 1
        for v in schema.values():
            n += count_unions(v)
    elif isinstance(schema, list):
        n += sum(count_unions(v) for v in schema)
    return n


def count_optional(schema: Any) -> int:
    """Object properties not listed in required (the API allows 24 per request)."""
    n = 0
    if isinstance(schema, dict):
        if isinstance(schema.get("properties"), dict):
            n += len(set(schema["properties"]) - set(schema.get("required", [])))
        for v in schema.values():
            n += count_optional(v)
    elif isinstance(schema, list):
        n += sum(count_optional(v) for v in schema)
    return n


def questions_schema(topic_codes: List[str]) -> Dict[str, Any]:
    figure = _obj({
        "id": _STR,
        "page_index": _INT,
        "box": _BOX,
        "kind": {"type": "string", "enum": FIGURE_KINDS},
        "caption": _STR,
        "description": _STR,
    })
    option = _obj({"label": {"type": "string", "enum": OPTION_LABELS}, "text": _STR})
    question = _obj({
        "paper": _nullable({"type": "string", "enum": PAPERS}),
        "section": _nullable(_STR),
        "label": _STR,
        "parent_label": _nullable(_STR),
        "type": {"type": "string", "enum": QUESTION_TYPES},
        "stem": _STR,
        "options": _arr(option),
        "marks": _nullable(_INT),
        "regions": _arr(_REGION),
        "full_regions": _arr(_REGION),
        "answer_space": {"type": "string", "enum": ANSWER_SPACES},
        "figures": _arr(figure),
        "topics": _arr({"type": "string", "enum": topic_codes}),
        "has_handwriting": _BOOL,
        "confidence": {"type": "string", "enum": CONFIDENCE},
        "review_flags": _FLAGS,
        "notes": _STR,
    })
    return _obj({"questions": _arr(question)})


def answers_schema() -> Dict[str, Any]:
    answer = _obj({
        "paper": _nullable({"type": "string", "enum": PAPERS}),
        "label": _STR,
        "correct_option": _nullable({"type": "string", "enum": OPTION_LABELS}),
        "answer_text": _nullable(_STR),
        "marks": _nullable(_INT),
        "regions": _arr(_REGION),
        "confidence": {"type": "string", "enum": CONFIDENCE},
        "review_flags": _FLAGS,
        "notes": _STR,
    })
    return _obj({"answers": _arr(answer)})


# --------------------------------------------------------------------------------------------
# Shared text rules
# --------------------------------------------------------------------------------------------

_COORDINATES = """\
## Bounding boxes

Give every box as integer pixel coordinates in the page image exactly as you received it:
`x0, y0` is the top-left corner, `x1, y1` the bottom-right, origin at the image's top-left.
Each image is introduced by a line stating its page_index and its width × height in pixels.
Boxes are used to crop the original scan, so be generous rather than tight: include the
question number, every line of text, figures and the answer space, with a margin of about 1%
of the page. A box that cuts through a diagram or a line of text is a bug; extra white margin
is harmless (the pipeline trims crops to ink)."""

_TEXT_CONVENTIONS = """\
## Text conventions

- Write chemistry with Unicode, as printed: H₂O, CaCO₃, SO₄²⁻, Fe³⁺, Al₂(SO₄)₃, →, ⇌, ΔH,
  Eₐ, (aq), °C, cm³, dm³. Subscripts and charges matter: zoom in mentally on small print.
- Many scans render chlorine's lower-case l like a capital I ("HCI", "CI₂"). Chlorine is
  always Cl.
- Paragraph breaks are a blank line (\\n\\n). Bullet lists use "- ". Numbered statements
  ("1 ...", "2 ...") and stacked equation lines are separated by a single line break (\\n).
  No bold/italic markup.
- Transcribe tables as Markdown tables.
- Never transcribe page furniture: dotted answer lines, "[Turn over", page numbers, printer
  or school stamps and codes in margins, "[Total: n]" lines (use them only to check marks).
- Never transcribe handwriting. Scans may carry student answers, ticks, crosses, circled
  options, scores and teacher comments. Ignore them for content and flag them with
  has_handwriting: true on the affected node or page."""

_REVIEW_FLAGS = """## Flag problems, do not fix them

Anything flagged is held back from students until a teacher has checked it, so a flag is
cheap and a silent fix is not. Transcribe what is printed, add the matching review_flags and
explain in notes:
- "source_defect": the printed paper itself is broken, for example an options column printed
  blank, two identical options, a missing figure or a misnumbered part. Write "(blank in
  scan)" for anything printed empty; never substitute what it probably should say.
- "illegible": part of it could not be read (also set confidence "low").
- "inferred": you filled something in from context, chemistry or the mark scheme rather than
  reading it (say what you inferred).
- "answer_mismatch": an answer that disagrees with its question (answer keys only)."""


# --------------------------------------------------------------------------------------------
# Pass 1: page classification
# --------------------------------------------------------------------------------------------

CLASSIFY_SYSTEM = """\
You triage pages of scanned secondary-school chemistry examination documents (for example
Singapore-Cambridge O-Level papers or school preliminary examinations). A document can hold
one or more papers (Paper 1 is usually multiple choice, Paper 2 structured and free-response
questions), cover pages, data sheets such as a periodic table, blank pages, and answer keys or
mark schemes, in any order. Your output decides how pages are grouped for a later, detailed
transcription pass, so question boundaries matter more than anything else.

You receive a few consecutive page images, each introduced by a line with its page_index.
Return exactly one entry per page, with the same page_index.

Fields:
- page_type: "cover" (front page of a paper: title, candidate instructions, paper code);
  "questions" (any page carrying question content, including pages that only continue an
  earlier question); "answer_key" (answer grids, mark schemes, worked solutions);
  "data_sheet" (periodic table or reference data that is not part of a question); "blank"
  (empty, or "This page is intentionally left blank"); "other" (anything else).
- paper: "P1" to "P9". Use the paper code (for example 6092/01 is Paper 1 and 6092/02 is
  Paper 2), headings, headers and footers, or the question style. Use "" when the page
  itself gives no evidence (the pipeline carries the paper forward from earlier pages) and
  for answer-key pages that cover more than one paper.
- printed_page_number: the page number printed on the page, as a string, else "".
- section: a section letter whose heading begins on this page (for example "B" for
  "Section B"), else "".
- question_starts: the top-level question numbers whose number is printed on this page at the
  start of the question, in order, as strings ("7", "12"). Do not list sub-parts ((a), (ii)).
  Do not list a question that began on an earlier page. On answer-key pages, list the
  top-level question numbers whose answers begin on this page.
- continues_previous: true when the top of the page, before any new question number, carries
  on a question or answer from the previous page (for example it starts with a sub-part such
  as "(c)", with a table or figure, or with sentences belonging to the previous question).
  False when the page starts with a new question number, a heading, or is not a question
  page.
- has_handwriting: true when there are any handwritten marks.
- cover: for cover pages only, the metadata printed on the cover ("" for text and 0 for
  numbers that are not printed); otherwise null. date as YYYY-MM-DD when a full date is
  printed, duration in minutes, instructions as a short transcription of the candidate
  instructions.
- choice_instructions: instructions printed on this page (on a cover or under a section
  heading) that let candidates choose which questions to answer, for example "Section B:
  Answer one question from this section" gives {group_id: "B", choose: 1, questions: [],
  note: the instruction as printed}. group_id is the section letter when the choice covers a
  section, otherwise a short id such as "Q9-10". questions lists the top-level question
  numbers when the instruction names them ("Answer either Question 9 or Question 10"), else [].
  "Answer all questions" is not a choice. Use [] when there is none.
- notes: anything unusual, else "".
"""


def classify_user_text(page_indices: List[int]) -> str:
    idx = ", ".join(str(i) for i in page_indices)
    return (
        f"Classify these {len(page_indices)} pages (page_index {idx}). "
        "Return one entry per page in the same order."
    )


# --------------------------------------------------------------------------------------------
# Pass 2: question transcription
# --------------------------------------------------------------------------------------------

_QUESTIONS_SYSTEM_TEMPLATE = """\
You transcribe scanned chemistry examination pages into structured data for a question bank.
Students practise from your transcription and search it; they also see crops of the original
scan cut with your bounding boxes. Accurate text and complete boxes both matter. Papers come
from many schools and exam boards, so read the layout from the page rather than assuming one.

You receive a run of consecutive question pages from one paper. A note after the images says
which paper and pages they are and what a quick pre-scan saw; trust the pages over the note.

## Nodes and labels

Emit one node per question label printed on these pages, flattened into a list in reading
order. Labels are canonical: "7", "2(a)", "2(a)(ii)", "10(b)(iii)", with lower-case letters
and roman numerals in brackets and no spaces. Multiple-choice questions are just "1", "2", ...

Emit a node for every level that exists. Question 3 with parts (a) and (b), where (b) has (i)
and (ii), gives five nodes: 3, 3(a), 3(b), 3(b)(i), 3(b)(ii). parent_label is the label with
its last bracket removed ("3(b)" for "3(b)(i)") and null for a top-level question.

If the first page starts partway through a question that began before these pages, still emit
the sub-parts printed here with their full labels (the note tells you the previous question
number); do not emit nodes for levels whose own text is not on these pages. If the last
question runs past the last page, emit what is visible and say so in notes.

## Fields

- paper: the paper given in the note. section: the section letter in effect ("A", "B"), or
  null when the paper has no sections. Use the section heading printed on the page; the note
  says which section is in effect at the top of the first page.
- type: "mcq" for a question with options A to D; "structured" for a part the student
  answers; "context" for a node with children that only carries shared text or figures and
  has no answer space of its own. A node with its own answer space and children is
  "structured".
- stem: only the text printed at that level: shared context, equations, "Fig. 3.1 shows ...",
  the instruction. Children hold only their own text; never copy a parent's text into a child
  (the loader inherits it). For MCQs the stem excludes the options. A level printed only as a
  label (for example "(a) (i) ..." on one line) is still a "context" node, with an empty stem
  and a small region around the label.
- options: MCQ only, otherwise []. Each option's text as printed. When options are a table or
  pictures (for example rows A to D under column headings), still give a text rendering
  ("NH₄⁺ ion: 1+; VO₃⁻ ion: 1−") and add the table or picture as a figure. When options are
  positions marked on a diagram, describe the position ("A – mouth of the receiving flask").
- marks: the bracketed mark "[n]" printed for that part; 1 for an MCQ; null for context
  nodes. Use "[Total: n]" to check your leaf marks add up.
- regions: one entry per page the node's own content occupies: its label, text, figures and
  answer space, excluding its children where practical (a parent's region is usually the
  block above its first part).
- full_regions: required on every top-level question, MCQs included: every area the whole
  question occupies including all its parts, one entry per page (for a question without parts
  it equals regions). Use [] for every other node.
- answer_space, on every node: the blank space provided for the answer. "lines" (dotted or
  ruled lines), "working" (an unlined blank area, for example for a calculation), "drawing",
  "table", "graph", or "none". MCQs and context nodes are always "none". Answer space is inside
  the region but is never transcribed.
- figures: every diagram, graph, table, chemical structure, photo or apparatus drawing the
  student needs. Attach each figure to the highest node that shares it (Fig. 1.1 used by all
  of 1(a)(i) to (vi) belongs to "1"). Transcribed tables are also figures (kind "table") so
  they can be cropped. Blank answer grids or axes count only if they carry printed
  information (labelled axes, a partial curve).
  - id: "fig-" plus the printed figure number ("fig-3.1"), or for an unnumbered figure
    "fig-q" plus the node label ("fig-q12", "fig-q4(b)"), adding "-2", "-3" for more.
  - caption: the printed caption ("Fig. 3.1"), else "".
  - description: alt text for search and for blind readers: what the figure shows, with every
    label, value, axis and unit a student needs. For structural formulae name the compound
    and give a condensed formula (for example "ethene, H₂C=CH₂").
- topics: 1 to 3 syllabus subtopic codes from the list below, most relevant first, for every
  "mcq" and "structured" node. Tag a context node too when all of its parts share a topic
  (parts inherit it for filtering); otherwise context nodes may use [].
- has_handwriting: true when handwriting touches this node's area.
- confidence: "high", "medium" or "low". Use "low" for anything you could not read reliably
  and say what in notes.
- review_flags: see below; [] when there is nothing to flag.
- notes: brief reviewer notes ("" when nothing to say).

{review_flags}

{coordinates}

{text_conventions}

## Syllabus subtopics

{taxonomy}
"""


def questions_system(taxonomy: Dict[str, Any]) -> str:
    return _QUESTIONS_SYSTEM_TEMPLATE.format(
        review_flags=_REVIEW_FLAGS, coordinates=_COORDINATES, text_conventions=_TEXT_CONVENTIONS,
        taxonomy=taxonomy_listing(taxonomy),
    )


def questions_user_text(
    *,
    document_id: str,
    paper: Optional[str],
    page_indices: List[int],
    expected_starts: List[str],
    previous_question: Optional[str],
    section: Optional[str],
) -> str:
    lines = [f"Document: {document_id}."]
    lines.append(f"Paper: {paper or 'unknown (infer from the pages)'}.")
    lines.append("Pages in this run (page_index): " + ", ".join(str(i) for i in page_indices) + ".")
    if section:
        lines.append(f"Section in effect at the top of the first page: {section}.")
    if expected_starts:
        lines.append(
            "The pre-scan saw these top-level questions start on these pages: "
            + ", ".join(expected_starts) + ". Verify against the pages."
        )
    if previous_question:
        lines.append(
            f"The last top-level question that started before these pages is {previous_question}; "
            "if the first page begins mid-question, it continues that question."
        )
    else:
        lines.append("No question of this paper starts before these pages.")
    lines.append("Transcribe every question node printed on these pages.")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# Answers
# --------------------------------------------------------------------------------------------

_ANSWERS_SYSTEM_TEMPLATE = """\
You transcribe answer keys and mark schemes from scanned chemistry examination documents into
structured data, so each answer can be linked to its question in a question bank. Layouts
vary by school and exam board: answer grids, tables of question numbers and letters, or
mark schemes with marking points.

You receive consecutive answer-key pages. A note after the images lists the papers in the
document and the question labels already transcribed from them; use it to align labels.

## Entries

- One entry per answer as the key gives it. paper: "P1" to "P9", from headings or from which
  paper's questions the labels match (an MCQ grid of 1 to 40 letters normally belongs to the
  multiple-choice paper).
- label: canonical form: "3", "3(a)", "3(a)(i)": lower-case letters and roman numerals in
  brackets, no spaces. Normalise key notations: "3ai" → "3(a)(i)", "5bii" → "5(b)(ii)",
  "Q4(c)" → "4(c)".
- correct_option: for multiple-choice answers, the letter A to D; otherwise null.
- answer_text: for written answers, the mark-scheme text; null for plain MCQ letters. Keep the
  mark-scheme notation: "(1)" per marking point, "/" for alternatives, "(no marks)", "ecf",
  "owtte". Transcribe tables as Markdown.
- marks: the marks for this answer when printed or clear from the marking points (1 for an
  MCQ), else null.
- regions: where this answer is printed, one entry per page (for an answer grid, the cell or
  row holding that answer).
- confidence: "high", "medium" or "low" ("low" when you could not read it reliably; say what
  in notes).
- review_flags: see below; [] when there is nothing to flag. Use "answer_mismatch" when the
  key disagrees with the question as transcribed (a letter the question has no option for, a
  mark scheme for a different question, marks that do not match the question's marks).
- notes: when the key answers at a different granularity from the questions (one row for 4(a)
  covering 4(a)(i) and (ii)), keep the key's label and say so here; otherwise "".

Ignore handwriting (ticks, crosses, scores) on the key.

{review_flags}

{coordinates}

{text_conventions}
"""


def answers_system() -> str:
    return _ANSWERS_SYSTEM_TEMPLATE.format(
        review_flags=_REVIEW_FLAGS, coordinates=_COORDINATES, text_conventions=_TEXT_CONVENTIONS)


def answers_user_text(
    *, document_id: str, page_indices: List[int], known_labels: Dict[str, List[str]],
    previous_question: Optional[str] = None,
) -> str:
    lines = [f"Document: {document_id}."]
    lines.append("Answer-key pages in this run (page_index): " + ", ".join(str(i) for i in page_indices) + ".")
    if previous_question:
        lines.append(
            f"Earlier answer-key pages ended around question {previous_question}; if the first page starts "
            "mid-answer, label the continuation with the question it belongs to."
        )
    if known_labels:
        lines.append("Question labels already transcribed, by paper:")
        for paper, labels in sorted(known_labels.items()):
            lines.append(f"- {paper}: " + ", ".join(labels))
    else:
        lines.append("No question labels are known yet; read labels from the key.")
    lines.append("Transcribe every answer printed on these pages.")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# Retry feedback
# --------------------------------------------------------------------------------------------

def retry_feedback_text(errors: List[str], max_items: int = 40) -> str:
    shown = errors[:max_items]
    more = len(errors) - len(shown)
    body = "\n".join(f"- {e}" for e in shown)
    if more > 0:
        body += f"\n- ... and {more} more"
    return (
        "Your output has problems that the pipeline cannot accept:\n"
        f"{body}\n\n"
        "Look at the pages again and return the complete corrected output for all of these pages "
        "(not just the fixed items). If something truly cannot be read, keep your best reading and "
        "explain in notes (and set confidence to \"low\" where the field exists)."
    )
