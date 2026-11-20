"""Tests for the Claude API extractor with a mocked client (no network, no API key).

The mock answers from tests/fixtures/claude/*.json, which hold model outputs in the shape the
structured-output schema asks for (pixel boxes on 1000x1414 page images).
"""
from __future__ import annotations

import copy
import json
import re
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

import pytest
from PIL import Image

from ingest.extract import claude as cl
from ingest.extract import prompts
from ingest.extract.base import DocumentInput, PageImage
from ingest.extract.claude import (ChunkPlan, ClaudeExtractor, ClaudeExtractorError, ExtractionIncompleteError,
                                   PageInfo, convert_questions, fill_forward, fix_chlorine, normalize_label,
                                   plan_chunks, reconcile)

FIX = Path(__file__).parent / "fixtures" / "claude"
W, H = 1000, 1414
CHUNK_KEYS = ["contract_version", "document_id", "source_pdf", "chunk", "extracted_by",
              "pages", "papers", "questions", "answers"]


def fixture(name: str) -> Dict[str, Any]:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


# ------------------------------------------------------------------------------ mock client

class FakeMessage:
    def __init__(self, d: Dict[str, Any]):
        self._d = d

    def to_dict(self, **_: Any) -> Dict[str, Any]:
        return copy.deepcopy(self._d)


class FakeStream:
    def __init__(self, msg: FakeMessage):
        self._msg = msg

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def get_final_message(self) -> FakeMessage:
        return self._msg


class FakeClient:
    """Mimics client.beta.messages.stream(**kwargs) -> context manager -> get_final_message()."""

    def __init__(self, handler: Callable[[Dict[str, Any], "FakeClient"], Any]):
        self.handler = handler
        self.calls: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs: Any) -> FakeStream:
        with self._lock:
            self.calls.append(kwargs)
        out = self.handler(kwargs, self)
        if isinstance(out, BaseException):
            raise out
        return FakeStream(FakeMessage(out))

    def calls_for(self, kind: str, first_page: Optional[int] = None) -> List[Dict[str, Any]]:
        return [c for c in self.calls if kind_of(c) == kind and (first_page is None or pages_of(c)[0] == first_page)]


def kind_of(kwargs: Dict[str, Any]) -> str:
    system = kwargs["system"][0]["text"]
    if system.startswith("You triage"):
        return "classify"
    if system.startswith("You transcribe answer keys"):
        return "answers"
    return "questions"


def pages_of(kwargs: Dict[str, Any]) -> List[int]:
    blocks = kwargs["messages"][0]["content"]
    return [int(m.group(1)) for b in blocks if b["type"] == "text"
            for m in [re.match(r"page_index (\d+)", b["text"])] if m]


def response(data: Any, model: str, stop: str = "end_turn") -> Dict[str, Any]:
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return {
        "id": "msg_test", "type": "message", "role": "assistant", "model": model,
        "content": [{"type": "thinking", "thinking": "", "signature": "sig-abc"}, {"type": "text", "text": text}],
        "stop_reason": stop, "stop_details": None,
        "usage": {"input_tokens": 1000, "output_tokens": 500, "cache_creation_input_tokens": 0,
                  "cache_read_input_tokens": 0},
    }


def default_data(kwargs: Dict[str, Any]) -> Dict[str, Any]:
    kind, pages = kind_of(kwargs), pages_of(kwargs)
    if kind == "classify":
        return {"pages": [p for p in fixture("classify.json")["pages"] if p["page_index"] in pages]}
    if kind == "answers":
        return fixture("answers_key.json")
    return fixture("questions_p1.json") if pages[0] == 1 else fixture("questions_p2.json")


def default_handler(kwargs: Dict[str, Any], client: FakeClient) -> Dict[str, Any]:
    return response(default_data(kwargs), kwargs["model"])


def failing_handler(kwargs: Dict[str, Any], client: FakeClient) -> Any:
    raise AssertionError("no API call expected")


# ------------------------------------------------------------------------------ document

@pytest.fixture
def doc(tmp_path: Path) -> DocumentInput:
    pages = []
    for i in range(8):
        p = tmp_path / "pages" / f"p{i:02d}.png"
        p.parent.mkdir(exist_ok=True)
        Image.new("RGB", (W, H), "white").save(p)
        pages.append(PageImage(page_index=i, path=p, width=W, height=H))
    return DocumentInput(document_id="test-doc", source_pdf="papers/missing.pdf", source_sha256="", pages=pages)


def make_extractor(tmp_path: Path, client: Any, **kw: Any) -> ClaudeExtractor:
    opts = dict(cache_dir=tmp_path / "cache", client=client, image_mode="provided", max_concurrency=1)
    opts.update(kw)
    return ClaudeExtractor(**opts)


def read_chunks(out: Path) -> Dict[str, Dict[str, Any]]:
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(out.glob("*.json"))}


def node(chunk: Dict[str, Any], label: str) -> Dict[str, Any]:
    return next(q for q in chunk["questions"] if q["label"] == label)


# ------------------------------------------------------------------------------ labels / text

@pytest.mark.parametrize("raw,expected", [
    ("3ai", "3(a)(i)"), ("5bii", "5(b)(ii)"), ("Q4 (c)", "4(c)"), ("2(a)ii", "2(a)(ii)"), ("07", "7"),
    ("3(A)(I)", "3(a)(i)"), ("10(b)(iii)", "10(b)(iii)"), ("3.a.ii", "3(a)(ii)"), ("12 b", "12(b)"),
    ("3iv", "3(iv)"), ("1 b ii", "1(b)(ii)"), ("Question 6", "6"),
    ("abc", None), ("0", None), ("3(a)(b)", None), ("3(a)(i)(1)", None), ("", None),
])
def test_normalize_label(raw: str, expected: Optional[str]) -> None:
    assert normalize_label(raw) == expected


def test_canonical_labels_match_loader_rule() -> None:
    from ingest import validate
    for lab in ["7", "2(a)", "2(a)(ii)", "10(b)(iii)", "3(iv)", "3(a)(b)", "3(ii)(i)", "1000", "0"]:
        assert cl.is_canonical_label(lab) == validate.is_canonical_label(lab), lab


@pytest.mark.parametrize("raw,expected", [
    ("HCI(aq)", "HCl(aq)"), ("CI₂ and NaCI", "Cl₂ and NaCl"), ("CI⁻ ions", "Cl⁻ ions"),
    ("NaCIO₃", "NaClO₃"), ("CIRCLE the answer", "CIRCLE the answer"), ("ICE", "ICE"), ("HCl", "HCl"),
])
def test_fix_chlorine(raw: str, expected: str) -> None:
    assert fix_chlorine(raw) == expected


# ------------------------------------------------------------------------------ planning

def P(i: int, t: str = "questions", paper: Optional[str] = "P2", starts=(), cont: bool = False,
      section: Optional[str] = None, cover: Optional[dict] = None) -> PageInfo:
    return PageInfo(page_index=i, page_type=t, paper=paper, question_starts=list(starts),
                    continues_previous=cont, section=section, cover=cover)


def test_plan_keeps_spanning_questions_together_and_packs_to_max_pages() -> None:
    pages = [
        P(9, "cover", cover={"paper_code": "6092/02"}),
        P(10, starts=["1"], section="A"), P(11, cont=True),
        P(12, starts=["2"]), P(13, cont=True), P(14, cont=True),
        P(15, starts=["3"], section="B"), P(16, starts=["4"]), P(17, cont=True),
    ]
    plans = [p for p in plan_chunks(pages, max_pages=5) if p.kind == "questions"]
    assert [(p.name, p.page_indices) for p in plans] == [("p2_a", [10, 11, 12, 13, 14]), ("p2_b", [15, 16, 17])]
    assert plans[0].expected_starts == ["1", "2"] and plans[0].previous_question is None
    assert plans[1].expected_starts == ["3", "4"] and plans[1].previous_question == "2"


def test_plan_never_splits_a_long_question_and_breaks_on_paper_and_gaps() -> None:
    pages = [P(1, paper="P1", starts=["1", "2"]), P(2, paper="P1", starts=["3"]),
             P(4, starts=["1"])] + [P(i, cont=True) for i in range(5, 11)] + [P(11, starts=["2"])]
    plans = [p for p in plan_chunks(pages, max_pages=3) if p.kind == "questions"]
    assert [(p.name, p.page_indices) for p in plans] == [
        ("p1_a", [1, 2]), ("p2_a", [4, 5, 6, 7, 8, 9, 10]), ("p2_b", [11])]


def test_plan_ambiguous_page_stays_with_previous() -> None:
    # No starts and no continuation flag: joining is safe, splitting could cut a question.
    pages = [P(1, starts=["1"]), P(2), P(3, starts=["2"])]
    plans = plan_chunks(pages, max_pages=2)
    assert [p.page_indices for p in plans if p.kind == "questions"] == [[1, 2], [3]]


def test_plan_splits_long_answer_keys() -> None:
    pages = [P(44, "answer_key", paper=None, starts=[str(n) for n in range(1, 41)])] + \
            [P(i, "answer_key", paper=None, cont=True) for i in range(45, 51)]
    plans = [p for p in plan_chunks(pages, max_pages=5) if p.kind == "answers"]
    assert [(p.name, p.page_indices) for p in plans] == [("key_a", [44, 45, 46, 47, 48]), ("key_b", [49, 50])]
    assert plans[1].previous_question == "40"


def test_plan_every_page_in_exactly_one_chunk() -> None:
    infos = fill_forward([cl.page_info_from_model(p["page_index"], p) for p in fixture("classify.json")["pages"]])
    plans = plan_chunks(infos, max_pages=5)
    assert {p.name: p.page_indices for p in plans} == {
        "p1_a": [1, 2], "p2_a": [4, 5], "key_a": [6], "p1_misc": [0], "p2_misc": [3, 7]}
    seen = [i for p in plans for i in p.page_indices]
    assert sorted(seen) == list(range(8))


def test_fill_forward_carries_paper_and_section() -> None:
    pages = [P(0, "cover", paper=None, cover={"paper_code": "6092/01"}), P(1, paper=None, starts=["1"]),
             P(2, "cover", paper=None, cover={"paper_code": "6092/02"}), P(3, paper=None, starts=["1"], section="A"),
             P(4, paper=None, cont=True), P(5, "answer_key", paper=None), P(6, "blank", paper=None)]
    out = {p.page_index: p for p in fill_forward(pages)}
    assert [out[i].paper for i in range(7)] == ["P1", "P1", "P2", "P2", "P2", None, "P2"]
    assert out[4].section == "A"


# ------------------------------------------------------------------------------ validation

def _raw_q(**kw: Any) -> Dict[str, Any]:
    base = {"paper": "P2", "section": None, "parent_label": None, "options": [], "marks": None,
            "full_regions": [], "answer_space": "none", "figures": [], "topics": [],
            "has_handwriting": False, "confidence": "high", "notes": ""}
    base.update(kw)
    return base


def _reg(p: int, x0: int, y0: int, x1: int, y1: int) -> Dict[str, Any]:
    return {"page_index": p, "box": {"x0": x0, "y0": y0, "x1": x1, "y1": y1}}


def test_convert_questions_normalises_and_converts_boxes() -> None:
    plan = ChunkPlan("p2_a", "questions", "P2", [4], expected_starts=["1"])
    raw = {"questions": [
        _raw_q(label="1", type="context", stem="Shared  context with HCI.", regions=[_reg(4, 80, 100, 920, 400)],
               full_regions=[_reg(4, 80, 100, 920, 900)]),
        _raw_q(label="1a", parent_label="2", type="structured", stem="Part", marks=1,
               regions=[_reg(4, 80, 420, 920, 900)], topics=["10.1"]),
    ]}
    qs, issues = convert_questions(raw, {4: (W, H)}, plan, set(prompts.subtopic_codes(prompts.load_taxonomy())))
    assert not [i for i in issues if i.fatal], [i.text() for i in issues]
    assert qs[1]["label"] == "1(a)" and qs[1]["parent_label"] == "1"
    assert "full_regions" not in qs[1] and qs[0]["full_regions"]
    assert qs[0]["stem"] == "Shared  context with HCl."
    assert qs[0]["regions"][0]["bbox"] == [0.074, 0.065, 0.926, 0.289]
    assert all(0 <= v <= 1 for q in qs for r in q["regions"] for v in r["bbox"])


def test_convert_questions_reports_contract_violations() -> None:
    plan = ChunkPlan("p2_a", "questions", "P2", [4], expected_starts=["1", "2"])
    raw = {"questions": [
        _raw_q(label="1", type="context", stem="Context without parts", regions=[_reg(4, 80, 100, 920, 400)]),
        _raw_q(label="3(b)(i)", type="structured", marks=1, stem="Orphan", regions=[_reg(4, 900, 100, 80, 400)],
               topics=["99.9"]),
        _raw_q(label="4", type="mcq", marks=1, stem="Q", options=[{"label": "A", "text": "x"}],
               regions=[_reg(9, 0, 0, 10, 10)], full_regions=[_reg(4, 0, 0, 10, 10)], topics=["1.1"]),
        _raw_q(label="5", type="structured", marks=2, stem="S", options=[{"label": "A", "text": "x"}],
               regions=[_reg(4, 0, 0, 2000, 10)], full_regions=[_reg(4, 0, 0, 10, 10)], topics=["1.1"]),
        _raw_q(label="6", type="context", stem="Parent without full_regions", regions=[_reg(4, 80, 900, 920, 950)]),
        _raw_q(label="6(a)", type="structured", marks=1, stem="Part", regions=[_reg(4, 80, 950, 920, 1000)],
               topics=["1.1"], answer_space="lines"),
    ]}
    qs, issues = convert_questions(raw, {4: (W, H)}, plan, set(prompts.subtopic_codes(prompts.load_taxonomy())))
    text = "\n".join(i.text() for i in issues if i.fatal)
    for expected in [
        "question 6: top-level question needs full_regions",
        "question 1: context node has no children",
        "question 3(b)(i): regions: box has zero or negative size",
        "question 3(b)(i): unknown topic codes ['99.9']",
        "question 3(b)(i): parent node 3(b) is missing",
        "question 4: mcq needs its options A to D",
        "question 4: regions: page_index 9 is not one of the pages sent",
        "question 5: structured node has options",
        "lies outside the 1000×1414 px image",
        "the pre-scan saw question 2 start on these pages",
    ]:
        assert expected in text, expected
    assert node({"questions": qs}, "3(b)(i)")["topics"] == []


def test_continuation_parent_allowed_from_previous_chunk() -> None:
    plan = ChunkPlan("p2_b", "questions", "P2", [6], expected_starts=[], previous_question="2")
    raw = {"questions": [_raw_q(label="2(c)", type="structured", marks=2, stem="Continued part",
                                regions=[_reg(6, 80, 50, 920, 400)], topics=["4.3"])]}
    _, issues = convert_questions(raw, {6: (W, H)}, plan, {"4.3"})
    assert not [i for i in issues if i.fatal]


def test_reconcile_merges_duplicates_and_flags_orphans() -> None:
    def q(label: str, page: int, stem: str, **kw: Any) -> Dict[str, Any]:
        d = {"paper": "P2", "label": label, "parent_label": cl.parent_of(label), "type": "structured", "stem": stem,
             "options": [], "marks": 1, "regions": [{"page_index": page, "bbox": [0.1, 0.1, 0.9, 0.5]}],
             "figures": [], "topics": ["1.1"], "has_handwriting": False, "confidence": "high", "notes": ""}
        d.update(kw)
        return d
    a = {"chunk": "p2_a", "questions": [q("2", 5, "Start", type="context", marks=None),
                                         q("2(a)", 5, "Part a", figures=[{"id": "fig-1.1"}])], "answers": []}
    b = {"chunk": "p2_b", "questions": [q("2(a)", 6, "more of part a"), q("3(b)(i)", 6, "orphan"),
                                         q("4", 6, "x", figures=[{"id": "fig-1.1"}])], "answers": []}
    reconcile([a, b])
    assert [x["label"] for x in a["questions"]] == ["2", "2(a)"]
    assert [x["label"] for x in b["questions"]] == ["3(b)(i)", "4"]
    merged = a["questions"][1]
    assert merged["stem"] == "Part a\n\nmore of part a" and len(merged["regions"]) == 2
    assert b["questions"][0]["confidence"] == "low" and "parent 3(b)" in b["questions"][0]["notes"]
    assert b["questions"][1]["figures"][0]["id"] == "fig-1.1-p2"


# ------------------------------------------------------------------------------ end to end

def test_extract_writes_contract_chunks(tmp_path: Path, doc: DocumentInput) -> None:
    client = FakeClient(default_handler)
    out = tmp_path / "out"
    paths = make_extractor(tmp_path, client).extract(doc, out)
    chunks = read_chunks(out)
    assert sorted(p.name for p in paths) == sorted(f"{n}.json" for n in chunks)
    assert set(chunks) == {"p1_a", "p2_a", "key_a", "p1_misc", "p2_misc"}

    for name, ch in chunks.items():
        assert list(ch) == CHUNK_KEYS, name
        assert ch["contract_version"] == 1 and ch["chunk"] == name
        assert ch["extracted_by"] == "claude-api:claude-fable-5-2"
        assert ch["document_id"] == "test-doc" and ch["source_pdf"] == "papers/missing.pdf"
    all_pages = sorted(p["page_index"] for ch in chunks.values() for p in ch["pages"])
    assert all_pages == list(range(8))

    p1, p2, key = chunks["p1_a"], chunks["p2_a"], chunks["key_a"]
    assert [q["label"] for q in p1["questions"]] == ["1", "2", "3"]
    assert [o["text"] for o in node(p1, "2")["options"]] == ["HCl", "H₂Cl", "HCl₂", "ClH₂"]
    assert node(p1, "1")["regions"] == [{"page_index": 1, "bbox": [0.074, 0.065, 0.926, 0.289]}]
    assert node(p1, "3")["figures"][0]["bbox"] == [0.194, 0.206, 0.806, 0.501]
    assert {p["page_index"]: p["has_handwriting"] for p in p1["pages"]} == {1: False, 2: True}

    assert [q["label"] for q in p2["questions"]] == ["1", "1(a)", "1(b)", "1(b)(i)", "1(b)(ii)", "2", "3"]
    assert all(q["paper"] == "P2" for q in p2["questions"])
    assert "HCl" in node(p2, "1")["stem"]
    assert len(node(p2, "1")["full_regions"]) == 2 and "full_regions" not in node(p2, "1(a)")
    assert node(p2, "1(b)(i)")["parent_label"] == "1(b)"
    assert [(p["page_index"], p["paper"]) for p in p2["pages"]] == [(4, "P2"), (5, "P2")]

    assert [(a["paper"], a["label"], a["correct_option"]) for a in key["answers"]] == [
        ("P1", "1", "A"), ("P1", "2", "A"), ("P1", "3", "B"),
        ("P2", "1(a)", "C"), ("P2", "1(b)(i)", None), ("P2", "1(b)(ii)", None)]
    assert all(a["page_index"] == 6 for a in key["answers"])

    assert [p["paper"] for p in chunks["p1_misc"]["papers"]] == ["P1"]
    assert chunks["p2_misc"]["papers"][0]["paper"] == "P2"  # inferred from paper code 6092/02
    assert chunks["p2_misc"]["papers"][0]["duration_minutes"] == 105
    assert [p["page_type"] for p in chunks["p2_misc"]["pages"]] == ["cover", "blank"]

    # 2 classification batches + 2 question chunks + 1 answer chunk, no retries
    assert len(client.calls) == 5
    answer_prompt = client.calls_for("answers")[0]["messages"][0]["content"][-1]["text"]
    assert "- P2: 1, 1(a), 1(b), 1(b)(i), 1(b)(ii), 2, 3" in answer_prompt
    assert (tmp_path / "cache" / "runs" / "test-doc.json").exists()


def test_output_validates_with_loader_validator(tmp_path: Path, doc: DocumentInput) -> None:
    validate = pytest.importorskip("ingest.validate")
    out = tmp_path / "out"
    make_extractor(tmp_path, FakeClient(default_handler)).extract(doc, out)
    chunks, read_issues = validate.read_chunks(out)
    issues = read_issues + validate.validate(
        chunks, document_id="test-doc", page_count=8,
        topic_codes=prompts.subtopic_codes(prompts.load_taxonomy()))
    assert not validate.errors(issues), [str(e) for e in validate.errors(issues)]


def test_request_shape(tmp_path: Path, doc: DocumentInput) -> None:
    client = FakeClient(default_handler)
    make_extractor(tmp_path, client).extract(doc, tmp_path / "out")
    c = client.calls_for("classify")[0]
    assert c["model"] == "claude-haiku-5-5"
    assert "betas" not in c and "fallbacks" not in c
    assert c["output_config"]["effort"] == "low"
    assert c["output_config"]["format"]["type"] == "json_schema"

    q = client.calls_for("questions", 1)[0]
    assert q["model"] == "claude-fable-5-2"
    assert q["betas"] == ["server-side-fallback-2026-07-01"] and q["fallbacks"] == "default"
    assert q["thinking"] == {"type": "adaptive"}
    assert q["output_config"]["effort"] == "high"
    assert q["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "Syllabus subtopics" in q["system"][0]["text"]
    content = q["messages"][0]["content"]
    assert [b["type"] for b in content] == ["text", "image", "text", "image", "text"]
    assert content[0]["text"] == f"page_index 1 ({W}×{H} px)"
    assert content[-1]["cache_control"] == {"type": "ephemeral"}
    assert "Pages in this run (page_index): 1, 2." in content[-1]["text"]
    enum = q["output_config"]["format"]["schema"]["properties"]["questions"]["items"]["properties"]["topics"]
    assert "11.2" in enum["items"]["enum"]


def test_model_overrides(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INGEST_CLAUDE_CLASSIFIER_MODEL", "claude-sonnet-5-5")
    x = ClaudeExtractor(model="claude-opus-5-5", cache_dir=tmp_path)
    assert x.name == "claude-api:claude-opus-5-5" and x.classifier_model == "claude-sonnet-5-5"
    monkeypatch.delenv("INGEST_CLAUDE_CLASSIFIER_MODEL")
    assert ClaudeExtractor(cache_dir=tmp_path).model == cl.DEFAULT_MODEL


def test_retry_feeds_errors_back_and_uses_corrected_output(tmp_path: Path, doc: DocumentInput) -> None:
    def handler(kwargs: Dict[str, Any], client: FakeClient) -> Dict[str, Any]:
        data = default_data(kwargs)
        if kind_of(kwargs) == "questions" and pages_of(kwargs)[0] == 4 and len(kwargs["messages"]) == 1:
            data["questions"] = [q for q in data["questions"] if q["label"] != "1(b)"]
        return response(data, kwargs["model"])

    client = FakeClient(handler)
    make_extractor(tmp_path, client).extract(doc, tmp_path / "out")
    calls = client.calls_for("questions", 4)
    assert len(calls) == 2
    retry = calls[1]["messages"]
    assert [m["role"] for m in retry] == ["user", "assistant", "user"]
    assert retry[0] == calls[0]["messages"][0]  # identical prefix -> prompt cache hit
    assert retry[1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig-abc"}
    feedback = retry[2]["content"][0]["text"]
    assert "question 1(b)(i): parent node 1(b) is missing" in feedback
    p2 = read_chunks(tmp_path / "out")["p2_a"]
    assert "1(b)" in [q["label"] for q in p2["questions"]]
    assert all(q["confidence"] == "high" for q in p2["questions"])


def test_still_invalid_after_retry_is_written_low_confidence(tmp_path: Path, doc: DocumentInput) -> None:
    def handler(kwargs: Dict[str, Any], client: FakeClient) -> Dict[str, Any]:
        data = default_data(kwargs)
        if kind_of(kwargs) == "questions" and pages_of(kwargs)[0] == 4:
            data["questions"] = [q for q in data["questions"] if q["label"] != "1(b)"]
        return response(data, kwargs["model"])

    client = FakeClient(handler)
    make_extractor(tmp_path, client).extract(doc, tmp_path / "out")
    assert len(client.calls_for("questions", 4)) == 2
    p2 = read_chunks(tmp_path / "out")["p2_a"]
    bi = node(p2, "1(b)(i)")
    assert bi["confidence"] == "low"
    assert "[check] parent node 1(b) is missing" in bi["notes"]
    assert node(p2, "1(a)")["confidence"] == "high"


def test_unparseable_then_valid(tmp_path: Path, doc: DocumentInput) -> None:
    def handler(kwargs: Dict[str, Any], client: FakeClient) -> Dict[str, Any]:
        if kind_of(kwargs) == "answers" and len(kwargs["messages"]) == 1:
            return response('{"answers": [', kwargs["model"])
        return default_handler(kwargs, client)

    client = FakeClient(handler)
    make_extractor(tmp_path, client).extract(doc, tmp_path / "out")
    assert len(client.calls_for("answers")) == 2
    assert len(read_chunks(tmp_path / "out")["key_a"]["answers"]) == 6


def test_max_tokens_retries_with_bigger_budget(tmp_path: Path, doc: DocumentInput) -> None:
    def handler(kwargs: Dict[str, Any], client: FakeClient) -> Dict[str, Any]:
        if kind_of(kwargs) == "questions" and pages_of(kwargs)[0] == 1 and kwargs["max_tokens"] < 128000:
            return response('{"questions": [{"label": "1"', kwargs["model"], stop="max_tokens")
        return default_handler(kwargs, client)

    client = FakeClient(handler)
    x = make_extractor(tmp_path, client)
    x.extract(doc, tmp_path / "out")
    budgets = [c["max_tokens"] for c in client.calls_for("questions", 1)]
    assert budgets == [64000, 128000]
    assert len(read_chunks(tmp_path / "out")["p1_a"]["questions"]) == 3
    # the truncated response is not cached: a re-run asks again only for that request
    client2 = FakeClient(default_handler)
    make_extractor(tmp_path, client2).extract(doc, tmp_path / "out2")
    assert [c["max_tokens"] for c in client2.calls] == [64000]


def test_second_run_is_served_from_cache(tmp_path: Path, doc: DocumentInput, monkeypatch: pytest.MonkeyPatch) -> None:
    out1, out2, out3 = tmp_path / "o1", tmp_path / "o2", tmp_path / "o3"
    first = FakeClient(default_handler)
    make_extractor(tmp_path, first).extract(doc, out1)
    assert len(first.calls) == 5

    second = FakeClient(failing_handler)
    x = make_extractor(tmp_path, second, max_concurrency=4)
    x.extract(doc, out2)
    assert second.calls == []
    assert x.last_run_stats["api_calls"] == 0 and x.last_run_stats["cache_hits"] == 5
    assert {p.name: p.read_bytes() for p in out1.glob("*.json")} == {p.name: p.read_bytes() for p in out2.glob("*.json")}

    # fully cached runs need no credentials at all
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_IDENTITY_TOKEN",
                "ANTHROPIC_IDENTITY_TOKEN_FILE"):
        monkeypatch.delenv(var, raising=False)
    make_extractor(tmp_path, None).extract(doc, out3)
    assert len(list(out3.glob("*.json"))) == 5


def test_cache_key_tracks_prompt_version_and_images(monkeypatch: pytest.MonkeyPatch) -> None:
    kwargs = {"model": "m", "messages": [{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}]}]}
    k1 = cl.request_cache_key(kwargs)
    other = copy.deepcopy(kwargs)
    other["messages"][0]["content"][0]["source"]["data"] = "BBBB"
    assert cl.request_cache_key(other) != k1
    monkeypatch.setattr(prompts, "PROMPT_VERSION", "test-bump")
    assert cl.request_cache_key(kwargs) != k1


def test_missing_api_key_is_a_clear_error(tmp_path: Path, doc: DocumentInput, monkeypatch: pytest.MonkeyPatch) -> None:
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_IDENTITY_TOKEN",
                "ANTHROPIC_IDENTITY_TOKEN_FILE"):
        monkeypatch.delenv(var, raising=False)
    with pytest.raises(ClaudeExtractorError, match="ANTHROPIC_API_KEY is not set"):
        make_extractor(tmp_path, None).extract(doc, tmp_path / "out")


def test_api_failure_writes_chunk_and_raises_incomplete(tmp_path: Path, doc: DocumentInput) -> None:
    import anthropic
    import httpx

    def handler(kwargs: Dict[str, Any], client: FakeClient) -> Any:
        if kind_of(kwargs) == "questions" and pages_of(kwargs)[0] == 4:
            req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
            return anthropic.InternalServerError("overloaded", response=httpx.Response(529, request=req), body=None)
        return default_handler(kwargs, client)

    out = tmp_path / "out"
    with pytest.raises(ExtractionIncompleteError) as err:
        make_extractor(tmp_path, FakeClient(handler)).extract(doc, out)
    assert "p2_a" in str(err.value) and len(err.value.paths) == 5
    chunks = read_chunks(out)
    assert chunks["p2_a"]["questions"] == []
    assert "[extraction failed] InternalServerError" in chunks["p2_a"]["pages"][0]["notes"]
    assert len(chunks["p1_a"]["questions"]) == 3 and len(chunks["key_a"]["answers"]) == 6

    # A re-run retries the failed chunk; the answer key is asked again only because its prompt
    # now lists the P2 labels. Everything else comes from the cache.
    client = FakeClient(default_handler)
    make_extractor(tmp_path, client).extract(doc, out)
    assert [(kind_of(c), pages_of(c)[0]) for c in client.calls] == [("questions", 4), ("answers", 6)]


def test_fallback_model_recorded(tmp_path: Path, doc: DocumentInput) -> None:
    def handler(kwargs: Dict[str, Any], client: FakeClient) -> Dict[str, Any]:
        r = default_handler(kwargs, client)
        if kind_of(kwargs) == "questions" and pages_of(kwargs)[0] == 1:
            r["model"] = "claude-opus-5-5"
        return r

    x = make_extractor(tmp_path, FakeClient(handler))
    x.extract(doc, tmp_path / "out")
    p1 = read_chunks(tmp_path / "out")["p1_a"]
    assert p1["extracted_by"] == "claude-api:claude-opus-5-5"
    assert "served by fallback model claude-opus-5-5" in p1["pages"][0]["notes"]
    assert x.last_run_stats["fallback_served"] == ["claude-opus-5-5"]


def test_rerun_replaces_own_stale_chunks_but_keeps_others(tmp_path: Path, doc: DocumentInput) -> None:
    out = tmp_path / "out"
    out.mkdir()
    (out / "p9_z.json").write_text(json.dumps({"extracted_by": "claude-api:old", "questions": []}))
    (out / "human_fix.json").write_text(json.dumps({"extracted_by": "human", "questions": []}))
    make_extractor(tmp_path, FakeClient(default_handler)).extract(doc, out)
    names = {p.name for p in out.glob("*.json")}
    assert "p9_z.json" not in names and "human_fix.json" in names


def test_hires_render_from_pdf(tmp_path: Path) -> None:
    fitz = pytest.importorskip("fitz")
    pdf_path = tmp_path / "doc.pdf"
    pdf = fitz.open()
    pdf.new_page(width=595.28, height=841.89).insert_text((72, 72), "H2O")
    pdf.save(str(pdf_path))
    png = tmp_path / "p0.png"
    Image.new("RGB", (1240, 1754), "white").save(png)
    import hashlib
    doc = DocumentInput("d", str(pdf_path), hashlib.sha256(pdf_path.read_bytes()).hexdigest(),
                        [PageImage(0, png, 1240, 1754)])
    x = ClaudeExtractor(cache_dir=tmp_path / "c", client=FakeClient(failing_handler))
    img = x._image(doc, 0, "extract")
    assert img.width * img.height <= cl.HIRES_MAX_PIXELS and max(img.width, img.height) <= cl.HIRES_MAX_LONG_EDGE
    assert img.height > 1754  # more detail than the 150 dpi review PNG
    small = x._image(doc, 0, "classify")
    assert small.width * small.height <= cl.CLASSIFY_MAX_PIXELS


def test_schemas_within_structured_output_limits() -> None:
    # API limits per request: 16 union-typed parameters, 24 optional parameters.
    tax = prompts.load_taxonomy()
    for schema in (prompts.classify_schema(), prompts.questions_schema(prompts.subtopic_codes(tax)),
                   prompts.answers_schema()):
        assert prompts.count_unions(schema) <= 16
        assert prompts.count_optional(schema) == 0


def test_blank_classifier_values_and_enum_casing(tmp_path: Path, doc: DocumentInput) -> None:
    make_extractor(tmp_path, FakeClient(default_handler)).extract(doc, tmp_path / "out")
    chunks = read_chunks(tmp_path / "out")
    assert [p["page_type"] for p in chunks["p1_a"]["pages"]] == ["questions", "questions"]  # "Questions" fixed
    p2 = chunks["p2_misc"]["papers"][0]
    assert p2["level"] is None and p2["paper_code"] == "6092/02"
    assert chunks["p2_misc"]["pages"][0]["printed_page_number"] is None
    assert cl.canon_enum("Mcq", prompts.QUESTION_TYPES) == "mcq" and cl.canon_enum("e", prompts.OPTION_LABELS) is None


# ------------------------------------------------------------------------------ contract v1.1

QUESTION_KEYS_V11 = ["paper", "section", "label", "parent_label", "type", "stem", "options", "marks", "regions",
                     "answer_space", "figures", "topics", "has_handwriting", "confidence", "review_flags", "notes"]


def test_v11_fields_on_every_node(tmp_path: Path, doc: DocumentInput) -> None:
    make_extractor(tmp_path, FakeClient(default_handler)).extract(doc, tmp_path / "out")
    chunks = read_chunks(tmp_path / "out")
    qs = [q for ch in chunks.values() for q in ch["questions"]]
    for q in qs:
        assert set(QUESTION_KEYS_V11) <= set(q), q["label"]
        assert q["answer_space"] in prompts.ANSWER_SPACES
        if q["type"] in ("mcq", "context"):
            assert q["answer_space"] == "none"
        if q["parent_label"] is None:
            assert q["full_regions"], q["label"]           # every top-level question, MCQs included
        else:
            assert "full_regions" not in q
        for f in q["figures"]:
            assert isinstance(f["caption"], str)
    mcq2 = node(chunks["p1_a"], "2")
    assert mcq2["full_regions"] == mcq2["regions"]          # childless: copied from regions
    assert node(chunks["p1_a"], "3")["figures"][0]["caption"] == ""
    for a in chunks["key_a"]["answers"]:
        assert {"confidence", "review_flags", "notes", "page_index"} <= set(a)


def test_source_defect_is_flagged_not_fixed(tmp_path: Path, doc: DocumentInput) -> None:
    client = FakeClient(default_handler)
    make_extractor(tmp_path, client).extract(doc, tmp_path / "out")
    q3 = node(read_chunks(tmp_path / "out")["p1_a"], "3")
    assert q3["review_flags"] == ["source_defect"] and q3["options"][3]["text"] == "(blank in scan)"
    assert len(client.calls_for("questions", 1)) == 1                 # not treated as an error
    system = client.calls_for("questions", 1)[0]["system"][0]["text"]
    assert "Flag problems, do not fix them" in system and '"(blank in' in system


def test_empty_option_needs_a_flag() -> None:
    plan = ChunkPlan("p1_a", "questions", "P1", [1], expected_starts=["1"])
    opts = [{"label": l, "text": t} for l, t in zip("ABCD", ["x", "y", "", "z"])]
    raw = {"questions": [_raw_q(paper="P1", label="1", type="mcq", marks=1, stem="Q", options=opts,
                                regions=[_reg(1, 80, 100, 920, 400)], topics=["1.1"])]}
    _, issues = convert_questions(raw, {1: (W, H)}, plan, {"1.1"})
    assert any("mcq option with empty text" in i.message for i in issues if i.fatal)
    raw["questions"][0]["review_flags"] = ["Source_Defect"]          # enum casing drift too
    qs, issues = convert_questions(raw, {1: (W, H)}, plan, {"1.1"})
    assert not [i for i in issues if i.fatal] and qs[0]["review_flags"] == ["source_defect"]


def test_answer_space_forced_none_for_mcq_and_context() -> None:
    plan = ChunkPlan("p1_a", "questions", "P1", [1], expected_starts=["1"])
    opts = [{"label": l, "text": t} for l, t in zip("ABCD", "wxyz")]
    raw = {"questions": [_raw_q(paper="P1", label="1", type="mcq", marks=1, stem="Q", options=opts,
                                answer_space="working", regions=[_reg(1, 80, 100, 920, 400)], topics=["1.1"])]}
    qs, issues = convert_questions(raw, {1: (W, H)}, plan, {"1.1"})
    assert qs[0]["answer_space"] == "none" and not [i for i in issues if i.fatal]


def test_answer_mismatch_flagged(tmp_path: Path, doc: DocumentInput) -> None:
    make_extractor(tmp_path, FakeClient(default_handler)).extract(doc, tmp_path / "out")
    answers = {a["label"]: a for a in read_chunks(tmp_path / "out")["key_a"]["answers"] if a["paper"] == "P2"}
    assert answers["1(a)"]["review_flags"] == ["answer_mismatch"]
    assert "not multiple choice" in answers["1(a)"]["notes"]
    assert answers["1(b)(i)"]["review_flags"] == []


def test_cross_check_answers_mcq_letter() -> None:
    qs = [{"paper": "P1", "label": "1", "type": "mcq", "options": [{"label": x} for x in "ABC"]},
          {"paper": "P1", "label": "2", "type": "mcq", "options": [{"label": x} for x in "ABCD"]}]
    ans = [{"paper": "P1", "label": "1", "correct_option": "D", "review_flags": [], "notes": ""},
           {"paper": "P1", "label": "2", "correct_option": None, "review_flags": [], "notes": ""}]
    cl.cross_check_answers(qs, ans)
    assert all(a["review_flags"] == ["answer_mismatch"] for a in ans)


def test_choice_groups_declared_and_assigned(tmp_path: Path, doc: DocumentInput) -> None:
    client = FakeClient(default_handler)
    make_extractor(tmp_path, client).extract(doc, tmp_path / "out")
    chunks = read_chunks(tmp_path / "out")
    p2 = chunks["p2_misc"]["papers"][0]
    # cover instruction (page 3) comes first; the section heading (page 5) repeats it as "Section B"
    assert p2["choice_groups"] == [{"id": "B", "choose": 1, "note": "Section B: Answer one question."}]
    assert chunks["p1_misc"]["papers"][0]["choice_groups"] == []
    groups = {q["label"]: q.get("choice_group") for q in chunks["p2_a"]["questions"]}
    assert groups == {"1": None, "1(a)": None, "1(b)": None, "1(b)(i)": None, "1(b)(ii)": None, "2": "B", "3": "B"}
    assert "choice_group" not in node(chunks["p2_a"], "1")
    assert "choice_instructions" in client.calls_for("classify")[0]["output_config"]["format"]["schema"][
        "properties"]["pages"]["items"]["properties"]


def test_choice_groups_by_named_questions_and_without_cover() -> None:
    info = PageInfo(page_index=5, paper="P3", choice_instructions=[
        {"id": "Q9-10", "choose": 1, "questions": ["9", "10"], "note": "Answer either 9 or 10."}])
    qs = [{"paper": "P3", "label": str(n), "parent_label": None, "section": None} for n in (8, 9, 10)]
    groups, members = cl.choice_groups([info], qs)
    assert groups == {"P3": [{"id": "Q9-10", "choose": 1, "note": "Answer either 9 or 10."}]}
    assert members == {("P3", "9"): "Q9-10", ("P3", "10"): "Q9-10"}
    chunks = [{"chunk": "p3_a", "papers": [], "questions": qs, "answers": []}]
    cl.apply_document_rules(chunks, [info])                        # no cover declares P3's groups
    assert "choice_group" not in qs[1] and "no cover page declares" in qs[1]["notes"]


def test_papers_up_to_p9() -> None:
    assert prompts.PAPERS[-1] == "P9" and cl.infer_paper_from_code("6092/03") == "P3"
    assert cl.page_info_from_model(0, {"page_type": "questions", "paper": "p4"}).paper == "P4"


def test_single_newline_between_numbered_statements_is_kept() -> None:
    assert cl.clean_text("Which statements are correct?\n\n1 HCI is acidic\n2 NaCl is neutral\n\n\n") == \
        "Which statements are correct?\n\n1 HCl is acidic\n2 NaCl is neutral"
