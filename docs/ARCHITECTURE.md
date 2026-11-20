# Question bank ingestion: architecture

Goal: turn scanned O-Level Chemistry papers (PDFs of page images, no text layer) into a
searchable question bank, keeping every diagram and an exact visual of each question.

## Pipeline

An engine, not a one-off import: `python -m ingest run papers/<file>.pdf` takes any paper from
PDF to DB, and re-running it on new papers grows the same database.

```
papers/*.pdf
  │ 1. rasterize    lossless page images → asset store; pages table           (ingest/rasterize.py)
  │ 2. extract      pluggable backend → JSON per contract                      (ingest/extract/*)
  │                   claude   : Claude API vision extraction (default for new papers)
  │                   files    : precomputed/hand-corrected JSON from a directory (gold sets, reviewed fixes)
  │                 data/extracted/<document_id>/*.json   ← reviewable, editable, reloadable
  │    eval         score an extraction against a gold set (data/gold/<document_id>/)
  │ 3. crop         snap bboxes to whitespace / ink, crop figures + questions  (ingest/crop.py)
  │ 4. load         validate JSON, build question tree, link answers, topics   (ingest/load.py)
  │ 5. index        FTS5 over stem + inherited context + options + answer + figure alt text + topics
  ▼
data/db/questions.sqlite   +   data/assets/<sha[0:2]>/<sha>.<ext>
```

Stages are re-runnable and idempotent: the document is keyed by the PDF's sha256, and assets by
content hash. Re-running the load step on edited JSON rebuilds that document's rows.

## Key decisions

| Decision | Why |
|---|---|
| **Vision-model extraction, not OCR** | There is no text layer. Chemistry needs subscripts, charges, arrows and structure diagrams, which OCR mangles. A vision model also segments questions, reads MCQ options and writes figure alt text in the same pass. |
| **Extraction output is a JSON file, not a DB write** | It is the reviewable source of truth. Extraction is the expensive and fallible step, so a teacher can fix a typo in JSON and reload without re-reading the scan. It also decouples who extracts (API, agent, human) from loading. See `docs/EXTRACTION_CONTRACT.md`. |
| **Content-addressed asset store, DB holds references** | Images are deduped, immutable and cacheable forever (hash in path), and map 1:1 to S3/GCS object keys later. No BLOBs in the DB. |
| **Keep the original page scan losslessly; crops are derived** | Crops can always be regenerated from page plus bbox when the cropping logic improves. Provenance (`page_id`, `bbox`) is stored with every crop. |
| **Two crops per question: figures and full question** | Figures for rendering transcribed questions. The full-question crop is a faithful fallback when transcription is imperfect, and shows the question "as printed". |
| **Bbox snapping in code** | Model bbox estimates are approximate. Snapping question boundaries to horizontal whitespace bands, and trimming figures to their ink, makes crops reliable without pixel-perfect model output. |
| **Question tree (`2` → `2(b)` → `2(b)(ii)`)** | Structured questions share stems and figures. Leaves inherit ancestor context for display and search. A top-level question is the practice unit. |
| **SQLite + FTS5 now, portable SQL** | Zero-ops for a prototype with one topic and one paper. The schema maps directly to Postgres (`tsvector` + GIN, `pgvector` later) when the app needs concurrent writes. |
| **Search text is normalised** | `H₂O` is stored for display but indexed as `H2O`, so students can type formulas. Porter stemming handles "react/reaction/reacting". |
| **Syllabus topic tags at subtopic level** | Drives the brief's "pick a weak topic and practise" and later a fundamentals rating. The taxonomy is in `taxonomy/`. |
| **Handwriting is flagged, not transcribed** | The sample scans have student and teacher ticks and crosses. Crops may include them, and `has_handwriting` lets the UI or a reviewer decide. |

## Later (not built now)

* Semantic search with embeddings per question (pgvector or sqlite-vec) for "questions like this one".
* Cleaning handwriting off crops (inpainting), and a review UI for the JSON.
* Rights: school prelim papers are copyrighted by the schools. Confirm permission before the
  platform serves them to anyone beyond private practice.
