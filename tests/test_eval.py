"""Tests for ingest/eval.py on small synthetic gold / predicted chunk sets."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from ingest.eval import DEFAULT_THRESHOLDS, evaluate, format_report, iou, similarity


def q(paper: str, label: str, type_: str = "structured", marks: Any = 1, stem: str = "", options=None,
      topics=None, figures=None) -> Dict[str, Any]:
    i = label.rfind("(")
    return {"paper": paper, "section": None, "label": label, "parent_label": label[:i] if i > 0 else None,
            "type": type_, "stem": stem or f"Stem of {paper} {label}.", "options": options or [],
            "marks": marks, "regions": [{"page_index": 1, "bbox": [0.1, 0.1, 0.9, 0.2]}],
            "figures": figures or [], "topics": topics if topics is not None else ["4.1"],
            "has_handwriting": False, "confidence": "high", "notes": ""}


def mcq(label: str, texts: List[str], topic: str = "4.1") -> Dict[str, Any]:
    return q("P1", label, "mcq", 1, f"Which statement about item {label} is correct?",
             [{"label": l, "text": t} for l, t in zip("ABCD", texts)], [topic])


def ans(paper: str, label: str, opt: Any = None, text: Any = None) -> Dict[str, Any]:
    return {"paper": paper, "label": label, "correct_option": opt, "answer_text": text, "marks": 1,
            "page_index": 9, "regions": [{"page_index": 9, "bbox": [0.1, 0.1, 0.5, 0.2]}]}


def chunk(name: str, pages=(), questions=(), answers=()) -> Dict[str, Any]:
    return {"contract_version": 1, "document_id": "d", "source_pdf": "x.pdf", "chunk": name, "extracted_by": "human",
            "pages": list(pages), "papers": [], "questions": list(questions), "answers": list(answers)}


def page(i: int, t: str, paper: str = "P1") -> Dict[str, Any]:
    return {"page_index": i, "paper": paper, "printed_page_number": None, "page_type": t,
            "has_handwriting": False, "notes": ""}


FIG = {"id": "fig-1.1", "page_index": 2, "bbox": [0.2, 0.1, 0.8, 0.3], "kind": "diagram", "caption": "Fig. 1.1",
       "description": "apparatus"}


def gold_set() -> Dict[str, Dict[str, Any]]:
    p1 = [mcq("1", ["CO₂", "O₂", "H₂", "N₂"]), mcq("2", ["1 and 2 only", "1 and 3 only", "2 and 3 only", "1, 2 and 3"]),
          mcq("3", ["Na⁺", "Mg²⁺", "Al³⁺", "Cl⁻"], "3.1"), mcq("4", ["A", "B", "C", "D"], "11.2")]
    p1[3]["stem"] = "Which compound is an alkene? Ethene, C₂H₄, decolourises aqueous bromine."
    p2 = [q("P2", "1", "context", None, "Fig. 1.1 shows the apparatus.", topics=[], figures=[FIG]),
          q("P2", "1(a)", topics=["10.1"]), q("P2", "1(b)", "context", None, topics=[]),
          q("P2", "1(b)(i)", marks=2, topics=["10.2", "10.1"]), q("P2", "1(b)(ii)", topics=["10.2"])]
    answers = [ans("P1", "1", "A"), ans("P1", "2", "B"), ans("P1", "3", "C"), ans("P1", "4", "D"),
               ans("P2", "1(a)", text="carbon dioxide (1)"),
               ans("P2", "1(b)(i)", text="gas escapes (1) mass decreases (1)"),
               ans("P2", "1(b)(ii)", text="faster (1)")]
    return {
        "p1.json": chunk("p1", [page(0, "cover"), page(1, "questions")], p1),
        "p2.json": chunk("p2", [page(2, "questions", "P2")], p2),
        "key.json": chunk("key", [page(9, "answer_key", None)], answers=answers),
    }


def pred_set() -> Dict[str, Dict[str, Any]]:
    """The gold set with known mistakes, chunked differently (one file per paper + answers split)."""
    g = gold_set()
    p1 = copy.deepcopy(g["p1.json"]["questions"])
    p1[1]["options"][2]["text"] = "2 and 3"                     # one MCQ option text differs
    p1[3]["stem"] = "Which compound is an alkane?"              # stem differs
    p1[2]["topics"] = ["3.2"]                                    # same top-level topic, other subtopic
    p2 = copy.deepcopy(g["p2.json"]["questions"])
    p2 = [x for x in p2 if x["label"] != "1(b)(ii)"]            # missing leaf
    p2.append(q("P2", "1(c)", topics=["4.3"]))                  # extra leaf
    p2[1]["marks"] = 2                                          # 1(a) marks wrong
    p2[0]["figures"] = [dict(FIG, bbox=[0.25, 0.1, 0.85, 0.3])]  # figure box shifted
    a = copy.deepcopy(g["key.json"]["answers"])
    a[2]["correct_option"] = "B"                                 # P1 3 wrong
    a = [x for x in a if x["label"] != "1(b)(ii)"]              # answer missing
    a[4]["answer_text"] = "carbon dioxide gas (1)"
    pages = [page(0, "cover"), page(1, "other"), page(2, "questions", "P2"), page(9, "answer_key", None)]
    return {
        "a.json": chunk("a", pages[:2], p1, a[:2]),
        "b.json": chunk("b", pages[2:], p2, a[2:]),
    }


def write(d: Path, files: Dict[str, Dict[str, Any]]) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (d / name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return d


@pytest.fixture
def dirs(tmp_path: Path):
    return write(tmp_path / "gold", gold_set()), write(tmp_path / "pred", pred_set())


def test_perfect_prediction_passes(tmp_path: Path) -> None:
    g = write(tmp_path / "gold", gold_set())
    r = evaluate(g, g)
    assert r["passed"] is True
    allm = r["papers"]["ALL"]
    for k in ["label_f1", "leaf_label_f1", "type_accuracy", "marks_accuracy", "mcq_option_exact",
              "mcq_answer_accuracy", "answer_coverage", "answer_text_similarity", "stem_similarity",
              "topic_top_agreement", "topic_jaccard", "figure_count_agreement", "figure_iou_mean"]:
        assert allm[k] == pytest.approx(1.0), k
    assert r["pages"]["page_type_accuracy"] == 1.0
    assert "RESULT: PASS" in format_report(r)


def test_label_metrics(dirs) -> None:
    r = evaluate(*dirs)
    allm, p1, p2 = r["papers"]["ALL"], r["papers"]["P1"], r["papers"]["P2"]
    assert set(r["papers"]) == {"ALL", "P1", "P2"}
    assert allm["label_f1"] == pytest.approx(8 / 9)
    assert allm["leaf_label_precision"] == pytest.approx(6 / 7)
    assert allm["leaf_label_recall"] == pytest.approx(6 / 7)
    assert p1["label_f1"] == 1.0 and p1["leaf_label_f1"] == 1.0
    assert p2["label_f1"] == pytest.approx(0.8)
    assert p2["leaf_label_f1"] == pytest.approx(2 / 3)
    assert allm["missing_labels"] == ["P2 1(b)(ii)"] and allm["extra_labels"] == ["P2 1(c)"]
    assert allm["type_accuracy"] == 1.0


def test_marks_options_answers(dirs) -> None:
    r = evaluate(*dirs)
    allm, p1 = r["papers"]["ALL"], r["papers"]["P1"]
    assert allm["marks_accuracy"] == pytest.approx(5 / 6)
    assert allm["marks_mismatches"] == ["P2 1(a): 1 vs 2"]
    assert p1["mcq_option_exact"] == pytest.approx(15 / 16)
    assert p1["mcq_option_mismatches"] == ["P1 2C"]
    assert p1["mcq_answer_accuracy"] == pytest.approx(0.75)
    assert p1["mcq_answer_mismatches"] == ["P1 3: gold C pred B"]
    assert r["papers"]["P2"]["mcq_answer_accuracy"] is None  # nothing to measure
    assert allm["answer_coverage"] == pytest.approx(6 / 7)
    assert allm["missing_answers"] == ["P2 1(b)(ii)"]
    assert 0.8 < allm["answer_text_similarity"] < 1.0


def test_stems_topics_figures_pages(dirs) -> None:
    r = evaluate(*dirs)
    allm = r["papers"]["ALL"]
    assert allm["worst_stems"][0]["key"] == "P1 4"
    assert len(allm["worst_stems"]) == 1
    assert allm["stem_similarity"] < 1.0
    assert allm["topic_top_agreement"] == 1.0           # 3.1 vs 3.2 share topic 3
    assert allm["topic_jaccard"] < 1.0
    assert allm["figure_count_agreement"] == 1.0
    assert allm["figure_iou_mean"] == pytest.approx(0.11 / 0.13)
    assert allm["figure_recall_iou50"] == 1.0
    assert r["pages"]["page_type_accuracy"] == pytest.approx(3 / 4)
    assert r["pages"]["page_type_mismatches"] == ["page 1: questions vs other"]


def test_verdict_and_report(dirs) -> None:
    r = evaluate(*dirs)
    assert r["passed"] is False
    failed = {(c["scope"], c["metric"]) for c in r["checks"] if not c["passed"]}
    assert ("P1", "mcq_answer_accuracy") in failed and ("ALL", "leaf_label_f1") in failed
    text = format_report(r)
    for s in ["RESULT: FAIL", "P1 3: gold C pred B", "Missing labels [1]", "P2 1(b)(ii)", "Extra labels [1]",
              "P2 1(c)", "Worst stems", "P1 4", "page 1: questions vs other", "labels F1 (leaves)"]:
        assert s in text, s
    assert "0.750*" in text  # failing cells are starred


def test_thresholds_are_configurable(dirs) -> None:
    lax = {k: 0.0 for k in DEFAULT_THRESHOLDS}
    assert evaluate(*dirs, thresholds=lax)["passed"] is True
    r = evaluate(*dirs, thresholds={"mcq_answer_accuracy": 0.5, "leaf_label_f1": 0.5})
    assert r["thresholds"]["stem_similarity"] == DEFAULT_THRESHOLDS["stem_similarity"]
    assert not any(c["metric"] == "mcq_answer_accuracy" and not c["passed"] for c in r["checks"])


def test_duplicates_across_chunks_are_warned(tmp_path: Path) -> None:
    files = gold_set()
    files["dup.json"] = chunk("dup", questions=[mcq("1", ["x", "y", "z", "w"])])
    g = write(tmp_path / "g", gold_set())
    p = write(tmp_path / "p", files)
    r = evaluate(g, p)
    assert any("P1 1 again in" in w for w in r["warnings"])


def test_helpers() -> None:
    assert iou([0, 0, 1, 1], [0, 0, 1, 1]) == 1.0
    assert iou([0, 0, 0.5, 0.5], [0.5, 0.5, 1, 1]) == 0.0
    assert similarity("H₂O  is\nwater", "H2O is water") == 1.0   # Unicode + whitespace folded
    assert similarity("", "") == 1.0


# ------------------------------------------------------------------------------ contract v1.1

def v11_sets():
    """Gold with v1.1 fields (choice groups, review flags, answer_space) and a prediction that
    misses some of them."""
    gold, pred = gold_set(), gold_set()
    for files in (gold, pred):
        for ch in files.values():
            for x in ch["questions"]:
                x["answer_space"] = "none" if x["type"] in ("mcq", "context") else "lines"
        files["p2.json"]["questions"] += [q("P2", "9", marks=10, topics=["11.2"]), q("P2", "10", marks=10, topics=["11.3"])]
        for x in files["p2.json"]["questions"][-2:]:
            x["answer_space"], x["choice_group"] = "lines", "B"
        files["p2.json"]["papers"] = [{"paper": "P2", "choice_groups": [{"id": "B", "choose": 1, "note": ""}]}]
    gq = {x["label"]: x for x in gold["p1.json"]["questions"]}
    gq["2"]["review_flags"] = ["source_defect"]
    gq["3"]["review_flags"] = ["inferred"]
    gold["key.json"]["answers"][0]["review_flags"] = ["answer_mismatch"]
    gold["p2.json"]["questions"][1]["answer_space"] = "working"     # 1(a)

    pq = {x["label"]: x for x in pred["p1.json"]["questions"]}
    pq["2"]["review_flags"] = ["source_defect"]                    # caught, same type
    pq["3"]["confidence"] = "low"                                  # caught (needs review), other route
    pred["p2.json"]["questions"][-1].pop("choice_group")           # P2 10 lost its group
    pred["p2.json"]["papers"] = [{"paper": "P2", "choice_groups": [{"id": "B", "choose": 2, "note": ""}]}]
    return gold, pred


def test_v11_metrics(tmp_path: Path) -> None:
    gold, pred = v11_sets()
    r = evaluate(write(tmp_path / "g", gold), write(tmp_path / "p", pred))
    allm = r["papers"]["ALL"]
    n_nodes = 4 + 7
    assert allm["answer_space_accuracy"] == pytest.approx((n_nodes - 1) / n_nodes)
    assert allm["answer_space_mismatches"] == ["P2 1(a): working vs lines"]
    assert allm["choice_group_agreement"] == pytest.approx(0.5)
    assert allm["choice_group_mismatches"] == ["P2 10: B vs None"]
    assert r["paper_choice_group_mismatches"] == ["P2: gold B choose 1 vs pred B choose 2"]
    assert allm["n_gold_flagged"] == 3
    assert allm["review_flag_recall"] == pytest.approx(2 / 3)
    assert allm["review_flag_type_recall"] == pytest.approx(1 / 3)
    assert allm["review_flag_missed"] == ["answer P1 1: gold answer_mismatch, pred not flagged"]


def test_review_flag_recall_is_reported_not_checked(tmp_path: Path) -> None:
    gold, pred = v11_sets()
    r = evaluate(write(tmp_path / "g", gold), write(tmp_path / "p", pred))
    assert not any(c["metric"].startswith("review_flag") for c in r["checks"])
    failed = {(c["scope"], c["metric"]) for c in r["checks"] if not c["passed"]}
    assert ("P2", "choice_group_agreement") in failed
    text = format_report(r)
    for s in ["choice_group agreement", "review flags caught (report)", "answer_space accuracy",
              "P2 10: B vs None", "P2: gold B choose 1 vs pred B choose 2", "Gold review flags the prediction missed",
              "answer P1 1: gold answer_mismatch"]:
        assert s in text, s


def test_v1_gold_without_new_fields_skips_new_metrics(tmp_path: Path) -> None:
    g = write(tmp_path / "gold", gold_set())
    m = evaluate(g, g)["papers"]["ALL"]
    assert m["answer_space_accuracy"] is None and m["choice_group_agreement"] is None
    assert m["review_flag_recall"] is None


def test_dotfiles_are_ignored(tmp_path: Path) -> None:
    g = write(tmp_path / "gold", gold_set())
    p = write(tmp_path / "pred", gold_set())
    (p / ".incomplete.json").write_text('{"failed_chunks": ["p2_a"]}')
    r = evaluate(g, p)
    assert r["passed"] is True
