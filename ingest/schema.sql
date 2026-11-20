-- Question bank schema. Portable SQL (runs on SQLite; maps 1:1 to Postgres) except the FTS5
-- table at the bottom, which becomes a tsvector column + GIN index on Postgres.
-- IDs are TEXT and deterministic (see ingest/db.py) so links survive reloads.
-- bbox columns hold JSON arrays "[x0, y0, x1, y1]" normalised to the page (0..1, top-left origin).

CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,          -- document slug, e.g. montfort-2025-sec4-chem-prelim
    source_pdf    TEXT NOT NULL,
    sha256        TEXT NOT NULL UNIQUE,      -- identity of the PDF: same file -> same document
    page_count    INTEGER NOT NULL,
    ingested_at   TEXT NOT NULL,             -- first rasterized (UTC ISO 8601)
    loaded_at     TEXT,                      -- last successful load
    extracted_by  TEXT
);

CREATE TABLE IF NOT EXISTS assets (
    sha256      TEXT PRIMARY KEY,            -- content hash; file at <assets>/<path>
    path        TEXT NOT NULL,               -- "<sha[:2]>/<sha>.<ext>" (also the object-store key)
    mime        TEXT NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    bytes       INTEGER NOT NULL,
    kind        TEXT NOT NULL                -- page | figure | question | answer
);

CREATE TABLE IF NOT EXISTS papers (
    document_id      TEXT NOT NULL REFERENCES documents(id),
    paper            TEXT NOT NULL,          -- P1, P2
    paper_code       TEXT,                   -- 6092/01
    school           TEXT,
    exam             TEXT,
    year             INTEGER,
    level            TEXT,
    subject          TEXT,
    date             TEXT,
    duration_minutes INTEGER,
    total_marks      INTEGER,
    instructions     TEXT,
    PRIMARY KEY (document_id, paper)
);

-- Optional questions: the candidate answers `choose` of the members (questions.choice_group).
CREATE TABLE IF NOT EXISTS choice_groups (
    document_id TEXT NOT NULL REFERENCES documents(id),
    paper       TEXT NOT NULL,
    group_id    TEXT NOT NULL,               -- e.g. "B"
    choose      INTEGER NOT NULL,
    note        TEXT,
    PRIMARY KEY (document_id, paper, group_id)
);

CREATE TABLE IF NOT EXISTS pages (
    document_id         TEXT NOT NULL REFERENCES documents(id),
    page_index          INTEGER NOT NULL,    -- 0-based index in the PDF
    asset_sha256        TEXT NOT NULL REFERENCES assets(sha256),   -- lossless master image
    source              TEXT NOT NULL,       -- embedded:<pdf filter> | rendered
    img_x0 REAL NOT NULL, img_y0 REAL NOT NULL, img_x1 REAL NOT NULL, img_y1 REAL NOT NULL,
                                             -- where the master image sits on the page (0..1)
    printed_page_number TEXT,                -- from extraction (NULL until loaded)
    page_type           TEXT,
    paper               TEXT,
    has_handwriting     INTEGER NOT NULL DEFAULT 0,
    notes               TEXT,
    PRIMARY KEY (document_id, page_index)
);

CREATE TABLE IF NOT EXISTS questions (
    id              TEXT PRIMARY KEY,        -- hash(document, paper, label)
    document_id     TEXT NOT NULL REFERENCES documents(id),
    paper           TEXT NOT NULL,
    parent_id       TEXT REFERENCES questions(id),
    root_id         TEXT NOT NULL,           -- top-level question (the practice unit)
    label           TEXT NOT NULL,           -- canonical: 2(b)(ii)
    depth           INTEGER NOT NULL,        -- 0 for top level
    sort_key        TEXT NOT NULL,           -- orders a whole document: paper|qnum|appearance
    is_leaf         INTEGER NOT NULL,
    section         TEXT,
    type            TEXT NOT NULL,           -- mcq | structured | context
    stem            TEXT NOT NULL,
    marks           INTEGER,
    answer_space    TEXT,
    has_handwriting INTEGER NOT NULL DEFAULT 0,
    confidence      TEXT,
    notes           TEXT,
    chunk           TEXT,                    -- extraction chunk it came from
    choice_group    TEXT,                    -- top-level member of a choice group (see choice_groups)
    review_flags    TEXT NOT NULL DEFAULT '[]',          -- JSON list from the extraction
    review_status   TEXT NOT NULL DEFAULT 'ok',          -- ok | needs_review (hidden from search)
    review_reasons  TEXT NOT NULL DEFAULT '[]',          -- JSON list: own flags, low confidence,
                                                         -- ancestor flags, answer flags
    UNIQUE (document_id, paper, label)
);
CREATE INDEX IF NOT EXISTS questions_parent ON questions(parent_id);
CREATE INDEX IF NOT EXISTS questions_root ON questions(root_id);

CREATE TABLE IF NOT EXISTS question_options (
    question_id TEXT NOT NULL REFERENCES questions(id),
    label       TEXT NOT NULL,               -- A..D
    text        TEXT NOT NULL,
    ordinal     INTEGER NOT NULL,
    PRIMARY KEY (question_id, label)
);

-- Crops attached to a question. role: figure | full_question (top-level, whole question as
-- printed) | region (a sub-question's own printed area). asset_sha256 is NULL if cropping failed.
CREATE TABLE IF NOT EXISTS question_assets (
    question_id   TEXT NOT NULL REFERENCES questions(id),
    role          TEXT NOT NULL,
    ordinal       INTEGER NOT NULL,
    asset_sha256  TEXT REFERENCES assets(sha256),
    figure_id     TEXT,
    figure_kind   TEXT,
    caption       TEXT,
    description   TEXT,
    page_index    INTEGER NOT NULL,
    bbox_raw      TEXT NOT NULL,
    bbox_snapped  TEXT,
    status        TEXT NOT NULL,             -- ok | unsnapped | empty | failed
    status_detail TEXT,
    PRIMARY KEY (question_id, role, ordinal)
);
CREATE INDEX IF NOT EXISTS question_assets_asset ON question_assets(asset_sha256);

-- Mark-scheme entries. question_id is the node the answer is attached to (NULL if no match);
-- link says how: exact | covers_children (key answers a parent whose children were split) |
-- child_of_unsplit (key answers a sub-part that the questions did not split) | unmatched.
CREATE TABLE IF NOT EXISTS answers (
    id             TEXT PRIMARY KEY,         -- hash(document, paper, "answer", label)
    document_id    TEXT NOT NULL REFERENCES documents(id),
    paper          TEXT NOT NULL,
    label          TEXT NOT NULL,
    question_id    TEXT REFERENCES questions(id),
    link           TEXT NOT NULL,
    correct_option TEXT,
    answer_text    TEXT,
    marks          INTEGER,
    page_index     INTEGER,
    notes          TEXT,
    confidence     TEXT,
    review_flags   TEXT NOT NULL DEFAULT '[]',
    UNIQUE (document_id, paper, label)
);
CREATE INDEX IF NOT EXISTS answers_question ON answers(question_id);

CREATE TABLE IF NOT EXISTS answer_assets (
    answer_id     TEXT NOT NULL REFERENCES answers(id),
    ordinal       INTEGER NOT NULL,
    asset_sha256  TEXT REFERENCES assets(sha256),
    page_index    INTEGER NOT NULL,
    bbox_raw      TEXT NOT NULL,
    bbox_snapped  TEXT,
    status        TEXT NOT NULL,
    status_detail TEXT,
    PRIMARY KEY (answer_id, ordinal)
);

CREATE TABLE IF NOT EXISTS topics (
    code        TEXT PRIMARY KEY,            -- "10" (topic) or "10.2" (subtopic)
    name        TEXT NOT NULL,
    parent_code TEXT REFERENCES topics(code)
);

CREATE TABLE IF NOT EXISTS question_topics (
    question_id TEXT NOT NULL REFERENCES questions(id),
    topic_code  TEXT NOT NULL REFERENCES topics(code),
    rank        INTEGER NOT NULL,            -- 1 = most relevant
    PRIMARY KEY (question_id, topic_code)
);
CREATE INDEX IF NOT EXISTS question_topics_topic ON question_topics(topic_code);

-- SQLite-specific: full-text index, one row per question node. Text is normalised
-- (ingest/search.py: H₂O -> H2O) both here and in queries.
CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
    question_id UNINDEXED,
    document_id UNINDEXED,
    label,
    stem,
    context,
    options,
    answer,
    figures,
    topics,
    tokenize = 'porter unicode61 remove_diacritics 2'
);
