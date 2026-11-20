"""Quality report for one loaded document: what to review before trusting the extraction."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterable, List, Optional

from ingest.validate import Issue


def _labels(rows) -> List[str]:
    return ["%s %s" % (r["paper"], r["label"]) for r in rows]


def _counted_marks(conn: sqlite3.Connection, document_id: str, paper: str):
    """Marks a candidate can score: every top-level question, except that each choice group
    contributes only its `choose` highest-mark members."""
    per_root = {r[0]: (r[1], r[2] or 0) for r in conn.execute(
        "SELECT r.label, r.choice_group, (SELECT SUM(COALESCE(x.marks, 0)) FROM questions x WHERE x.root_id = r.id "
        "AND x.type IN ('mcq', 'structured')) FROM questions r WHERE r.document_id = ? AND r.paper = ? "
        "AND r.parent_id IS NULL", (document_id, paper))}
    total = sum(m for g, m in per_root.values() if g is None)
    groups = []
    for gid, choose, note in conn.execute(
            "SELECT group_id, choose, note FROM choice_groups WHERE document_id = ? AND paper = ? ORDER BY group_id",
            (document_id, paper)):
        members = sorted(((m, label) for label, (g, m) in per_root.items() if g == gid), reverse=True)
        counted = sum(m for m, _ in members[:choose])
        total += counted
        groups.append({"id": gid, "choose": choose, "note": note, "members": sorted((l for _, l in members), key=int),
                       "marks_counted": counted})
    # members of an undeclared group (validation rejects this) are counted in full
    declared = {g["id"] for g in groups}
    total += sum(m for g, m in per_root.values() if g is not None and g not in declared)
    return total, groups


def build_report(conn: sqlite3.Connection, document_id: str, issues: Optional[Iterable[Issue]] = None) -> dict:
    doc = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
    if doc is None:
        raise KeyError("unknown document %r" % document_id)
    issues = list(issues or [])
    q = lambda sql, *p: conn.execute(sql, (document_id,) + p).fetchall()

    papers = []
    paper_codes = [r[0] for r in q("SELECT paper FROM questions WHERE document_id = ? UNION "
                                   "SELECT paper FROM papers WHERE document_id = ? ORDER BY 1", document_id)]
    for p in paper_codes:
        meta = conn.execute("SELECT * FROM papers WHERE document_id = ? AND paper = ?", (document_id, p)).fetchone()
        stats = q("SELECT COUNT(*) AS n, SUM(is_leaf) AS leaves, SUM(type = 'mcq') AS mcq, "
                  "SUM(CASE WHEN type IN ('mcq', 'structured') THEN COALESCE(marks, 0) ELSE 0 END) AS marks "
                  "FROM questions WHERE document_id = ? AND paper = ?", p)[0]
        figures = q("SELECT COUNT(*) FROM question_assets a JOIN questions x ON x.id = a.question_id "
                    "WHERE x.document_id = ? AND x.paper = ? AND a.role = 'figure'", p)[0][0]
        answers = q("SELECT COUNT(*) FROM answers WHERE document_id = ? AND paper = ?", p)[0][0]
        total = meta["total_marks"] if meta else None
        by_section = {(r[0] or "-"): r[1] for r in q(
            "SELECT section, SUM(COALESCE(marks, 0)) FROM questions WHERE document_id = ? AND paper = ? "
            "AND type IN ('mcq', 'structured') GROUP BY section ORDER BY section", p)}
        counted, groups = _counted_marks(conn, document_id, p)
        papers.append({
            "paper": p, "paper_code": meta["paper_code"] if meta else None,
            "questions": stats["n"], "leaves": stats["leaves"] or 0, "mcq": stats["mcq"] or 0,
            "figures": figures, "answers": answers,
            "marks_sum": counted, "marks_sum_all_questions": stats["marks"] or 0,
            "total_marks": total, "marks_match": None if total is None else counted == total,
            "marks_by_section": by_section, "choice_groups": groups,
        })

    # Answerable nodes (mcq/structured) with no answer: own, from a covering ancestor, or none at all.
    unanswered = q(
        "SELECT x.paper, x.label FROM questions x WHERE x.document_id = ? AND x.type IN ('mcq', 'structured') "
        "AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id = x.id) "
        "AND NOT EXISTS (SELECT 1 FROM answers a JOIN questions anc ON anc.id = a.question_id "
        "  WHERE a.link = 'covers_children' AND x.document_id = anc.document_id AND x.paper = anc.paper "
        "  AND x.label LIKE anc.label || '(%') "
        "AND NOT EXISTS (SELECT 1 FROM questions c WHERE c.parent_id = x.id) "
        "ORDER BY x.sort_key")
    mismatches = [{"paper": r["paper"], "label": r["label"], "link": r["link"], "linked_to": r["qlabel"]}
                  for r in q("SELECT a.paper, a.label, a.link, x.label AS qlabel FROM answers a "
                             "LEFT JOIN questions x ON x.id = a.question_id "
                             "WHERE a.document_id = ? AND a.link IN ('covers_children', 'child_of_unsplit') "
                             "ORDER BY a.paper, a.label")]
    orphans = q("SELECT paper, label FROM answers WHERE document_id = ? AND link = 'unmatched' ORDER BY paper, label")
    low = q("SELECT paper, label, notes FROM questions WHERE document_id = ? AND confidence = 'low' ORDER BY sort_key")
    untagged = q("SELECT x.paper, x.label FROM questions x WHERE x.document_id = ? AND x.is_leaf = 1 "
                 "AND NOT EXISTS (SELECT 1 FROM question_topics t WHERE t.question_id = x.id) ORDER BY x.sort_key")
    crop_problems = [dict(r) for r in q(
        "SELECT x.paper, x.label, a.role, a.ordinal, a.page_index, a.status, a.status_detail AS detail "
        "FROM question_assets a JOIN questions x ON x.id = a.question_id "
        "WHERE x.document_id = ? AND a.status != 'ok' "
        "UNION ALL SELECT n.paper, n.label, 'answer', a.ordinal, a.page_index, a.status, a.status_detail "
        "FROM answer_assets a JOIN answers n ON n.id = a.answer_id WHERE n.document_id = ? AND a.status != 'ok' "
        "ORDER BY 1, 2", document_id)]
    review = [{"question": "%s %s" % (r["paper"], r["label"]), "id": r["id"],
               "reasons": json.loads(r["review_reasons"] or "[]")}
              for r in q("SELECT id, paper, label, review_reasons FROM questions WHERE document_id = ? "
                         "AND review_status = 'needs_review' ORDER BY sort_key")]
    hw_q = q("SELECT COUNT(*) FROM questions WHERE document_id = ? AND has_handwriting = 1")[0][0]
    hw_p = q("SELECT COUNT(*) FROM pages WHERE document_id = ? AND has_handwriting = 1")[0][0]
    medium = q("SELECT COUNT(*) FROM questions WHERE document_id = ? AND confidence = 'medium'")[0][0]

    return {
        "document_id": document_id, "source_pdf": doc["source_pdf"], "sha256": doc["sha256"],
        "page_count": doc["page_count"], "extracted_by": doc["extracted_by"], "loaded_at": doc["loaded_at"],
        "papers": papers,
        "questions_without_answers": _labels(unanswered),
        "answers_without_questions": _labels(orphans),
        "answer_granularity_mismatches": mismatches,
        "low_confidence": [{"question": "%s %s" % (r["paper"], r["label"]), "notes": r["notes"]} for r in low],
        "medium_confidence_count": medium,
        "handwriting_flagged": {"questions": hw_q, "pages": hw_p},
        "untagged_leaves": _labels(untagged),
        "needs_review": review,
        "crop_problems": crop_problems,
        "validation": {"errors": [i.as_dict() for i in issues if i.level == "error"],
                       "warnings": [i.as_dict() for i in issues if i.level == "warning"]},
    }


def save_report(report: dict, reports_dir: Path) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    path = reports_dir / ("%s.json" % report["document_id"])
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def _short(items: List[str], n: int = 12) -> str:
    return ", ".join(items[:n]) + (" ... (+%d more)" % (len(items) - n) if len(items) > n else "")


def format_report(r: dict) -> str:
    lines = ["Quality report: %s  (%d pages, extracted by %s)" % (r["document_id"], r["page_count"], r["extracted_by"]),
             "",
             "  %-5s %-8s %9s %6s %4s %7s %7s %13s" % ("paper", "code", "questions", "leaves", "mcq", "figures",
                                                     "answers", "marks/total")]
    for p in r["papers"]:
        total = "-" if p["total_marks"] is None else str(p["total_marks"])
        flag = "" if p["marks_match"] in (True, None) else "  <-- marks mismatch (by section: %s)" \
            % ", ".join("%s=%s" % kv for kv in p["marks_by_section"].items())
        for g in p.get("choice_groups") or []:
            flag += "  (choice group %s: best %d of %s)" % (g["id"], g["choose"], ", ".join(g["members"]))
        lines.append("  %-5s %-8s %9d %6d %4d %7d %7d %13s%s" % (
            p["paper"], p["paper_code"] or "-", p["questions"], p["leaves"], p["mcq"], p["figures"],
            p["answers"], "%d/%s" % (p["marks_sum"], total), flag))
    lines.append("")

    def section(title: str, items: List[str]) -> None:
        lines.append("  %-34s %d%s" % (title + ":", len(items), ("  " + _short(items)) if items else ""))

    section("questions without answers", r["questions_without_answers"])
    section("answers without questions", r["answers_without_questions"])
    section("answer granularity mismatches", ["%s %s (%s -> %s)" % (m["paper"], m["label"], m["link"], m["linked_to"])
                                              for m in r["answer_granularity_mismatches"]])
    section("low-confidence questions", [x["question"] for x in r["low_confidence"]])
    lines.append("  %-34s %d" % ("medium-confidence questions:", r["medium_confidence_count"]))
    lines.append("  %-34s %d questions, %d pages" % ("handwriting flagged:", r["handwriting_flagged"]["questions"],
                                                     r["handwriting_flagged"]["pages"]))
    section("untagged leaves", r["untagged_leaves"])
    section("needs review (hidden from search)", ["%s (%s)" % (x["question"], ", ".join(x["reasons"]))
                                                  for x in r["needs_review"]])
    section("crop problems", ["%s %s %s#%d (%s)" % (c["paper"], c["label"], c["role"], c["ordinal"], c["status"])
                              for c in r["crop_problems"]])
    v = r["validation"]
    lines.append("  %-34s %d errors, %d warnings" % ("validation:", len(v["errors"]), len(v["warnings"])))
    for i in v["errors"] + v["warnings"][:20]:
        lines.append("    " + str(Issue(**i)))
    if len(v["warnings"]) > 20:
        lines.append("    ... %d more warnings in the JSON report" % (len(v["warnings"]) - 20))
    return "\n".join(lines)
