# Question bank ingestion engine

Turns scanned O-Level Chemistry exam papers (PDFs of page images) into a searchable question bank:
SQLite + full-text search, with original-scan crops of every question, figure and answer.
It is built to be re-run on every new paper. See [BRIEF.md](BRIEF.md) for the product and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

```
PDF ──rasterize──▶ page scans ──extract──▶ contract JSON ──crop+load──▶ SQLite + FTS5 + asset store
                                 (Claude API,      (reviewable,        (data/db/questions.sqlite,
                                  or curated JSON)  editable)           data/assets/<sha>.png)
```

## For the platform: the published question bank

[`question-bank/`](question-bank/) is the current published snapshot. It contains `export.json`,
`questions.sqlite`, the image assets and a manifest. Read
[question-bank/HANDOFF.md](question-bank/HANDOFF.md) for how to consume it. To publish a new
snapshot after ingesting more papers:

```bash
.venv/bin/python -m ingest bundle --out . --name question-bank --no-zip --force
```

Commit the result. The manifest records the engine commit it was built from, so commit the engine
changes first.

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Ingest a paper

New paper, extracted by Claude. Needs `ANTHROPIC_API_KEY`; costs roughly $5–12 per 50-page paper
depending on model:

```bash
.venv/bin/python -m ingest run papers/<file>.pdf --extractor claude
```

From existing contract JSON, such as the hand-verified gold set for the sample paper:

```bash
.venv/bin/python -m ingest run papers/Sec4_PureChemistry_2025_SA2_montfort.pdf --from data/gold/montfort-2025-sec4-chem-prelim
```

`run` prints a quality report. It checks marks against the cover, answers against questions,
crop failures, low-confidence items and items that need review. Re-running is idempotent.

## Use the bank

```bash
.venv/bin/python -m ingest search "caco3 rate" --topic 10 --type mcq
.venv/bin/python -m ingest show "montfort-2025-sec4-chem-prelim:P2:3(a)(ii)"
.venv/bin/python -m ingest topics
.venv/bin/python -m ingest export --all --out data/export.json
```

Search normalises chemistry, so `h2o` finds `H₂O`. It falls back from all-words to any-word
matching, filters by syllabus topic (children inherit their parents' topics), and hides questions
that need review unless you pass `--include-review`.

## Review workflow

Questions with `review_flags` or low confidence (a defect in the paper itself, an illegible scan,
inferred content, or a key that disagrees with its question) are held back from students:

```bash
.venv/bin/python -m ingest review
```

To review an item, fix the JSON in `data/extracted/<doc>/` (or `data/gold/<doc>/`), clear the
flag, then reload it with `.venv/bin/python -m ingest load <doc> [--from DIR]`.

## Measure extraction quality

`data/gold/` holds hand-verified extractions. Score any extraction against them:

```bash
.venv/bin/python -m ingest eval --gold data/gold/montfort-2025-sec4-chem-prelim --pred <dir>
```

The runbook for prompt iteration and model choice is in the docstring of
[ingest/extract/claude.py](ingest/extract/claude.py).

## Layout

| Path | What |
|---|---|
| `ingest/` | the engine (CLI in `cli.py`; extractors in `extract/`) |
| `docs/EXTRACTION_CONTRACT.md` | the JSON interface every extractor produces |
| `taxonomy/` | 6092 syllabus topics (seed list, to be verified against SEAB) and search synonyms |
| `question-bank/` | the published snapshot for the platform (committed, built by `ingest bundle`) |
| `data/gold/` | committed, hand-verified reference extractions |
| `data/extracted/`, `data/assets/`, `data/db/` | generated output (gitignored) |
| `tests/` | `.venv/bin/python -m pytest` |
