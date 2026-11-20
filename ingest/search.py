"""Stage 5: full-text index (SQLite FTS5) and search.

Text is normalised the same way when indexing and when querying, so a student typing "h2o",
"caco3" or "so42" matches H₂O, CaCO₃ and SO₄²⁻. User queries are tokenised and quoted, so FTS
syntax characters (quotes, brackets, NOT/AND/OR, *, :, -) can never raise an error.
"""
from __future__ import annotations

import re
import sqlite3
import unicodedata
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ingest.config import REPO_ROOT

SYNONYMS_PATH = REPO_ROOT / "taxonomy" / "search_synonyms.json"
# Dropped from queries (not from the index). Tokens with digits (formulas) are never dropped, and a
# query made only of stopwords is searched as typed.
STOPWORDS = frozenset("""
a an the of and or to in on at by for with from into onto about as is are was were be been being
it its this that these those what which who whom how why when where do does did than then there
their they can could will would should shall may might must between during each any some all
""".split())

Phrase = Tuple[str, ...]

# FTS column order: question_id, document_id (UNINDEXED), then the searchable columns below.
FTS_COLUMNS = ("question_id", "document_id", "label", "stem", "context", "options", "answer", "figures", "topics")
# own stem highest; inherited ancestor text (context) and topic names low, so a long shared
# passage or a topic title cannot outrank a part whose own text matches
BM25_WEIGHTS = (0.0, 0.0, 1.0, 10.0, 1.0, 4.0, 2.0, 2.0, 0.5)
# Snippet preference: the first of these columns that contains a hit (never the topics column).
SNIPPET_COLUMNS = ("stem", "options", "answer", "context", "figures", "label")
_HL_OPEN, _HL_CLOSE = "\x02", "\x03"

_TRANSLATE = {ord(c): " " for c in "→⇌⇋←↔⟶⟵⇒⇐⇄⇆↑↓⟷·•"}
_TRANSLATE.update({ord(c): "-" for c in "−–—‐‑"})
_TRANSLATE.update({ord("Δ"): " delta ", ord("∆"): " delta ", ord("×"): " x ", ord("°"): " "})


def normalize(text: Optional[str]) -> str:
    """Search form of chemistry text: H₂O -> H2O, SO₄²⁻ -> SO42-, Fe³⁺ -> Fe3+, arrows -> spaces."""
    if not text:
        return ""
    t = unicodedata.normalize("NFKC", text.translate(_TRANSLATE))  # NFKC folds sub/superscripts
    t = t.translate(_TRANSLATE)  # NFKC turns ⁻ into U+2212, map again
    return re.sub(r"[ \t]+", " ", t)


def query_tokens(query: str) -> List[str]:
    return re.findall(r"[^\W_]+", normalize(query).lower())


_synonyms_cache: Dict[str, Tuple[float, Dict[Phrase, List[Phrase]]]] = {}


def load_synonyms(path: Optional[Path] = None) -> Dict[Phrase, List[Phrase]]:
    """{key phrase: [alternative phrases]} in normalised token form; re-read when the file changes."""
    import json
    path = Path(path or SYNONYMS_PATH)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {}
    cached = _synonyms_cache.get(str(path))
    if cached and cached[0] == mtime:
        return cached[1]
    raw = json.loads(path.read_text(encoding="utf-8")).get("synonyms", {})
    table: Dict[Phrase, List[Phrase]] = {}
    for key, alts in raw.items():
        k = tuple(query_tokens(key))
        if k:
            table[k] = [p for p in dict.fromkeys(tuple(query_tokens(a)) for a in [key] + list(alts)) if p]
    _synonyms_cache[str(path)] = (mtime, table)
    return table


def parse_query(query: str, synonyms: Optional[Dict[Phrase, List[Phrase]]] = None) -> List[List[Phrase]]:
    """Query -> groups of alternative phrases; every group must match (AND), any phrase in a group
    may (OR). Synonym keys (longest first) become multi-phrase groups; stopwords are dropped."""
    tokens = query_tokens(query or "")
    syn = load_synonyms() if synonyms is None else synonyms
    longest = max((len(k) for k in syn), default=0)
    groups: List[List[Phrase]] = []
    i = 0
    while i < len(tokens):
        for n in range(min(longest, len(tokens) - i), 0, -1):
            key = tuple(tokens[i:i + n])
            if key in syn:
                groups.append(list(syn[key]))
                i += n
                break
        else:
            t = tokens[i]
            i += 1
            if t not in STOPWORDS or any(c.isdigit() for c in t):
                groups.append([(t,)])
    if not groups and tokens:          # only stopwords ("the", "not and"): search them as typed
        groups = [[(t,)] for t in tokens]
    return groups


def build_match(groups: List[List[Phrase]], op: str = "AND") -> str:
    """FTS5 query from parse_query groups. Every term is quoted, so FTS syntax in user input is inert.

    A plain last word also matches as a prefix (search-as-you-type); the exact term is OR-ed in so
    a document containing exactly that token ("h2o") scores above one only matching the prefix
    ("h2o2"): it matches both phrases.
    """
    parts = []
    for n, group in enumerate(groups):
        phrases = ['"%s"' % " ".join(p) for p in group]
        if n == len(groups) - 1 and len(group) == 1 and len(group[0]) == 1:
            phrases.append('"%s"*' % group[0][0])
        parts.append(phrases[0] if len(phrases) == 1 else "(%s)" % " OR ".join(phrases))
    return (" %s " % op).join(parts)


# ---------------------------------------------------------------- indexing

def index_document(conn: sqlite3.Connection, document_id: str) -> int:
    """(Re)build FTS rows for one document. Call inside the load transaction."""
    conn.execute("DELETE FROM questions_fts WHERE document_id = ?", (document_id,))
    qs = {r["id"]: dict(r) for r in conn.execute(
        "SELECT id, parent_id, label, stem FROM questions WHERE document_id = ?", (document_id,))}
    options: Dict[str, List[str]] = {}
    for r in conn.execute(
            "SELECT o.question_id, o.label, o.text FROM question_options o JOIN questions q ON q.id = o.question_id "
            "WHERE q.document_id = ? ORDER BY o.ordinal", (document_id,)):
        options.setdefault(r[0], []).append("%s %s" % (r[1], r[2]))
    figures: Dict[str, List[str]] = {}
    for r in conn.execute(
            "SELECT a.question_id, a.caption, a.description FROM question_assets a JOIN questions q ON q.id = a.question_id "
            "WHERE q.document_id = ? AND a.role = 'figure' ORDER BY a.ordinal", (document_id,)):
        figures.setdefault(r[0], []).append(" ".join(x for x in (r[1], r[2]) if x))
    topics: Dict[str, List[str]] = {}
    for r in conn.execute(
            "SELECT t.question_id, t.topic_code, tp.name FROM question_topics t JOIN topics tp ON tp.code = t.topic_code "
            "JOIN questions q ON q.id = t.question_id WHERE q.document_id = ? ORDER BY t.rank", (document_id,)):
        topics.setdefault(r[0], []).append("%s %s" % (r[1], r[2]))

    def ancestors(qid: str) -> List[str]:
        out, p = [], qs[qid]["parent_id"]
        while p:
            out.append(p)
            p = qs[p]["parent_id"]
        return out[::-1]

    n = 0
    for qid, q in qs.items():
        anc = ancestors(qid)
        answer = " ".join(a["answer_text"] or "" for a in effective_answers(conn, qid))
        conn.execute(
            "INSERT INTO questions_fts (question_id, document_id, label, stem, context, options, answer, figures, topics) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (qid, document_id, q["label"], normalize(q["stem"]),
             normalize("\n".join(qs[a]["stem"] for a in anc)),
             normalize("\n".join(options.get(qid, []))),
             normalize(answer),
             normalize("\n".join(sum((figures.get(x, []) for x in anc + [qid]), []))),
             normalize(" ".join(sum((topics.get(x, []) for x in anc + [qid]), [])))))
        n += 1
    return n


def effective_answers(conn: sqlite3.Connection, question_id: str) -> List[dict]:
    """Answers that apply to a question: its own (exact or child_of_unsplit) plus any ancestor
    answer that covers its children."""
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM answers WHERE question_id = ? ORDER BY label", (question_id,))]
    parent = conn.execute("SELECT parent_id FROM questions WHERE id = ?", (question_id,)).fetchone()
    p = parent[0] if parent else None
    while p:
        rows += [dict(r) for r in conn.execute(
            "SELECT * FROM answers WHERE question_id = ? AND link = 'covers_children'", (p,))]
        p = conn.execute("SELECT parent_id FROM questions WHERE id = ?", (p,)).fetchone()[0]
    return rows


# ---------------------------------------------------------------- querying

def question_asset_paths(conn: sqlite3.Connection, question_id: str, assets_root: Path) -> Dict[str, List[str]]:
    """Whole-question crops of the root plus figure crops of the node and its ancestors."""
    chain, p = [], question_id
    while p:
        chain.append(p)
        p = conn.execute("SELECT parent_id FROM questions WHERE id = ?", (p,)).fetchone()[0]
    root = chain[-1]
    out: Dict[str, List[str]] = {"full_question": [], "figures": [], "part": [], "page": []}
    full = conn.execute(
        "SELECT s.path, a.page_index FROM question_assets a JOIN assets s ON s.sha256 = a.asset_sha256 "
        "WHERE a.question_id = ? AND a.role = 'full_question' ORDER BY a.ordinal", (root,)).fetchall()
    out["full_question"] = [str(Path(assets_root) / r[0]) for r in full]
    # the part's own crop(s), and the whole-question crop of the page(s) the part is printed on
    own = conn.execute(
        "SELECT s.path, a.page_index FROM question_assets a JOIN assets s ON s.sha256 = a.asset_sha256 "
        "WHERE a.question_id = ? AND a.role = ? ORDER BY a.ordinal",
        (question_id, "full_question" if question_id == root else "region")).fetchall()
    out["part"] = [str(Path(assets_root) / r[0]) for r in own]
    pages = {r[1] for r in own}
    out["page"] = [str(Path(assets_root) / r[0]) for r in full if r[1] in pages] or out["full_question"][:1]
    for qid in reversed(chain):
        for r in conn.execute(
                "SELECT s.path FROM question_assets a JOIN assets s ON s.sha256 = a.asset_sha256 "
                "WHERE a.question_id = ? AND a.role = 'figure' ORDER BY a.ordinal", (qid,)):
            out["figures"].append(str(Path(assets_root) / r[0]))
    return out


def _pick_snippet(row: sqlite3.Row) -> Optional[str]:
    for col in SNIPPET_COLUMNS:
        text = row["snip_" + col]
        if text and _HL_OPEN in text:
            return " ".join(text.replace(_HL_OPEN, "[").replace(_HL_CLOSE, "]").split())
    return None


def search(conn: sqlite3.Connection, query: str, topic: Optional[str] = None, paper: Optional[str] = None,
           qtype: Optional[str] = None, document: Optional[str] = None, limit: int = 20,
           assets_root: Optional[Path] = None, include_review: bool = False) -> List[dict]:
    """Leaf questions matching `query` (all leaves matching the filters if the query is empty).

    All words must match first; if that gives fewer than `limit` hits, the list is topped up with
    any-word matches (ranked after the all-word hits). Questions flagged needs_review are hidden
    unless include_review is set.
    """
    filters, params = ["q.is_leaf = 1"], []
    if not include_review:
        filters.append("q.review_status = 'ok'")
    if topic:
        # a node inherits its ancestors' topics (contract v1.1): ancestors are label prefixes
        filters.append(
            "EXISTS (SELECT 1 FROM question_topics t JOIN questions a ON a.id = t.question_id "
            "WHERE a.document_id = q.document_id AND a.paper = q.paper "
            "AND (a.id = q.id OR q.label LIKE a.label || '(%') "
            "AND (t.topic_code = ? OR t.topic_code LIKE ?))")
        params += [topic, topic.rstrip(".") + ".%"]
    if paper:
        filters.append("q.paper = ?")
        params.append(paper.upper())
    if qtype:
        filters.append("q.type = ?")
        params.append(qtype)
    if document:
        filters.append("q.document_id = ?")
        params.append(document)
    where = " AND ".join(filters)
    cols = ("q.id, q.document_id, q.paper, q.label, q.type, q.marks, q.stem, q.root_id, q.review_status, "
            "r.label AS root_label")
    groups = parse_query(query or "")
    rows: List[sqlite3.Row] = []
    if groups:
        snippets = ", ".join("snippet(questions_fts, %d, '%s', '%s', '…', 12) AS snip_%s"
                             % (FTS_COLUMNS.index(c), _HL_OPEN, _HL_CLOSE, c) for c in SNIPPET_COLUMNS)
        sql = ("SELECT %s, bm25(questions_fts, %s) AS score, %s "
               "FROM questions_fts JOIN questions q ON q.id = questions_fts.question_id "
               "JOIN questions r ON r.id = q.root_id "
               "WHERE questions_fts MATCH ? AND %s ORDER BY score LIMIT ?"
               % (cols, ", ".join(map(str, BM25_WEIGHTS)), snippets, where))
        rows = conn.execute(sql, [build_match(groups, "AND")] + params + [limit]).fetchall()
        if len(rows) < limit and len(groups) > 1:
            seen = {r["id"] for r in rows}
            more = conn.execute(sql, [build_match(groups, "OR")] + params + [limit]).fetchall()
            rows += [r for r in more if r["id"] not in seen][:limit - len(rows)]
    else:
        rows = conn.execute(
            "SELECT %s, NULL AS score FROM questions q JOIN questions r ON r.id = q.root_id "
            "WHERE %s ORDER BY q.document_id, q.sort_key LIMIT ?" % (cols, where), params + [limit]).fetchall()

    out = []
    for r in rows:
        hit = {k: r[k] for k in ("id", "document_id", "paper", "label", "type", "marks", "root_id",
                                 "root_label", "review_status", "score")}
        hit["topics"] = [t[0] for t in conn.execute(
            "SELECT topic_code FROM question_topics WHERE question_id = ? ORDER BY rank", (r["id"],))]
        hit["snippet"] = (_pick_snippet(r) if groups else None) or " ".join((r["stem"] or "").split())[:160]
        if assets_root is not None:
            hit["assets"] = question_asset_paths(conn, r["id"], assets_root)
        out.append(hit)
    return out
