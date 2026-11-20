"""Command line: python -m ingest <command> ...

  run <pdf>           rasterize -> extract -> crop/load -> index -> quality report
  load <document_id>  reload a document from its extraction JSON (after fixing the JSON)
  search "<query>"    full-text search over leaf questions
  show <question>     one question with inherited context, options, answer and crops
  report <doc_id>     quality report
  topics              syllabus topics with question counts
  review [doc]        questions hidden from search until a human checks them
  gc [--yes]          delete assets nothing references (dry run by default)
  export <doc|--all>  denormalized JSON for the app
  eval                score an extraction against a gold set (exit 1 if it fails thresholds)
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from ingest import db as dbm
from ingest.config import Config, slugify

EXIT_OK, EXIT_FAIL, EXIT_INVALID = 0, 1, 2
INCOMPLETE_MARKER = ".incomplete.json"   # in data/extracted/<doc>/ after a partial extraction


def _is_incomplete_extraction(exc: BaseException) -> bool:
    try:
        from ingest.extract.claude import ExtractionIncompleteError
    except Exception:  # claude backend unavailable: it cannot have raised its own error
        return False
    return isinstance(exc, ExtractionIncompleteError)


def _print_issues(issues, limit: int = 60) -> None:
    errs = [i for i in issues if i.level == "error"]
    for i in (errs + [i for i in issues if i.level != "error"])[:limit]:
        print("  " + str(i))
    if len(issues) > limit:
        print("  ... %d more" % (len(issues) - limit))


def _report_and_save(conn, cfg: Config, document_id: str, issues) -> None:
    from ingest.report import build_report, format_report, save_report
    rep = build_report(conn, document_id, issues)
    path = save_report(rep, cfg.reports_dir)
    print(format_report(rep))
    print("\nreport saved to %s" % path)


def _doc_id_from_dir(src: Optional[Path]) -> Optional[str]:
    if not src:
        return None
    for f in sorted(Path(src).glob("*.json")):
        try:
            doc_id = json.loads(f.read_text(encoding="utf-8")).get("document_id")
        except (ValueError, AttributeError):
            continue
        if isinstance(doc_id, str) and doc_id:
            return doc_id
    return None


def _load(conn, cfg: Config, document_id: str, src: Optional[Path]) -> int:
    from ingest.load import LoadError, ValidationFailed, load_document
    if src is None and (cfg.extracted_dir(document_id) / INCOMPLETE_MARKER).exists():
        print("load refused: the extraction in %s is incomplete; re-run `python -m ingest run <pdf>` to "
              "retry the failed chunks" % cfg.extracted_dir(document_id))
        return EXIT_FAIL
    try:
        res = load_document(conn, cfg, document_id, src_dir=src)
    except ValidationFailed as e:
        print("load aborted: %s (database unchanged)" % e)
        _print_issues(e.issues)
        return EXIT_INVALID
    except LoadError as e:
        print("load failed: %s" % e)
        return EXIT_FAIL
    c = res.counts
    print("loaded %s: %d questions, %d answers, %d crops (%d with problems), %d indexed"
          % (document_id, c["questions"], c["answers"], c["crops"], c["crop_problems"], c["indexed"]))
    print()
    _report_and_save(conn, cfg, document_id, res.issues)
    return EXIT_OK


# ---------------------------------------------------------------- commands

def cmd_run(args, cfg: Config) -> int:
    from ingest.assets import LocalAssetStore
    from ingest.extract.registry import get_extractor
    from ingest.rasterize import file_sha256, rasterize

    pdf = Path(args.pdf)
    if not pdf.is_file():
        print("no such PDF: %s" % pdf)
        return EXIT_FAIL
    conn = dbm.connect(cfg.db_path)
    src = Path(args.from_dir) if args.from_dir else None
    existing = dbm.document_by_sha(conn, file_sha256(pdf))
    document_id = (args.document_id or (existing["id"] if existing else None)
                   or _doc_id_from_dir(src) or slugify(pdf.stem))
    extractor_name = args.extractor or ("files" if src else "claude")

    store = LocalAssetStore(cfg.assets_dir)
    print("[1/4] rasterize %s -> %s" % (pdf, document_id))
    raster = rasterize(pdf, document_id, cfg, store)
    try:
        dbm.upsert_document(conn, raster)
    except ValueError as e:
        print("error: %s" % e)
        return EXIT_FAIL
    sources = sorted({m.source for m in raster.masters})
    print("      %d pages, masters: %s%s" % (raster.page_count, ", ".join(sources),
                                             " (cached)" if raster.reused else ""))

    out = cfg.extracted_dir(document_id)
    present = sorted(out.glob("*.json"))
    marker = out / INCOMPLETE_MARKER
    retry = marker.exists() and not args.force
    if retry:
        print("[2/4] previous extraction was incomplete (%s): retrying" % marker)
    if present and not args.force and not retry:
        print("[2/4] extract: %d chunk file(s) already in %s, skipping (use --force to re-extract)"
              % (len(present), out))
    else:
        if present and not retry:  # never silently destroy (possibly hand-edited) JSON
            backup = out / "_replaced" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup.mkdir(parents=True, exist_ok=True)
            for f in present:
                shutil.move(str(f), str(backup / f.name))
            print("      moved %d previous chunk file(s) to %s" % (len(present), backup))
        try:
            extractor = get_extractor(extractor_name, source_dir=src, model=args.model,
                                      cache_dir=cfg.cache_dir / "claude")
        except (ValueError, RuntimeError) as e:
            print("error: %s" % e)
            return EXIT_FAIL
        print("[2/4] extract with %s -> %s" % (extractor_name, out))
        try:
            files = extractor.extract(raster.doc_input, out)
        except Exception as e:  # report and stop; any partial chunk files stay for inspection
            if _is_incomplete_extraction(e):
                failed = (getattr(extractor, "last_run_stats", None) or {}).get("failed_chunks") or []
                marker.write_text(json.dumps({"failed_chunks": failed, "message": str(e),
                                              "paths": [str(p) for p in getattr(e, "paths", [])]}, indent=1))
                print("extraction incomplete: %s" % e)
                if failed:
                    print("  failed chunks: %s" % ", ".join(failed))
                print("  nothing was loaded. Re-run the same command to retry the failed chunks; chunks that "
                      "already succeeded come from the cache at no cost.")
            else:
                print("extraction failed: %s: %s" % (type(e).__name__, e))
            return EXIT_FAIL
        if marker.exists():
            marker.unlink()
        print("      wrote %d chunk file(s)" % len(files))
    print("[3/4] crop + load, [4/4] index")
    return _load(conn, cfg, document_id, None)


def cmd_load(args, cfg: Config) -> int:
    return _load(dbm.connect(cfg.db_path), cfg, args.document_id, Path(args.from_dir) if args.from_dir else None)


def cmd_search(args, cfg: Config) -> int:
    from ingest.search import search
    conn = dbm.connect(cfg.db_path)
    hits = search(conn, args.query, topic=args.topic, paper=args.paper, qtype=args.type,
                  document=args.document, limit=args.limit, assets_root=cfg.assets_dir,
                  include_review=args.include_review)
    if args.json:
        print(json.dumps(hits, indent=2, ensure_ascii=False))
        return EXIT_OK
    if not hits:
        print("no matches")
    for h in hits:
        print("%s %s %-10s root %-3s %-10s %s  topics %s" % (
            h["document_id"], h["paper"], h["label"], h["root_label"], h["type"],
            "%sm" % h["marks"] if h["marks"] is not None else "-", ",".join(h["topics"]) or "-")
            + ("  [needs review]" if h["review_status"] != "ok" else ""))
        print("    %s" % " ".join((h["snippet"] or "").split()))
        if h["assets"]["page"]:
            print("    crop: %s" % h["assets"]["page"][0])     # whole question, on the part's page
        if h["assets"]["part"] and h["assets"]["part"][:1] != h["assets"]["page"][:1]:
            print("    part: %s" % h["assets"]["part"][0])
        print("    id: %s" % h["id"])
    return EXIT_OK


def _resolve_question(conn, ref: str):
    if re.match(r"^q_[0-9a-f]{16}$", ref):
        return conn.execute("SELECT * FROM questions WHERE id = ?", (ref,)).fetchone()
    parts = ref.split(":")
    if len(parts) == 3:
        doc, paper, label = parts
        return conn.execute("SELECT * FROM questions WHERE document_id = ? AND paper = ? AND label = ?",
                            (doc, paper.upper(), label.replace(" ", ""))).fetchone()
    return None


def cmd_show(args, cfg: Config) -> int:
    from ingest.search import effective_answers
    conn = dbm.connect(cfg.db_path)
    q = _resolve_question(conn, args.question)
    if q is None:
        print("no question %r (use a question id or <document_id>:<paper>:<label>, e.g. doc:P2:2(b)(ii))"
              % args.question)
        return EXIT_FAIL
    chain, p = [], q["parent_id"]
    while p:
        row = conn.execute("SELECT * FROM questions WHERE id = ?", (p,)).fetchone()
        chain.insert(0, row)
        p = row["parent_id"]
    topics = conn.execute("SELECT t.topic_code, tp.name FROM question_topics t JOIN topics tp ON tp.code = t.topic_code "
                          "WHERE t.question_id = ? ORDER BY t.rank", (q["id"],)).fetchall()
    print("%s %s %s   [%s%s]   id %s" % (q["document_id"], q["paper"], q["label"], q["type"],
                                         ", %s marks" % q["marks"] if q["marks"] is not None else "", q["id"]))
    if topics:
        print("topics: " + "; ".join("%s %s" % (t[0], t[1]) for t in topics))
    if q["review_status"] != "ok":
        print("NEEDS REVIEW: %s" % "; ".join(json.loads(q["review_reasons"])))
    if q["confidence"] != "high" or q["has_handwriting"] or q["notes"]:
        print("confidence: %s, handwriting: %s%s" % (q["confidence"], bool(q["has_handwriting"]),
                                                     ", notes: %s" % q["notes"] if q["notes"] else ""))
    print()
    for a in chain:
        if a["stem"].strip():
            print("[%s] %s\n" % (a["label"], a["stem"].strip()))
    print("[%s] %s" % (q["label"], q["stem"].strip()))
    for o in conn.execute("SELECT label, text FROM question_options WHERE question_id = ? ORDER BY ordinal", (q["id"],)):
        print("   %s  %s" % (o[0], o[1]))
    children = conn.execute("SELECT label, type, stem FROM questions WHERE parent_id = ? ORDER BY sort_key",
                            (q["id"],)).fetchall()
    if children:
        print("\nparts:")
        for c in children:
            print("  %-10s %-10s %s" % (c[0], c[1], (c[2].strip().splitlines() or [""])[0][:90]))
    answers = effective_answers(conn, q["id"])
    print("\nanswer:" if answers else "\nanswer: (none)")
    for a in answers:
        how = "" if a["link"] == "exact" else "  (key label %s, %s)" % (a["label"], a["link"])
        body = a["correct_option"] or ""
        if a["answer_text"]:
            body = (body + "  " if body else "") + a["answer_text"]
        print("  " + (body + how).replace("\n", "\n  "))
    ids = [r["id"] for r in chain] + [q["id"]]
    rows = conn.execute(
        "SELECT a.question_id, a.role, a.ordinal, a.page_index, a.caption, a.status, s.path FROM question_assets a "
        "LEFT JOIN assets s ON s.sha256 = a.asset_sha256 JOIN questions x ON x.id = a.question_id "
        "WHERE a.question_id IN (%s) ORDER BY a.role = 'region', a.role, x.depth, a.ordinal"
        % ",".join("?" * len(ids)), ids).fetchall()
    if rows:
        print("\nassets:")
        labels = {r["id"]: r["label"] for r in chain + [q]}
        for r in rows:
            print("  %-13s %-9s p%-3d %s%s%s" % (r["role"], labels[r["question_id"]], r["page_index"],
                                              cfg.assets_dir / r["path"] if r["path"] else "(no crop)",
                                              "  " + r["caption"] if r["caption"] else "",
                                              "" if r["status"] == "ok" else "  [%s]" % r["status"]))
    for a in answers:
        for r in conn.execute("SELECT s.path, a.page_index FROM answer_assets a JOIN assets s ON s.sha256 = a.asset_sha256 "
                              "WHERE a.answer_id = ? ORDER BY a.ordinal", (a["id"],)):
            print("  %-13s %-9s p%-3d %s" % ("answer", a["label"], r[1], cfg.assets_dir / r[0]))
    return EXIT_OK


def cmd_report(args, cfg: Config) -> int:
    from ingest.validate import read_chunks, validate
    conn = dbm.connect(cfg.db_path)
    doc = dbm.get_document(conn, args.document_id)
    if doc is None:
        print("unknown document %r" % args.document_id)
        return EXIT_FAIL
    issues = []
    src = cfg.extracted_dir(args.document_id)
    if src.is_dir():
        chunks, issues = read_chunks(src)
        issues += validate(chunks, args.document_id, doc["page_count"],
                           [r[0] for r in conn.execute("SELECT code FROM topics")])
    _report_and_save(conn, cfg, args.document_id, issues)
    return EXIT_INVALID if any(i.level == "error" for i in issues) else EXIT_OK


def cmd_topics(args, cfg: Config) -> int:
    conn = dbm.connect(cfg.db_path)
    rows = conn.execute(
        "SELECT t.code, t.name, t.parent_code, "
        "(SELECT COUNT(DISTINCT qt.question_id) FROM question_topics qt JOIN questions q ON q.id = qt.question_id "
        " WHERE q.is_leaf = 1 AND (qt.topic_code = t.code OR qt.topic_code LIKE t.code || '.%')) AS n "
        "FROM topics t").fetchall()
    key = lambda r: [int(x) for x in r["code"].split(".")]
    for r in sorted(rows, key=key):
        indent = "    " if r["parent_code"] else ""
        print("%s%-6s %4d  %s" % (indent, r["code"], r["n"], r["name"]))
    return EXIT_OK


def cmd_eval(args, cfg: Config) -> int:
    try:
        from ingest import eval as ev
    except ImportError as e:
        print("eval is not available (ingest/eval.py missing or broken: %s)" % e)
        return EXIT_FAIL
    result = ev.evaluate(Path(args.gold), Path(args.pred))
    print(ev.format_report(result))
    return EXIT_OK if result.get("passed", True) else EXIT_FAIL


def cmd_review(args, cfg: Config) -> int:
    conn = dbm.connect(cfg.db_path)
    sql = ("SELECT document_id, paper, label, id, review_reasons FROM questions WHERE review_status = 'needs_review'"
           + (" AND document_id = ?" if args.document else "") + " ORDER BY document_id, sort_key")
    rows = conn.execute(sql, (args.document,) if args.document else ()).fetchall()
    # flagged answers that are not attached to any question cannot hide one, so list them too
    orphan_sql = ("SELECT document_id, paper, label, review_flags, confidence FROM answers WHERE question_id IS NULL "
                  "AND (review_flags != '[]' OR confidence = 'low')" + (" AND document_id = ?" if args.document else ""))
    orphans = conn.execute(orphan_sql, (args.document,) if args.document else ()).fetchall()
    if not rows and not orphans:
        print("nothing needs review")
        return EXIT_OK
    print("%d question node(s) need review (hidden from search until the JSON is fixed and reloaded):"
          % len(rows))
    for r in rows:
        print("  %s %s %-10s %s   [%s]" % (r["document_id"], r["paper"], r["label"],
                                         "; ".join(json.loads(r["review_reasons"])), r["id"]))
    for r in orphans:
        reasons = json.loads(r["review_flags"]) + (["low_confidence"] if r["confidence"] == "low" else [])
        print("  %s %s answer %-6s %s   [unmatched answer]" % (r["document_id"], r["paper"], r["label"],
                                                             "; ".join(reasons)))
    return EXIT_OK


def cmd_gc(args, cfg: Config) -> int:
    from ingest.assets import LocalAssetStore, delete_garbage, garbage
    conn = dbm.connect(cfg.db_path)
    store = LocalAssetStore(cfg.assets_dir)
    found = garbage(conn, store)
    rows, files = found["rows"], found["files"]
    size = sum(r["bytes"] for r in rows) + sum(
        store.local_path(f).stat().st_size for f in files if store.local_path(f).exists())
    print("%d unreferenced asset row(s), %d untracked file(s), %.1f MB" % (len(rows), len(files), size / 1e6))
    for r in rows[:20]:
        print("  row   %-6s %s" % (r["kind"], r["path"]))
    for f in files[:20]:
        print("  file  %s" % f)
    if len(rows) + len(files) > 40:
        print("  ...")
    if not args.yes:
        if rows or files:
            print("dry run: nothing deleted. Re-run with --yes to delete (not while a load is running).")
        return EXIT_OK
    deleted = delete_garbage(conn, store, found)
    print("deleted %d asset(s)" % len(deleted))
    return EXIT_OK


def cmd_export(args, cfg: Config) -> int:
    from ingest.export import export_documents
    conn = dbm.connect(cfg.db_path)
    if args.all:
        ids = [r[0] for r in conn.execute("SELECT id FROM documents ORDER BY id")]
    elif args.document:
        ids = [args.document]
    else:
        print("give a document id or --all")
        return EXIT_FAIL
    try:
        data = export_documents(conn, ids, str(cfg.assets_dir))
    except KeyError as e:
        print("export failed: %s" % e.args[0])
        return EXIT_FAIL
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    print("exported %d document(s), %d top-level question(s) to %s"
          % (len(data["documents"]), len(data["questions"]), out))
    return EXIT_OK


def cmd_bundle(args, cfg: Config) -> int:
    import datetime
    from ingest.bundle import build_bundle
    name = args.name or "question-bank-" + datetime.date.today().isoformat()
    try:
        root = build_bundle(cfg, Path(args.out), name, make_zip=not args.no_zip, replace=args.force)
    except (FileExistsError, RuntimeError) as e:
        print("bundle failed: %s" % e)
        return EXIT_FAIL
    m = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    print("bundle written to %s%s" % (root, "" if args.no_zip else " (+ .zip)"))
    print("  " + ", ".join("%s=%s" % kv for kv in m["counts"].items()))
    return EXIT_OK


# ---------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", help="SQLite path (default data/db/questions.sqlite)")
    p = argparse.ArgumentParser(prog="python -m ingest", description="Exam-paper ingestion engine")
    sub = p.add_subparsers(dest="command", required=True)

    r = sub.add_parser("run", parents=[common], help="PDF -> question bank")
    r.add_argument("pdf")
    r.add_argument("--extractor", choices=["claude", "files"],
                   help="extraction backend (default: files if --from is given, else claude)")
    r.add_argument("--from", dest="from_dir", help="directory of contract JSON (files extractor)")
    r.add_argument("--document-id", help="document slug (default: existing id for this PDF, the JSON's "
                                         "document_id, or the PDF filename)")
    r.add_argument("--force", action="store_true", help="re-extract even if JSON exists (old JSON is moved aside)")
    r.add_argument("--model", help="model for the claude extractor")
    r.set_defaults(func=cmd_run)

    l = sub.add_parser("load", parents=[common], help="reload a document from its JSON")
    l.add_argument("document_id")
    l.add_argument("--from", dest="from_dir", help="read JSON from here instead of data/extracted/<id>")
    l.set_defaults(func=cmd_load)

    s = sub.add_parser("search", parents=[common], help="full-text search")
    s.add_argument("query")
    s.add_argument("--topic", help="topic code or prefix, e.g. 10 or 10.2")
    s.add_argument("--paper", help="P1, P2")
    s.add_argument("--type", choices=["mcq", "structured"])
    s.add_argument("--document")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--json", action="store_true")
    s.add_argument("--include-review", action="store_true", help="also return questions flagged needs_review")
    s.set_defaults(func=cmd_search)

    rv = sub.add_parser("review", parents=[common], help="list questions that need human review, with reasons")
    rv.add_argument("document", nargs="?")
    rv.set_defaults(func=cmd_review)

    g = sub.add_parser("gc", parents=[common], help="delete assets nothing references (dry run unless --yes)")
    g.add_argument("--yes", action="store_true", help="really delete")
    g.set_defaults(func=cmd_gc)

    x = sub.add_parser("export", parents=[common], help="denormalized JSON export for the app")
    x.add_argument("document", nargs="?")
    x.add_argument("--all", action="store_true", help="export every document")
    x.add_argument("--out", required=True)
    x.set_defaults(func=cmd_export)

    b = sub.add_parser("bundle", parents=[common], help="handoff bundle: DB + export + assets + guide")
    b.add_argument("--out", default="dist", help="output directory (default dist/)")
    b.add_argument("--name", help="bundle name (default question-bank-<date>)")
    b.add_argument("--no-zip", action="store_true")
    b.add_argument("--force", action="store_true", help="replace an existing bundle of the same name")
    b.set_defaults(func=cmd_bundle)

    sh = sub.add_parser("show", parents=[common], help="show one question")
    sh.add_argument("question", help="question id or <document_id>:<paper>:<label>")
    sh.set_defaults(func=cmd_show)

    rp = sub.add_parser("report", parents=[common], help="quality report")
    rp.add_argument("document_id")
    rp.set_defaults(func=cmd_report)

    t = sub.add_parser("topics", parents=[common], help="topics with question counts")
    t.set_defaults(func=cmd_topics)

    e = sub.add_parser("eval", parents=[common], help="score an extraction against a gold set")
    e.add_argument("--gold", required=True)
    e.add_argument("--pred", required=True)
    e.set_defaults(func=cmd_eval)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = Config.from_env(getattr(args, "db", None))
    return args.func(args, cfg)
