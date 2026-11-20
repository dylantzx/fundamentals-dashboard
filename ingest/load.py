"""Stage 3+4+5: validate contract JSON, crop, and (re)load one document in a single transaction.

Reloading is idempotent: the document's question/answer/paper rows are deleted and re-inserted
with deterministic IDs, and crops land in the content-addressed store under the same hashes.
Pages and documents rows are owned by the rasterize stage; the loader only updates the
extraction-derived page fields.
"""
from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from ingest import db as dbm
from ingest.assets import AssetStore, LocalAssetStore, put_image, register
from ingest.config import Config
from ingest.crop import Crop, crop_answer_rows, load_page, make_crop
from ingest.search import index_document
from ingest.validate import Issue, errors, parent_of, read_chunks, validate


class LoadError(Exception):
    pass


class ValidationFailed(LoadError):
    def __init__(self, issues: List[Issue]):
        self.issues = issues
        super().__init__("%d validation error(s)" % len(errors(issues)))


@dataclass
class LoadResult:
    document_id: str
    issues: List[Issue] = field(default_factory=list)
    counts: Dict[str, int] = field(default_factory=dict)


@dataclass
class _Job:
    owner: Tuple[str, str]       # ("q"|"a", id)
    role: str                    # figure | full_question | region | answer
    ordinal: int
    page_index: int
    bbox: List[float]
    kind: str                    # "figure" or "region" (crop algorithm)
    meta: dict = field(default_factory=dict)
    crop: Optional[Crop] = None
    sha: Optional[str] = None


def _chunk_order(item: Tuple[Path, dict]) -> Tuple[int, str]:
    path, data = item
    pages = [p.get("page_index") for p in data.get("pages") or [] if isinstance(p, dict)]
    for q in data.get("questions") or []:
        pages += [r.get("page_index") for r in q.get("regions") or [] if isinstance(r, dict)]
    pages = [p for p in pages if isinstance(p, int)]
    return (min(pages) if pages else 10 ** 6, path.name)


def link_answer(paper: str, label: str, questions: Dict[Tuple[str, str], dict],
                has_children: set) -> Tuple[Optional[str], str]:
    """Match a mark-scheme label to a question node. Returns (question label or None, link)."""
    q = questions.get((paper, label))
    if q is not None:
        if (paper, label) in has_children and q["type"] == "context":
            return label, "covers_children"   # key answers 4(a); questions split into 4(a)(i), (ii)
        return label, "exact"
    anc = parent_of(label)
    while anc:
        if (paper, anc) in questions:
            if (paper, anc) not in has_children:
                return anc, "child_of_unsplit"  # key has 4(a)(i); questions kept 4(a) whole
            return None, "unmatched"            # 4(a) was split, but not into this part
        anc = parent_of(anc)
    return None, "unmatched"


def own_review_reasons(item: dict) -> List[str]:
    reasons = list(dict.fromkeys(item.get("review_flags") or []))
    if item.get("confidence") == "low":
        reasons.append("low_confidence")
    return reasons


def review_reasons(questions: List[dict], answers: List[dict]) -> Dict[Tuple[str, str], List[str]]:
    """Why each question node needs review (empty list: ok). A node inherits its ancestors' own
    reasons (their text is shown with it) and the reasons of every answer that applies to it.
    Answers must already carry `_qlabel`/`_link` from link_answer."""
    own = {(q["paper"], q["label"]): own_review_reasons(q) for q in questions}
    by_q: Dict[Tuple[str, str], List[dict]] = defaultdict(list)
    for a in answers:
        if a.get("_qlabel"):
            by_q[(a["paper"], a["_qlabel"])].append(a)
    out = {}
    for q in questions:
        paper, label = q["paper"], q["label"]
        reasons = list(own[(paper, label)])
        applicable = list(by_q[(paper, label)])
        anc = parent_of(label)
        while anc:
            reasons += ["%s: %s" % (anc, r) for r in own.get((paper, anc), [])]
            applicable += [a for a in by_q[(paper, anc)] if a["_link"] == "covers_children"]
            anc = parent_of(anc)
        for a in applicable:
            reasons += ["answer %s: %s" % (a["label"], r) for r in own_review_reasons(a)]
        out[(paper, label)] = reasons
    return out


def _run_crops(conn: sqlite3.Connection, store: AssetStore, document_id: str, jobs: List[_Job]) -> None:
    pages = {r["page_index"]: r for r in conn.execute(
        "SELECT p.page_index, p.img_x0, p.img_y0, p.img_x1, p.img_y1, a.path FROM pages p "
        "JOIN assets a ON a.sha256 = p.asset_sha256 WHERE p.document_id = ?", (document_id,))}
    by_page: Dict[int, List[_Job]] = defaultdict(list)
    for j in jobs:
        by_page[j.page_index].append(j)
    for pi in sorted(by_page):  # one page master in memory at a time
        row = pages.get(pi)
        if row is None:
            for j in by_page[pi]:
                j.crop = Crop(pi, j.bbox, None, None, "failed", "page %d not rasterized" % pi)
            continue
        page = load_page(store.local_path(row["path"]), (row["img_x0"], row["img_y0"], row["img_x1"], row["img_y1"]))
        answer_jobs = [j for j in by_page[pi] if j.role == "answer"]
        for j, crop in zip(answer_jobs, crop_answer_rows(page, pi, [j.bbox for j in answer_jobs])):
            j.crop = crop  # mark-scheme rows are cropped together: neighbours bound each other
        for j in by_page[pi]:
            if j.crop is None:
                j.crop = make_crop(page, pi, j.bbox, j.kind)
            if j.crop.image is not None:
                j.meta["ref"] = put_image(store, j.crop.image)
                j.crop.image = None
        del page


def load_document(conn: sqlite3.Connection, cfg: Config, document_id: str, src_dir: Optional[Path] = None,
                  store: Optional[AssetStore] = None) -> LoadResult:
    store = store or LocalAssetStore(cfg.assets_dir)
    doc = dbm.get_document(conn, document_id)
    if doc is None:
        raise LoadError("document %r is not in the database; run `python -m ingest run <pdf> "
                        "--document-id %s` first" % (document_id, document_id))
    src_dir = Path(src_dir) if src_dir else cfg.extracted_dir(document_id)
    chunks, issues = read_chunks(src_dir)
    topic_codes = {r[0] for r in conn.execute("SELECT code FROM topics")}
    issues += validate(chunks, document_id, doc["page_count"], topic_codes)
    if errors(issues):
        raise ValidationFailed(issues)
    chunks = sorted(chunks, key=_chunk_order)

    # ---- flatten
    pages, papers, questions, answers, extracted_by = [], [], [], [], []
    for path, data in chunks:
        pages += data["pages"]
        papers += data["papers"]
        for q in data["questions"]:
            questions.append(dict(q, _chunk=data.get("chunk") or path.stem))
        answers += data["answers"]
        if data.get("extracted_by") and data["extracted_by"] not in extracted_by:
            extracted_by.append(data["extracted_by"])

    qmap = {(q["paper"], q["label"]): q for q in questions}
    has_children = {(q["paper"], q["parent_label"]) for q in questions if q.get("parent_label")}
    for seq, q in enumerate(questions):
        root = q["label"].split("(")[0]
        q["_id"] = dbm.question_id(document_id, q["paper"], q["label"])
        q["_root_id"] = dbm.question_id(document_id, q["paper"], root)
        q["_parent_id"] = dbm.question_id(document_id, q["paper"], q["parent_label"]) if q.get("parent_label") else None
        q["_depth"] = q["label"].count("(")
        q["_leaf"] = (q["paper"], q["label"]) not in has_children
        q["_sort"] = "%s|%04d|%06d" % (q["paper"], int(root), seq)

    # ---- crop jobs
    jobs: List[_Job] = []
    for q in questions:
        owner = ("q", q["_id"])
        for i, f in enumerate(q.get("figures") or []):
            jobs.append(_Job(owner, "figure", i, f["page_index"], f["bbox"], "figure", {"fig": f}))
        if q.get("parent_label") is None:
            full = q.get("full_regions") or q.get("regions") or []
            for i, r in enumerate(full):
                jobs.append(_Job(owner, "full_question", i, r["page_index"], r["bbox"], "region"))
        if q.get("parent_label") is not None or not q["_leaf"]:
            for i, r in enumerate(q.get("regions") or []):
                jobs.append(_Job(owner, "region", i, r["page_index"], r["bbox"], "region"))
    for a in answers:
        a["_id"] = dbm.answer_id(document_id, a["paper"], a["label"])
        for i, r in enumerate(a.get("regions") or []):
            jobs.append(_Job(("a", a["_id"]), "answer", i, r["page_index"], r["bbox"], "region"))
    _run_crops(conn, store, document_id, jobs)  # files only; DB untouched until the transaction

    # ---- one transaction: delete this document's rows, insert everything again
    conn.execute("BEGIN")
    try:
        _delete_document_rows(conn, document_id)
        _insert(conn, document_id, pages, papers, questions, answers, qmap, has_children, jobs)
        conn.execute("UPDATE documents SET extracted_by = ?, loaded_at = ? WHERE id = ?",
                     (", ".join(extracted_by) or None, dbm.utcnow(), document_id))
        n_indexed = index_document(conn, document_id)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    counts = {"questions": len(questions), "answers": len(answers), "pages": len(pages),
              "crops": sum(1 for j in jobs if j.sha), "crop_problems": sum(1 for j in jobs if j.crop.status != "ok"),
              "indexed": n_indexed}
    return LoadResult(document_id, issues, counts)


def _delete_document_rows(conn: sqlite3.Connection, document_id: str) -> None:
    conn.execute("DELETE FROM questions_fts WHERE document_id = ?", (document_id,))
    sub = "SELECT id FROM questions WHERE document_id = ?"
    for table in ("question_topics", "question_options", "question_assets"):
        conn.execute("DELETE FROM %s WHERE question_id IN (%s)" % (table, sub), (document_id,))
    conn.execute("DELETE FROM answer_assets WHERE answer_id IN (SELECT id FROM answers WHERE document_id = ?)",
                 (document_id,))
    conn.execute("DELETE FROM answers WHERE document_id = ?", (document_id,))
    conn.execute("DELETE FROM questions WHERE document_id = ?", (document_id,))
    conn.execute("DELETE FROM papers WHERE document_id = ?", (document_id,))
    conn.execute("DELETE FROM choice_groups WHERE document_id = ?", (document_id,))
    conn.execute("UPDATE pages SET printed_page_number = NULL, page_type = NULL, paper = NULL, "
                 "has_handwriting = 0, notes = NULL WHERE document_id = ?", (document_id,))


def _bbox_json(b) -> Optional[str]:
    return json.dumps(b) if b is not None else None


def _insert(conn, document_id, pages, papers, questions, answers, qmap, has_children, jobs) -> None:
    for p in pages:
        printed = p.get("printed_page_number")
        conn.execute(
            "UPDATE pages SET printed_page_number = ?, page_type = ?, paper = ?, has_handwriting = ?, notes = ? "
            "WHERE document_id = ? AND page_index = ?",
            (None if printed is None else str(printed), p.get("page_type"), p.get("paper"),
             int(bool(p.get("has_handwriting"))), p.get("notes") or None, document_id, p["page_index"]))
    for p in papers:
        conn.execute(
            "INSERT INTO papers (document_id, paper, paper_code, school, exam, year, level, subject, date, "
            "duration_minutes, total_marks, instructions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (document_id, p["paper"], p.get("paper_code"), p.get("school"), p.get("exam"), p.get("year"),
             p.get("level"), p.get("subject"), p.get("date"), p.get("duration_minutes"), p.get("total_marks"),
             p.get("instructions")))
        for g in p.get("choice_groups") or []:
            conn.execute("INSERT INTO choice_groups (document_id, paper, group_id, choose, note) VALUES (?,?,?,?,?)",
                         (document_id, p["paper"], g["id"], g["choose"], g.get("note")))
    for a in answers:
        a["_qlabel"], a["_link"] = link_answer(a["paper"], a["label"], qmap, has_children)
    reasons = review_reasons(questions, answers)
    for q in sorted(questions, key=lambda q: q["_depth"]):  # parents before children (FK)
        why = reasons[(q["paper"], q["label"])]
        conn.execute(
            "INSERT INTO questions (id, document_id, paper, parent_id, root_id, label, depth, sort_key, is_leaf, "
            "section, type, stem, marks, answer_space, has_handwriting, confidence, notes, chunk, choice_group, "
            "review_flags, review_status, review_reasons) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (q["_id"], document_id, q["paper"], q["_parent_id"], q["_root_id"], q["label"], q["_depth"], q["_sort"],
             int(q["_leaf"]), q.get("section"), q["type"], q["stem"], q.get("marks"), q.get("answer_space"),
             int(bool(q.get("has_handwriting"))), q.get("confidence"), q.get("notes") or None, q["_chunk"],
             q.get("choice_group"), json.dumps(q.get("review_flags") or []),
             "needs_review" if why else "ok", json.dumps(why)))
        for i, o in enumerate(q.get("options") or [] if q["type"] == "mcq" else []):
            conn.execute("INSERT INTO question_options (question_id, label, text, ordinal) VALUES (?,?,?,?)",
                         (q["_id"], o["label"], o["text"], i))
        for rank, code in enumerate(dict.fromkeys(q.get("topics") or []), start=1):
            conn.execute("INSERT INTO question_topics (question_id, topic_code, rank) VALUES (?,?,?)",
                         (q["_id"], code, rank))

    kind_of = {"figure": "figure", "full_question": "question", "region": "question", "answer": "answer"}
    for j in jobs:
        ref = j.meta.get("ref")
        j.sha = register(conn, ref, kind_of[j.role]) if ref else None
    for a in answers:
        qid = qmap[(a["paper"], a["_qlabel"])]["_id"] if a["_qlabel"] else None
        conn.execute(
            "INSERT INTO answers (id, document_id, paper, label, question_id, link, correct_option, answer_text, "
            "marks, page_index, notes, confidence, review_flags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (a["_id"], document_id, a["paper"], a["label"], qid, a["_link"], a.get("correct_option"),
             a.get("answer_text"), a.get("marks"), a.get("page_index"), a.get("notes") or None,
             a.get("confidence"), json.dumps(a.get("review_flags") or [])))
    for j in jobs:
        c = j.crop
        if j.owner[0] == "a":
            conn.execute(
                "INSERT INTO answer_assets (answer_id, ordinal, asset_sha256, page_index, bbox_raw, bbox_snapped, "
                "status, status_detail) VALUES (?,?,?,?,?,?,?,?)",
                (j.owner[1], j.ordinal, j.sha, c.page_index, _bbox_json(c.bbox_raw), _bbox_json(c.bbox_snapped),
                 c.status, c.detail or None))
            continue
        f = j.meta.get("fig") or {}
        conn.execute(
            "INSERT INTO question_assets (question_id, role, ordinal, asset_sha256, figure_id, figure_kind, caption, "
            "description, page_index, bbox_raw, bbox_snapped, status, status_detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (j.owner[1], j.role, j.ordinal, j.sha, f.get("id"), f.get("kind"), f.get("caption"),
             f.get("description"), c.page_index, _bbox_json(c.bbox_raw), _bbox_json(c.bbox_snapped),
             c.status, c.detail or None))
