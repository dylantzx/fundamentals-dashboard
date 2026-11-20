# Extraction contract (v1.1)

Every extractor (a human, a subagent, or `ingest extract` calling the Claude API) writes JSON
files in exactly this shape. The loader (`ingest load`) consumes them. This file is the single
interface between "reading the scan" and "building the database".

Location: `data/extracted/<document_id>/<chunk>.json`, one file per chunk of pages.
Many chunks per document are fine. Each page record, each question and each answer must appear in
exactly one chunk.

## Top-level shape

```json
{
  "contract_version": 1,
  "document_id": "montfort-2025-sec4-chem-prelim",
  "source_pdf": "papers/Sec4_PureChemistry_2025_SA2_montfort.pdf",
  "chunk": "p1_a",
  "extracted_by": "subagent-gold | claude-api:<model> | human",
  "pages": [ ... ],
  "papers": [ ... ],
  "questions": [ ... ],
  "answers": [ ... ]
}
```

## Coordinates

* `page_index` is the **0-based index of the page in the PDF**. It is not the printed page number.
* `bbox` is `[x0, y0, x1, y1]`, **normalised to 0..1** of the page as rendered (the full page
  image the extractor saw), with the origin at the top left. Values are clamped to 0..1. Rounding to 3 decimals is plenty.
* Be **generous** rather than tight: overshoot by about 0.01. The loader snaps boxes to whitespace
  and trims them to ink. A box that cuts through a diagram is a bug. A box with extra margin is
  fine.

## `pages[]`

```json
{ "page_index": 1, "paper": "P1", "printed_page_number": "2",
  "page_type": "questions", "has_handwriting": true, "notes": "" }
```
`page_type` is one of `cover | questions | answer_key | data_sheet | blank | other`.
`paper` is `"P1"` to `"P9"` or `null`. `printed_page_number` is `null` when none is printed.

## `papers[]`  (only the chunk that owns that paper's cover page emits it)

```json
{ "paper": "P1", "paper_code": "6092/01", "school": "Montfort Secondary School",
  "exam": "Preliminary Examination 2025", "year": 2025, "level": "Secondary 4 Express",
  "subject": "Chemistry", "date": "2025-08-29", "duration_minutes": 60, "total_marks": 40,
  "instructions": "short transcription of the cover instructions",
  "choice_groups": [ { "id": "B", "choose": 1, "note": "Answer one question from this section." } ] }
```
`choice_groups` (v1.1, optional, default `[]`): a set of optional questions where the candidate
answers `choose` of them, e.g. Section B "answer one of Q9 or Q10". Each member top-level question
carries `"choice_group": "B"`. The marks check counts only the `choose` highest-mark members.

## `questions[]`  (a tree, flattened; one node per label)

```json
{
  "paper": "P2",
  "section": "A",
  "label": "2(b)(ii)",
  "parent_label": "2(b)",
  "type": "structured",
  "stem": "Methane reacts with chlorine in the presence of ultraviolet light.\n\nState the formulae of two products of this reaction.",
  "options": [],
  "marks": 2,
  "regions": [ { "page_index": 24, "bbox": [0.08, 0.55, 0.95, 0.70] } ],
  "figures": [],
  "topics": ["11.2"],
  "has_handwriting": false,
  "confidence": "high",
  "review_flags": [],
  "notes": ""
}
```
Optional v1.1 fields on top-level questions: `"full_regions"` (see below) and `"choice_group"`
(see `papers[].choice_groups`).

Rules:

* **Labels are canonical**: `"7"`, `"2(a)"`, `"2(a)(ii)"`, `"10(b)(iii)"`. Lower-case letters and
  roman numerals in brackets, no spaces. MCQs are just `"1"` to `"40"`.
* **Tree**: emit a node for every level that exists in the paper. A parent's `stem` holds only
  the text printed at that level (shared context, an equation, "Fig. 3.1 shows..."). Children hold
  only their own text. Do not copy the parent text into children; the loader inherits it.
  `parent_label` is `null` for top-level questions.
* `type`: `mcq` (has options A to D), `structured` (a leaf the student answers), or `context`
  (a node with children that only carries shared stem or figures and has no answer space of its
  own). If a node has its own answer space **and** children, use `structured`.
* `marks`: the bracketed `[n]` for that leaf. Use `null` for context nodes. MCQ is `1`.
* `regions`: the whole printed area of **this node's own text and figures** on each page it
  occupies. Exclude children's areas where practical (a parent context region is usually the top
  block above `(a)`). For a top-level question, also add `"full_regions"`: every region the
  whole question occupies, including all children. The loader uses this to crop "the whole
  question as printed".
* **Answer space** (dotted lines, empty grids or axes that are just for answering) is part of
  the region but is never transcribed. Note it in `answer_space`: `"lines" | "drawing" | "table" | "graph" | "none"`.
* `figures[]`: every diagram, graph, structure, table or photo that the student needs:
  ```json
  { "id": "fig-2.1", "page_index": 24, "bbox": [...], "kind": "diagram|graph|table|structure|photo|apparatus",
    "caption": "Fig. 2.1", "description": "Alt text: what the figure shows, with every label and value a student needs. Written for search and for blind readers." }
  ```
  Attach a figure to the **highest node that shares it** (for example Fig. 1.1 used by all of
  1(a)(i) to (vi) belongs to `"1"`). Answer-space axes count as a figure only if they carry printed
  information (labelled axes, a partial curve).
* **Tables**: transcribe them into the stem as a Markdown table **and** add a `kind: "table"` figure
  for the crop.
* `options[]` for MCQ: `[{ "label": "A", "text": "1 and 2 only" }, ...]`. If the options are
  pictures or a table (for example a grid of A to D rows), still give a text rendering
  (`"A: ✓ ✗ ✓"` or the row values) and add the image as a figure.
* `topics`: 1 to 3 subtopic codes from `taxonomy/o_level_chemistry_6092.json`, most relevant
  first. Tag leaves and MCQs. Context nodes may be left empty.
* `confidence`: `high | medium | low`. Use `low` for anything you could not read, and say what in
  `notes`.
* `review_flags` (v1.1, default `[]`): reasons a human must look before students see it:
  `source_defect` (the printed question itself is broken, e.g. blank or duplicated options),
  `illegible` (part could not be read), `inferred` (content filled in from context/mark scheme
  rather than read), `answer_mismatch` (key disagrees with the question). Any flag, or
  `confidence: "low"`, makes the question `needs_review` in the DB and hides it from student search
  by default. Clearing the flag in the JSON and reloading is the review workflow.
* `answer_space` is set on **every** node: `"none"` for MCQs and context nodes. An unlined blank
  working area is `"working"`.
* `full_regions` is required on **every** top-level question; for an MCQ or other childless
  question it equals `regions`.
* A label-only parent (e.g. `4(a)` printed as `(a) (i) ...` on one line) is still emitted as a
  `context` node with an empty stem and a small region around the label.
* Topics: children inherit an ancestor's topics for filtering, so tag a context node when all of its
  children share a topic. Still tag every leaf.
* Figure `id`s are unique within a document. `caption` is `""` when no caption is printed.
* Options that are positions on a diagram ("A" marks a point): describe the position in the option
  text (`"A – mouth of the receiving flask"`); the figure description carries the rest.

## `answers[]`

```json
{ "paper": "P1", "label": "1", "correct_option": "C", "answer_text": null, "marks": 1,
  "page_index": 44, "regions": [ { "page_index": 44, "bbox": [...] } ] }
{ "paper": "P2", "label": "3(a)(ii)", "correct_option": null,
  "answer_text": "Particles closer together / more particles in a given volume (1)\nHigher frequency of effective collisions ... (1)",
  "marks": 2, "page_index": 46, "regions": [ ... ] }
```
* Normalise mark-scheme labels to the canonical form: `3ai` becomes `3(a)(i)`, `5bii` becomes
  `5(b)(ii)`.
* Keep the mark-scheme notation: `(1)` per marking point, `/` for alternatives, `(no marks)`.
  Transcribe tables in answers as Markdown.
* Answers also carry `confidence`, `review_flags` and `notes` (same meaning as on questions).
  `page_index` is the page of the first region.
* If the answer key gives an answer at a different granularity from the questions (for example
  one row for `4(a)` that covers `4(a)(i)` and `(ii)`), use the key's label and say so in `notes`.
  The loader reports mismatches.

## Text conventions (stems, options, answers, descriptions)

* Chemistry uses Unicode: `H₂O`, `CaCO₃`, `SO₄²⁻`, `Fe³⁺`, `Al₂(SO₄)₃`, `→`, `⇌`, `ΔH`, `Eₐ`,
  `(aq)`, `°C`, `cm³`, `dm³`. The scans print chlorine as an italic `l` (`HCI`): always write `Cl`.
* Paragraph breaks are `\n\n`. Bullet lists use `- `. Numbered statements (`1 ... 2 ...`) and
  stacked equation lines are separated by a single `\n`. Bold or italic markup is not needed.
* Do **not** transcribe: dotted answer lines, `[Turn Over`, page numbers, the `BP-3xx` stamp,
  `[Total: n]` (but do use it to check marks), or **any handwriting**. The scans contain
  student or teacher ticks, crosses and circled options. Ignore them, and set
  `has_handwriting: true` on that node or page.
* Structural formula drawings: describe them in the figure `description`
  (for example `"ethene, H₂C=CH₂"`) and keep the image.
