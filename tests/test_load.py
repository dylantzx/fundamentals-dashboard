from __future__ import annotations

import json

import pytest

from conftest import DOC_ID, region, write_contract
from ingest import db as dbm
from ingest.load import ValidationFailed, load_document
from ingest.report import build_report

TABLES = ["documents", "pages", "papers", "questions", "question_options", "question_assets", "answers",
          "answer_assets", "question_topics", "assets", "questions_fts"]


def snapshot(conn):
    counts = {t: conn.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0] for t in TABLES}
    ids = [r[0] for r in conn.execute("SELECT id FROM questions ORDER BY id")]
    aids = [r[0] for r in conn.execute("SELECT id, question_id, link FROM answers ORDER BY id")]
    crops = [tuple(r) for r in conn.execute(
        "SELECT question_id, role, ordinal, asset_sha256 FROM question_assets ORDER BY 1, 2, 3")]
    return counts, ids, aids, crops


def test_load_is_idempotent(cfg, loaded):
    conn, result, src = loaded
    before = snapshot(conn)
    files = sorted(p for p in cfg.assets_dir.rglob("*") if p.is_file())
    load_document(conn, cfg, DOC_ID, src_dir=src)
    assert snapshot(conn) == before
    assert sorted(p for p in cfg.assets_dir.rglob("*") if p.is_file()) == files
    assert before[0]["questions"] == 7 and before[0]["answers"] == 5 and before[0]["questions_fts"] == 7


def test_ids_are_deterministic(loaded):
    conn = loaded[0]
    row = conn.execute("SELECT id, root_id, parent_id, depth, is_leaf FROM questions WHERE label = '1(b)(ii)'").fetchone()
    assert row["id"] == dbm.question_id(DOC_ID, "P2", "1(b)(ii)")
    assert row["root_id"] == dbm.question_id(DOC_ID, "P2", "1")
    assert row["parent_id"] == dbm.question_id(DOC_ID, "P2", "1(b)")
    assert (row["depth"], row["is_leaf"]) == (2, 1)


def test_tree_and_crops(loaded):
    conn = loaded[0]
    root = dbm.question_id(DOC_ID, "P2", "1")
    full = conn.execute("SELECT page_index, status, asset_sha256 FROM question_assets "
                        "WHERE question_id = ? AND role = 'full_question' ORDER BY ordinal", (root,)).fetchall()
    assert [r[0] for r in full] == [0, 1] and all(r[1] == "ok" and r[2] for r in full)  # one crop per page
    fig = conn.execute("SELECT figure_id, caption, bbox_raw, bbox_snapped FROM question_assets "
                       "WHERE question_id = ? AND role = 'figure'", (root,)).fetchone()
    assert fig["figure_id"] == "fig-1.1" and json.loads(fig["bbox_raw"]) != json.loads(fig["bbox_snapped"])
    multi = conn.execute("SELECT page_index FROM question_assets WHERE question_id = ? AND role = 'region' "
                         "ORDER BY ordinal", (dbm.question_id(DOC_ID, "P2", "1(b)(ii)"),)).fetchall()
    assert [r[0] for r in multi] == [0, 1]
    kinds = dict(conn.execute("SELECT kind, COUNT(*) FROM assets GROUP BY kind").fetchall())
    assert set(kinds) == {"page", "figure", "question", "answer"}
    opts = conn.execute("SELECT label, text FROM question_options WHERE question_id = ? ORDER BY ordinal",
                        (dbm.question_id(DOC_ID, "P1", "1"),)).fetchall()
    assert [o[0] for o in opts] == ["A", "B", "C", "D"]
    page1 = conn.execute("SELECT page_type, paper, has_handwriting FROM pages WHERE page_index = 1").fetchone()
    assert tuple(page1) == ("questions", "P2", 1)


def test_answer_linking_and_granularity(loaded):
    conn = loaded[0]
    links = {r["label"]: (r["link"], r["qlabel"]) for r in conn.execute(
        "SELECT a.label, a.link, q.label AS qlabel FROM answers a LEFT JOIN questions q ON q.id = a.question_id")}
    assert links == {
        "1": ("exact", "1"),                         # P1 MCQ
        "1(a)": ("exact", "1(a)"),
        "1(b)": ("covers_children", "1(b)"),         # key row covers 1(b)(i) and 1(b)(ii)
        "1(c)(i)": ("child_of_unsplit", "1(c)"),     # key split 1(c), the questions did not
        "1(c)(ii)": ("child_of_unsplit", "1(c)"),
    }
    from ingest.search import effective_answers
    leaf = dbm.question_id(DOC_ID, "P2", "1(b)(i)")
    assert [a["label"] for a in effective_answers(conn, leaf)] == ["1(b)"]
    rep = build_report(conn, DOC_ID)
    assert rep["questions_without_answers"] == [] and rep["answers_without_questions"] == []
    assert len(rep["answer_granularity_mismatches"]) == 3
    p = {x["paper"]: x for x in rep["papers"]}
    assert (p["P2"]["marks_sum"], p["P2"]["total_marks"], p["P2"]["marks_match"]) == (6, 6, True)
    assert (p["P2"]["leaves"], p["P2"]["figures"], p["P1"]["mcq"]) == (4, 1, 1)
    assert rep["low_confidence"][0]["question"] == "P2 1(c)"
    assert rep["handwriting_flagged"] == {"questions": 1, "pages": 1}
    assert rep["crop_problems"] == []


def test_unmatched_answer_and_missing_answer_are_reported(cfg, loaded, contract, tmp_path):
    conn = loaded[0]
    answers = contract["b.json"]["answers"]
    answers.append({"paper": "P2", "label": "7", "correct_option": None, "answer_text": "x", "marks": 1,
                    "page_index": 1, "regions": []})
    contract["b.json"]["answers"] = [a for a in answers if a["label"] != "1(a)"]
    src = write_contract(tmp_path / "json2", contract)
    load_document(conn, cfg, DOC_ID, src_dir=src)
    rep = build_report(conn, DOC_ID)
    assert rep["answers_without_questions"] == ["P2 7"]
    assert rep["questions_without_answers"] == ["P2 1(a)"]


def test_invalid_json_leaves_database_unchanged(cfg, loaded, contract, tmp_path):
    conn = loaded[0]
    before = snapshot(conn)
    contract["a.json"]["questions"][2]["label"] = "1 (a)"
    src = write_contract(tmp_path / "bad", contract)
    with pytest.raises(ValidationFailed) as e:
        load_document(conn, cfg, DOC_ID, src_dir=src)
    assert any("did you mean '1(a)'" in str(i) for i in e.value.issues)
    assert snapshot(conn) == before


def test_reload_after_edit_replaces_rows(cfg, loaded, contract, tmp_path):
    conn = loaded[0]
    contract["a.json"]["questions"][2]["stem"] = "Name the colourless gas produced."
    del contract["a.json"]["questions"][0]  # MCQ removed in the edited JSON
    contract["b.json"]["answers"] = [a for a in contract["b.json"]["answers"] if a["paper"] != "P1"]
    load_document(conn, cfg, DOC_ID, src_dir=write_contract(tmp_path / "edit", contract))
    assert conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 6
    assert conn.execute("SELECT stem FROM questions WHERE id = ?",
                        (dbm.question_id(DOC_ID, "P2", "1(a)"),)).fetchone()[0].startswith("Name the colourless")
    assert conn.execute("SELECT COUNT(*) FROM questions_fts").fetchone()[0] == 6


def _choice_contract(contract):
    """P2 gains a Section B: answer one of Q2 (3 marks) or Q3 (4 marks)."""
    p2 = contract["a.json"]["papers"][1]
    p2["choice_groups"] = [{"id": "B", "choose": 1, "note": "Answer one question from this section."}]
    p2["total_marks"] = 10                                      # 6 (Q1) + best of Q2/Q3 (4)
    base = dict(contract["b.json"]["questions"][0], confidence="high", has_handwriting=False, notes="",
                parent_label=None, section="B", choice_group="B")
    contract["b.json"]["questions"] += [
        dict(base, label="2", marks=3, stem="Describe a test for chloride ions.", topics=["6.1"],
             regions=[region(1, 0.14, 0.19)], full_regions=[region(1, 0.14, 0.19)]),
        dict(base, label="3", marks=4, stem="Describe a test for ammonia.", topics=["6.2"],
             regions=[region(1, 0.14, 0.19)], full_regions=[region(1, 0.14, 0.19)]),
    ]
    contract["b.json"]["answers"] += [
        {"paper": "P2", "label": "2", "correct_option": None, "answer_text": "white precipitate (1)", "marks": 3,
         "page_index": 1, "regions": [], "confidence": "high", "review_flags": []},
        {"paper": "P2", "label": "3", "correct_option": None, "answer_text": "turns red litmus blue (1)",
         "marks": 4, "page_index": 1, "regions": [], "confidence": "high", "review_flags": []},
    ]
    return contract


def test_choice_groups_count_only_chosen_members(cfg, loaded, contract, tmp_path):
    conn = loaded[0]
    load_document(conn, cfg, DOC_ID, src_dir=write_contract(tmp_path / "cg", _choice_contract(contract)))
    assert [tuple(r) for r in conn.execute("SELECT group_id, choose FROM choice_groups")] == [("B", 1)]
    assert conn.execute("SELECT choice_group FROM questions WHERE label = '3' AND paper = 'P2'").fetchone()[0] == "B"
    p2 = [p for p in build_report(conn, DOC_ID)["papers"] if p["paper"] == "P2"][0]
    assert (p2["marks_sum"], p2["total_marks"], p2["marks_match"]) == (10, 10, True)
    assert p2["marks_sum_all_questions"] == 13
    assert p2["choice_groups"][0]["members"] == ["2", "3"] and p2["choice_groups"][0]["marks_counted"] == 4


def test_choice_group_validation(cfg, rasterized, contract, tmp_path):
    c = _choice_contract(contract)
    c["b.json"]["questions"][1]["choice_group"] = "C"                 # undeclared
    c["a.json"]["questions"][2]["choice_group"] = "B"                 # 1(a) is not top-level
    with pytest.raises(ValidationFailed) as e:
        load_document(rasterized[0], cfg, DOC_ID, src_dir=write_contract(tmp_path / "bad", c))
    msgs = [str(i) for i in e.value.issues if i.level == "error"]
    assert any("question P2 2: choice_group 'C' is not declared" in m for m in msgs), msgs
    assert any("question P2 1(a): choice_group is only allowed on top-level" in m for m in msgs), msgs


def _status(conn):
    return {r[0]: (r[1], json.loads(r[2])) for r in conn.execute(
        "SELECT paper || ' ' || label, review_status, review_reasons FROM questions")}


def test_review_status(cfg, loaded, contract, tmp_path):
    conn = loaded[0]
    st = _status(conn)
    assert st["P2 1(c)"] == ("needs_review", ["low_confidence"])     # fixture: confidence low
    assert st["P2 1(a)"] == ("ok", [])
    contract["a.json"]["questions"][0]["review_flags"] = ["source_defect"]          # MCQ itself
    contract["a.json"]["questions"][3]["review_flags"] = ["illegible"]              # context 1(b)
    contract["b.json"]["answers"][1]["review_flags"] = ["answer_mismatch"]           # answer for 1(a)
    contract["b.json"]["answers"][4]["confidence"] = "low"                          # 1(c)(ii) -> 1(c)
    contract["b.json"]["questions"][0]["confidence"] = "high"
    load_document(conn, cfg, DOC_ID, src_dir=write_contract(tmp_path / "rv", contract))
    st = _status(conn)
    assert st["P1 1"] == ("needs_review", ["source_defect"])
    assert st["P2 1(b)"] == ("needs_review", ["illegible"])
    assert st["P2 1(b)(i)"] == ("needs_review", ["1(b): illegible"])               # inherits ancestor flags
    assert st["P2 1(a)"] == ("needs_review", ["answer 1(a): answer_mismatch"])
    assert st["P2 1(c)"] == ("needs_review", ["answer 1(c)(ii): low_confidence"])
    assert st["P2 1"] == ("ok", [])
    rep = build_report(conn, DOC_ID)
    assert {x["question"] for x in rep["needs_review"]} == {"P1 1", "P2 1(a)", "P2 1(b)", "P2 1(b)(i)",
                                                            "P2 1(b)(ii)", "P2 1(c)"}
    flags = conn.execute("SELECT review_flags, confidence FROM answers WHERE label = '1(a)'").fetchone()
    assert json.loads(flags[0]) == ["answer_mismatch"] and flags[1] == "high"
