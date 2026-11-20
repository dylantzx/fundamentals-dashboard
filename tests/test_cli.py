from __future__ import annotations

import json

import pytest

from conftest import DOC_ID, make_contract, write_contract
from ingest.cli import main


def test_run_end_to_end_is_idempotent(cfg, synth_pdf, tmp_path, capsys):
    src = write_contract(tmp_path / "gold", make_contract())
    # document id is taken from the JSON when --document-id is not given
    assert main(["run", str(synth_pdf[0]), "--from", str(src)]) == 0
    assert (cfg.extracted_dir(DOC_ID) / "a.json").exists()
    assert (cfg.reports_dir / ("%s.json" % DOC_ID)).exists()
    assert main(["run", str(synth_pdf[0]), "--from", str(src)]) == 0          # same PDF again
    out = capsys.readouterr().out
    assert "skipping" in out and "(cached)" in out
    assert main(["run", str(synth_pdf[0]), "--from", str(src), "--force"]) == 0  # old JSON moved aside
    assert list((cfg.extracted_dir(DOC_ID) / "_replaced").glob("*/a.json"))

    import sqlite3
    conn = sqlite3.connect(str(cfg.db_path))
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 7
    conn.close()

    capsys.readouterr()
    assert main(["search", "h2o", "--json"]) == 0
    hits = json.loads(capsys.readouterr().out)
    assert hits and hits[0]["document_id"] == DOC_ID

    assert main(["show", "%s:P2:1(b)(ii)" % DOC_ID]) == 0
    out = capsys.readouterr().out
    assert "water, H₂O" in out and "covers_children" in out and "full_question" in out
    assert main(["show", hits[0]["id"]]) == 0
    assert main(["show", "nope:P9:1"]) == 1

    assert main(["report", DOC_ID]) == 0
    assert main(["topics"]) == 0
    assert "10.2" in capsys.readouterr().out


def test_load_with_invalid_json_exits_nonzero(cfg, synth_pdf, tmp_path, capsys):
    good = write_contract(tmp_path / "good", make_contract())
    assert main(["run", str(synth_pdf[0]), "--from", str(good)]) == 0
    bad = make_contract()
    bad["a.json"]["questions"][0]["topics"] = ["42.1"]
    assert main(["load", DOC_ID, "--from", str(write_contract(tmp_path / "bad", bad))]) == 2
    assert "'42.1' is not a code" in capsys.readouterr().out
    assert main(["load", "unknown-doc"]) == 1


def _run_ok(synth_pdf, tmp_path):
    src = write_contract(tmp_path / "gold", make_contract())
    assert main(["run", str(synth_pdf[0]), "--from", str(src)]) == 0


def test_review_command_and_include_review(cfg, synth_pdf, tmp_path, capsys):
    _run_ok(synth_pdf, tmp_path)
    capsys.readouterr()
    assert main(["review"]) == 0
    out = capsys.readouterr().out
    assert "1 question node(s) need review" in out and "P2 1(c)" in out and "low_confidence" in out
    assert main(["search", "volume", "--json"]) == 0
    assert all(h["label"] != "1(c)" for h in json.loads(capsys.readouterr().out))
    assert main(["search", "volume", "--json", "--include-review"]) == 0
    assert any(h["label"] == "1(c)" for h in json.loads(capsys.readouterr().out))
    assert main(["show", "%s:P2:1(c)" % DOC_ID]) == 0
    assert "NEEDS REVIEW: low_confidence" in capsys.readouterr().out


class _FakeExtractor:
    name = "fake"

    def __init__(self, fail):
        self.fail = fail
        self.last_run_stats = {}

    def extract(self, doc, out_dir):
        paths = sorted(write_contract(out_dir, make_contract()).glob("*.json"))
        if self.fail:
            from ingest.extract.claude import ExtractionIncompleteError
            self.last_run_stats = {"failed_chunks": ["b"]}
            raise ExtractionIncompleteError("%s: chunks b failed at the API" % doc.document_id, paths)
        return paths


def test_incomplete_extraction_is_not_loaded_and_retried(cfg, synth_pdf, monkeypatch, capsys):
    pytest.importorskip("ingest.extract.claude")
    import ingest.extract.registry as registry
    monkeypatch.setattr(registry, "get_extractor", lambda name, **kw: _FakeExtractor(fail=True))
    args = ["run", str(synth_pdf[0]), "--extractor", "claude", "--document-id", DOC_ID]
    assert main(args) == 1
    out = capsys.readouterr().out
    assert "failed chunks: b" in out and "Re-run the same command" in out
    import sqlite3
    conn = sqlite3.connect(str(cfg.db_path))
    assert conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 0     # nothing loaded
    assert main(["load", DOC_ID]) == 1                                            # load refuses too
    # re-running retries even though chunk files exist, and loads once extraction completes
    monkeypatch.setattr(registry, "get_extractor", lambda name, **kw: _FakeExtractor(fail=False))
    assert main(args) == 0
    assert "retrying" in capsys.readouterr().out
    assert conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 7
    assert not (cfg.extracted_dir(DOC_ID) / ".incomplete.json").exists()


def test_eval_exit_code(monkeypatch, tmp_path, capsys):
    import ingest.eval as ev
    monkeypatch.setattr(ev, "format_report", lambda r: "report")
    monkeypatch.setattr(ev, "evaluate", lambda gold, pred: {"passed": False})
    assert main(["eval", "--gold", str(tmp_path), "--pred", str(tmp_path)]) == 1
    monkeypatch.setattr(ev, "evaluate", lambda gold, pred: {"passed": True})
    assert main(["eval", "--gold", str(tmp_path), "--pred", str(tmp_path)]) == 0


def test_gc_dry_run_then_delete(cfg, synth_pdf, tmp_path, capsys):
    from ingest import db as dbm
    from ingest.assets import LocalAssetStore, register
    from PIL import Image
    import io
    _run_ok(synth_pdf, tmp_path)
    store = LocalAssetStore(cfg.assets_dir)
    buf = io.BytesIO()
    Image.new("1", (7, 3), 1).save(buf, format="PNG")
    orphan = store.put(buf.getvalue(), "png")                       # row nobody references
    conn = dbm.connect(cfg.db_path)
    register(conn, orphan, "figure")
    buf2 = io.BytesIO()
    Image.new("1", (5, 5), 0).save(buf2, format="PNG")
    stray = store.put(buf2.getvalue(), "png")                       # file without a row
    before = sorted(store.keys())
    capsys.readouterr()
    assert main(["gc"]) == 0
    out = capsys.readouterr().out
    assert "1 unreferenced asset row(s), 1 untracked file(s)" in out and "dry run" in out
    assert sorted(store.keys()) == before
    assert main(["gc", "--yes"]) == 0
    keys = set(store.keys())
    assert orphan.path not in keys and stray.path not in keys and len(keys) == len(before) - 2
    assert conn.execute("SELECT COUNT(*) FROM assets WHERE sha256 = ?", (orphan.sha256,)).fetchone()[0] == 0
    referenced = [r[0] for r in conn.execute("SELECT s.path FROM question_assets a JOIN assets s "
                                             "ON s.sha256 = a.asset_sha256")]
    assert referenced and all(store.local_path(p).exists() for p in referenced)
    capsys.readouterr()
    assert main(["gc"]) == 0 and "0 unreferenced asset row(s), 0 untracked file(s)" in capsys.readouterr().out


def test_export(cfg, synth_pdf, tmp_path):
    _run_ok(synth_pdf, tmp_path)
    out = tmp_path / "export.json"
    assert main(["export", DOC_ID, "--out", str(out)]) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert [d["id"] for d in data["documents"]] == [DOC_ID]
    assert [(q["paper"], q["label"]) for q in data["questions"]] == [("P1", "1"), ("P2", "1")]
    mcq, q1 = data["questions"]
    assert [o["label"] for o in mcq["options"]] == ["A", "B", "C", "D"] and mcq["answers"][0]["correct_option"] == "A"
    assert q1["total_marks"] == 6 and q1["tree_review_status"] == "needs_review"      # 1(c) is low confidence
    b = [c for c in q1["children"] if c["label"] == "1(b)"][0]
    bii = [c for c in b["children"] if c["label"] == "1(b)(ii)"][0]
    assert [c["label"] for c in bii["context"]] == ["1", "1(b)"]
    assert bii["answers"][0]["link"] == "covers_children"
    assert {t["code"] for t in bii["topics"]} == {"10.1", "10.2"}
    assert q1["assets"]["figures"][0]["caption"] == "Fig. 1.1"
    assert all((cfg.assets_dir / a["path"]).exists() for a in q1["assets"]["full_question"])
    assert main(["export", "--all", "--out", str(out)]) == 0
    assert main(["export", "nope", "--out", str(out)]) == 1
