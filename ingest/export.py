"""Denormalized JSON export for the app: one object per top-level question (the practice unit)
with its whole tree, so consumers need no SQL.

Asset `path`s are relative to `assets_root` (also the object-store key if assets move to S3).
"""
from __future__ import annotations

import json
import sqlite3
from typing import Dict, List, Optional

from ingest.db import utcnow
from ingest.search import effective_answers

EXPORT_VERSION = 1


def _assets(conn: sqlite3.Connection, question_id: str) -> Dict[str, list]:
    out: Dict[str, list] = {"figures": [], "full_question": [], "regions": []}
    for r in conn.execute(
            "SELECT a.role, a.page_index, a.figure_id, a.figure_kind, a.caption, a.description, a.status, "
            "s.path, s.width, s.height FROM question_assets a LEFT JOIN assets s ON s.sha256 = a.asset_sha256 "
            "WHERE a.question_id = ? ORDER BY a.role, a.ordinal", (question_id,)):
        item = {"path": r["path"], "page_index": r["page_index"], "width": r["width"], "height": r["height"],
                "status": r["status"]}
        if r["role"] == "figure":
            item.update({"id": r["figure_id"], "kind": r["figure_kind"], "caption": r["caption"],
                         "description": r["description"]})
            out["figures"].append(item)
        elif r["role"] == "full_question":
            out["full_question"].append(item)
        else:
            out["regions"].append(item)
    return out


def _answer(conn: sqlite3.Connection, a: dict) -> dict:
    crops = [r[0] for r in conn.execute(
        "SELECT s.path FROM answer_assets x JOIN assets s ON s.sha256 = x.asset_sha256 WHERE x.answer_id = ? "
        "ORDER BY x.ordinal", (a["id"],))]
    return {"label": a["label"], "link": a["link"], "correct_option": a["correct_option"],
            "answer_text": a["answer_text"], "marks": a["marks"], "confidence": a["confidence"],
            "review_flags": json.loads(a["review_flags"] or "[]"), "notes": a["notes"], "crops": crops}


def _node(conn: sqlite3.Connection, q: sqlite3.Row, children: Dict[Optional[str], List[sqlite3.Row]],
          context: List[dict], inherited_topics: List[str], names: Dict[str, str]) -> dict:
    own_topics = [r[0] for r in conn.execute(
        "SELECT topic_code FROM question_topics WHERE question_id = ? ORDER BY rank", (q["id"],))]
    topics = own_topics + [t for t in inherited_topics if t not in own_topics]
    node = {
        "id": q["id"], "label": q["label"], "type": q["type"], "section": q["section"], "stem": q["stem"],
        "context": context,  # ancestor stems, outermost first
        "marks": q["marks"], "answer_space": q["answer_space"],
        "options": [{"label": o[0], "text": o[1]} for o in conn.execute(
            "SELECT label, text FROM question_options WHERE question_id = ? ORDER BY ordinal", (q["id"],))],
        "answers": [_answer(conn, a) for a in effective_answers(conn, q["id"])],
        "topics": [{"code": t, "name": names.get(t), "inherited": t not in own_topics} for t in topics],
        "confidence": q["confidence"], "has_handwriting": bool(q["has_handwriting"]), "notes": q["notes"],
        "review_status": q["review_status"], "review_reasons": json.loads(q["review_reasons"] or "[]"),
        "assets": _assets(conn, q["id"]),
    }
    ctx = context + ([{"label": q["label"], "stem": q["stem"]}] if q["stem"].strip() else [])
    node["children"] = [_node(conn, c, children, ctx, topics, names) for c in children.get(q["id"], [])]
    return node


def _tree_status(node: dict) -> bool:
    return node["review_status"] == "needs_review" or any(_tree_status(c) for c in node["children"])


def export_documents(conn: sqlite3.Connection, document_ids: List[str], assets_root: str) -> dict:
    names = {r[0]: r[1] for r in conn.execute("SELECT code, name FROM topics")}
    docs, questions = [], []
    for doc_id in document_ids:
        doc = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if doc is None:
            raise KeyError("unknown document %r" % doc_id)
        papers = []
        for p in conn.execute("SELECT * FROM papers WHERE document_id = ? ORDER BY paper", (doc_id,)):
            paper = {k: p[k] for k in p.keys() if k != "document_id"}
            paper["choice_groups"] = [{"id": g[0], "choose": g[1], "note": g[2]} for g in conn.execute(
                "SELECT group_id, choose, note FROM choice_groups WHERE document_id = ? AND paper = ? "
                "ORDER BY group_id", (doc_id, p["paper"]))]
            papers.append(paper)
        docs.append({"id": doc["id"], "source_pdf": doc["source_pdf"], "sha256": doc["sha256"],
                     "page_count": doc["page_count"], "extracted_by": doc["extracted_by"],
                     "loaded_at": doc["loaded_at"], "papers": papers})
        rows = conn.execute("SELECT * FROM questions WHERE document_id = ? ORDER BY sort_key", (doc_id,)).fetchall()
        children: Dict[Optional[str], List[sqlite3.Row]] = {}
        for r in rows:
            children.setdefault(r["parent_id"], []).append(r)
        for root in children.get(None, []):
            tree = _node(conn, root, children, [], [], names)
            total = sum(n["marks"] or 0 for n in _walk(tree) if n["type"] in ("mcq", "structured"))
            questions.append(dict({"document_id": doc_id, "paper": root["paper"],
                                   "choice_group": root["choice_group"], "total_marks": total,
                                   "tree_review_status": "needs_review" if _tree_status(tree) else "ok"}, **tree))
    return {"export_version": EXPORT_VERSION, "exported_at": utcnow(), "assets_root": assets_root,
            "documents": docs, "questions": questions}


def _walk(node: dict):
    yield node
    for c in node["children"]:
        yield from _walk(c)
