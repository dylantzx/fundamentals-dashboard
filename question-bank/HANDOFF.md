# Question bank handoff

This bundle is a snapshot of an O-Level Chemistry question bank built from scanned exam papers. It
has transcribed questions, answers and mark schemes, syllabus topic tags, and image crops of every
question, figure and answer taken from the original scans.

```
HANDOFF.md        this guide
manifest.json     counts, versions, sha256 checksums
export.json       ★ start here: one JSON tree per question
questions.sqlite  the same data as a normalised SQLite DB (with a full-text index)
assets/           PNG/JPEG images, content-addressed: assets/<sha[:2]>/<sha>.<ext>
```

## Path A (recommended): import `export.json`

You need no SQL. Its top level is:

```jsonc
{ "export_version": 1, "exported_at": "...", "assets_root": "assets",
  "documents": [ { "id", "source_pdf", "papers": [ { "paper": "P1", "paper_code": "6092/01",
                   "school", "exam", "year", "total_marks", "choice_groups": [...] } ] } ],
  "questions": [ <top-level question>, ... ] }
```

Each item in `questions` is one **practice unit**: an MCQ, or a whole structured question with its
parts nested in `children`. Every node has these fields:

| field | meaning |
|---|---|
| `id` | stable id (hash of document, paper and label). It is unchanged across re-ingests, so **upsert by it**. |
| `label` | as printed, in canonical form: `"7"`, `"2(b)(ii)"` |
| `type` | `mcq`, `structured` (the student answers this part) or `context` (shared text or figures only) |
| `stem` | the text of this node only. Chemistry is in Unicode (`H₂O`, `SO₄²⁻`, `⇌`, `ΔH`). Tables are Markdown. |
| `context` | the ancestors' stems, outermost first. **Show these above the part.** |
| `options` | MCQ options `[{label:"A", text}]` |
| `marks`, `answer_space` | the marks for the part, and what the student writes in: `lines`, `drawing`, `table`, `graph`, `working` or `none` |
| `answers[]` | `correct_option` (MCQ) or `answer_text` (mark scheme, keeping the `(1)` marking points), `marks`, and `crops` (an image of the mark-scheme row) |
| `topics[]` | `{code, name, inherited}` from the 6092 syllabus taxonomy, e.g. `10.2 Factors affecting rate` |
| `review_status`, `review_reasons` | `ok` or `needs_review` (see the rules below) |
| `assets.figures[]` | the diagrams, graphs and tables the student needs, with `description`, which is alt text you can show to screen readers or index for search |
| `assets.full_question[]` | the whole question as printed, one image per page, in order (top-level nodes only) |
| `assets.regions[]` | this part's own printed area |
| `has_handwriting`, `confidence`, `notes` | provenance and quality hints |

Top-level nodes also carry `total_marks`, `choice_group` and `tree_review_status`.

Each image `path` is relative to `assets/`. Images are immutable: the hash is in the name, so you can
upload them under the same key to your object store or CDN and cache them forever.

## Rules your platform must respect

1. **Don't show `needs_review` content to students.** Filter on `tree_review_status == "ok"` per
   top-level question. In this snapshot 3 items need review:
   - P1 Q39: the printed options table has a blank column.
   - P1 Q20: one formula was illegible and has been inferred.
   - P2 9(a): the school's mark scheme contains a chemistry error.

   They will come back as `ok` in a later bundle once someone has fixed them.
2. **Choice groups:** P2 Q9 and Q10 belong to `choice_group: "B"`, with `choose: 1`, which means
   "answer one". This matters for mock-exam totals: P2 is out of 80, not 90.
3. **Showing a part:** display `context` stems, then the parent figures, then the part's own stem and
   figures. Many parts depend on a figure attached to their parent, for example Fig. 1.1 applies to
   every part of Q1.
4. **Transcription vs scan:** the text has been hand-verified, but where a question is a drawing
   task, or the layout matters, show `full_question` or `regions` crops next to or instead of the
   text. The crops are 1-bit scans at 300 dpi and may contain a student's or teacher's ticks; those
   nodes have `has_handwriting: true`.

## Path B: use `questions.sqlite` directly

Main tables:
- `questions` (tree via `parent_id` and `root_id`; order by `sort_key`)
- `question_options`, `answers` (`question_id`, and `link` = `exact`, `covers_children` or `child_of_unsplit`)
- `question_topics` and `topics`
- `question_assets` and `answer_assets`, which point to `assets(sha256, path)`
- `papers`, `choice_groups`, `pages`, `documents`

`questions_fts` is an SQLite FTS5 index and does not port to other databases. If you rebuild search
on your side, index `stem`, `context`, `options`, `answer_text`, figure `description` and topic names,
and **normalise sub- and superscripts to ASCII** (`H₂O` → `H2O`) on both the index and the query, so
students can type formulas.

Example: list the practice-ready MCQs for topic 10 (Rate of Reactions).
```sql
SELECT q.id, q.paper, q.label, q.stem
FROM questions q JOIN question_topics t ON t.question_id = q.id
WHERE q.type = 'mcq' AND q.review_status = 'ok' AND t.topic_code LIKE '10%'
ORDER BY q.sort_key;
```

## Updates

Every bundle is a **full snapshot** of all documents. To import one:
1. Upsert questions and answers by `id`.
2. Within each document present in the bundle, delete any ids that are no longer there.
3. Copy or upload `assets/`. Existing files never change.

Check `manifest.json`, which includes the export checksums, before importing. `export_version` changes
only on breaking changes.

## Before going live

- **Rights:** school prelim papers are copyrighted by their schools. Confirm permission before
  serving them to anyone beyond private practice.
- **Taxonomy:** the topic list is a seed drafted from the 6092 syllabus structure and should be checked
  against the official SEAB syllabus.
