from __future__ import annotations

from pathlib import Path

from conftest import DOC_ID
from ingest.db import load_taxonomy
from ingest.validate import errors, is_canonical_label, suggest_label, validate

CODES = [t["code"] for t in load_taxonomy()]


def run(contract, page_count=2):
    return validate([(Path(n), d) for n, d in contract.items()], DOC_ID, page_count, CODES)


def messages(issues, level="error"):
    return [str(i) for i in issues if i.level == level]


def test_fixture_is_valid(contract):
    issues = run(contract)
    assert errors(issues) == [], messages(issues)


def test_labels():
    for ok in ("7", "40", "2(a)", "2(a)(ii)", "10(b)(iii)", "5(iv)"):
        assert is_canonical_label(ok), ok
    for bad, hint in (("3ai", "3(a)(i)"), ("5bii", "5(b)(ii)"), ("2 (a)", "2(a)"), ("2(A)", "2(a)"), ("Q4", "4")):
        assert not is_canonical_label(bad)
        assert suggest_label(bad) == hint


def test_bad_label_message_names_file_label_and_fix(contract):
    contract["b.json"]["answers"][1]["label"] = "1a"
    msgs = messages(run(contract))
    assert any("b.json: answer P2 1a" in m and "did you mean '1(a)'" in m for m in msgs), msgs


def test_bbox_errors(contract):
    q = contract["a.json"]["questions"][2]
    q["regions"][0]["bbox"] = [0.05, 0.6, 0.95, 0.5]                # y0 > y1
    contract["a.json"]["questions"][1]["figures"][0]["bbox"] = [0.1, 0.2, 1.5, 0.3]  # out of range
    contract["a.json"]["questions"][0]["regions"][0]["bbox"] = [0, 0, 1.01, 0.1]   # tolerated, clamped
    issues = run(contract)
    msgs = messages(issues)
    assert any("question P2 1(a) regions[0]" in m and "x0 < x1 and y0 < y1" in m for m in msgs), msgs
    assert any("figure fig-1.1" in m and "outside 0..1" in m for m in msgs), msgs
    assert any("slightly outside" in m for m in messages(issues, "warning"))


def test_page_index_out_of_range(contract):
    contract["a.json"]["questions"][2]["regions"][0]["page_index"] = 5
    assert any("page_index 5 out of range" in m for m in messages(run(contract)))


def test_unknown_topic_and_missing_parent(contract):
    contract["a.json"]["questions"][2]["topics"] = ["99.9"]
    contract["b.json"]["questions"].append(dict(contract["b.json"]["questions"][0], label="2(a)", parent_label="2"))
    msgs = messages(run(contract))
    assert any("question P2 1(a)" in m and "'99.9' is not a code" in m for m in msgs), msgs
    assert any("b.json: question P2 2(a)" in m and "parent P2 2 does not exist" in m for m in msgs), msgs


def test_parent_label_must_match_label(contract):
    contract["a.json"]["questions"][4]["parent_label"] = "1"
    assert any("implies '1(b)'" in m for m in messages(run(contract)))


def test_duplicates_across_chunks(contract):
    contract["b.json"]["questions"].append(contract["a.json"]["questions"][2])
    contract["a.json"]["answers"].append(contract["b.json"]["answers"][0])
    contract["b.json"]["pages"].append(contract["a.json"]["pages"][0])
    msgs = messages(run(contract))
    assert any("question P2 1(a): question duplicated (also in a.json)" in m for m in msgs), msgs
    assert any("answer P1 1: answer duplicated" in m for m in msgs), msgs
    assert any("page 0: page record duplicated" in m for m in msgs), msgs


def test_structural_errors(contract):
    a = contract["a.json"]
    a["contract_version"] = 2
    a["document_id"] = "other"
    del a["answers"]
    a["questions"][0]["options"] = []
    a["questions"][0]["type"] = "mcq"
    a["questions"][2]["type"] = "essay"
    contract["b.json"]["answers"][0]["correct_option"] = None
    msgs = messages(run(contract))
    for needle in ("contract_version must be 1", "document_id 'other' does not match", "missing 'answers' list",
                   "mcq needs options", "type 'essay'", "neither correct_option nor answer_text"):
        assert any(needle in m for m in msgs), (needle, msgs)


def test_review_flags_and_v11_fields(contract):
    contract["a.json"]["questions"][0]["review_flags"] = "inferred"            # not a list
    contract["a.json"]["questions"][2]["review_flags"] = ["typo"]              # unknown flag: warning
    contract["a.json"]["questions"][2]["answer_space"] = "working"             # v1.1 value
    del contract["a.json"]["questions"][0]["full_regions"]                     # required in v1.1
    contract["b.json"]["answers"][0]["confidence"] = "sure"
    issues = run(contract)
    assert any("review_flags must be a list" in m for m in messages(issues)), messages(issues)
    warns = messages(issues, "warning")
    assert any("unknown review flag 'typo'" in m for m in warns)
    assert not any("answer_space" in m for m in warns)
    assert any("question P1 1: top-level question has no full_regions" in m for m in warns)
    assert any("answer P1 1: confidence 'sure'" in m for m in warns)
