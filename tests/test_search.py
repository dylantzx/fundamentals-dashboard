from __future__ import annotations

import pytest

from ingest.search import build_match, load_synonyms, normalize, parse_query, query_tokens, search


@pytest.mark.parametrize("raw, expected", [
    ("H₂O", "H2O"), ("CaCO₃", "CaCO3"), ("SO₄²⁻", "SO42-"), ("Fe³⁺", "Fe3+"), ("Al₂(SO₄)₃", "Al2(SO4)3"),
    ("N₂ + 3H₂ ⇌ 2NH₃", "N2 + 3H2 2NH3"), ("ΔH", " delta H"), ("Eₐ", "Ea"), ("cm³", "cm3"),
])
def test_normalize(raw, expected):
    assert normalize(raw).strip() == expected.strip()


def test_query_escaping():
    assert build_match(parse_query('"(a')) == '("a" OR "a"*)'          # only stopwords: kept as typed
    assert build_match(parse_query("NOT h2o")) == '"not" AND ("h2o" OR "h2o"*)'
    assert query_tokens('*:^-()"') == [] and parse_query('*:^-()"') == []


SYN = {("redox",): [("redox",), ("oxidation",), ("reduction",), ("oxidation", "state")],
       ("dot", "and", "cross"): [("dot", "and", "cross")], ("brine",): [("brine",), ("sodium", "chloride")]}


def test_stopwords_and_synonyms():
    assert parse_query("electrolysis of the brine", SYN) == [[("electrolysis",)], [("brine",), ("sodium", "chloride")]]
    # "and" inside a synonym phrase survives; formula tokens are never stopwords
    assert parse_query("covalent dot and cross", SYN) == [[("covalent",)], [("dot", "and", "cross")]]
    assert parse_query("a h2o", SYN) == [[("h2o",)]]
    # synonym groups are OR-ed phrases, and get no prefix wildcard
    assert build_match(parse_query("redox", SYN)) == '("redox" OR "oxidation" OR "reduction" OR "oxidation state")'
    assert build_match(parse_query("brine electro", SYN), "OR") == \
        '("brine" OR "sodium chloride") OR ("electro" OR "electro"*)'


def test_synonym_file_loads():
    syn = load_synonyms()
    assert ("oxidation", "state") in syn[("redox",)] and ("ammonia",) in syn[("haber",)]


def labels(hits):
    return [(h["paper"], h["label"]) for h in hits]


def test_formula_search_matches_unicode(loaded, cfg):
    conn = loaded[0]
    hits = search(conn, "h2o")
    assert ("P1", "1") in labels(hits)                  # H₂O in an MCQ option
    assert ("P2", "1(b)(i)") in labels(hits)            # inherits "water, H₂O" from 1(b)'s stem
    assert ("P2", "1(b)") not in labels(hits)           # only leaves are returned
    assert labels(search(conn, "caco3"))[0] == ("P1", "1")
    assert ("P1", "1") in labels(search(conn, "SO₄²⁻"))
    h = search(conn, "h2o", assets_root=cfg.assets_dir)[0]
    assert h["root_label"] and h["snippet"] and h["assets"]["full_question"]


def test_inherited_context_and_figure_text(loaded):
    conn = loaded[0]
    # "marble" is only in the root stem; "cotton wool" only in the figure description
    assert set(labels(search(conn, "marble chips", include_review=True))) >= {("P2", "1(a)"), ("P2", "1(c)")}
    assert ("P2", "1(a)") in labels(search(conn, "cotton wool"))


def test_stemming_and_prefix(loaded):
    conn = loaded[0]
    assert ("P2", "1(c)") in labels(search(conn, "calculating volume", include_review=True))  # porter
    assert ("P2", "1(b)(ii)") in labels(search(conn, "powde"))            # prefix on last token


def test_filters(loaded):
    conn = loaded[0]
    assert set(labels(search(conn, "", topic="10"))) == {("P2", "1(a)"), ("P2", "1(b)(i)"), ("P2", "1(b)(ii)")}
    assert search(conn, "", topic="1") == []          # "1" must not match 10.x
    assert set(labels(search(conn, "", topic="10.2"))) == {("P2", "1(b)(i)"), ("P2", "1(b)(ii)")}
    assert labels(search(conn, "h2o", paper="p1")) == [("P1", "1")]
    assert labels(search(conn, "h2o", qtype="mcq")) == [("P1", "1")]
    assert all(h["type"] == "structured" for h in search(conn, "reaction", qtype="structured"))
    assert search(conn, "h2o", document="nope") == []
    assert len(search(conn, "", limit=2)) == 2


@pytest.mark.parametrize("q", ['"(a', "NOT", "AND OR", "*", '"', "a:b", "-x", "NEAR(", "^", "1(b)(ii", "''", "🙂"])
def test_fts_unsafe_queries_do_not_error(loaded, q):
    search(loaded[0], q)


def test_or_fallback(loaded):
    # no single question has both words; falls back to any-word matching
    assert search(loaded[0], "marble zzzunknown")


def test_needs_review_hidden_by_default(loaded):
    conn = loaded[0]
    assert ("P2", "1(c)") not in labels(search(conn, "calculate volume"))     # 1(c) has confidence low
    hit = [h for h in search(conn, "calculate volume", include_review=True) if h["label"] == "1(c)"][0]
    assert hit["review_status"] == "needs_review"
    assert ("P2", "1(c)") not in labels(search(conn, "", limit=50))


def test_and_hits_first_then_or_fill(loaded):
    conn = loaded[0]
    # only 1(b)(ii) has both words (marble via the root's context, powdered in its stem)
    hits = labels(search(conn, "marble powdered", limit=5))
    assert hits[0] == ("P2", "1(b)(ii)") and len(hits) > 1 and len(set(hits)) == len(hits)
    assert labels(search(conn, "marble powdered", limit=1)) == [("P2", "1(b)(ii)")]


def test_snippet_never_comes_from_topic_names(loaded):
    conn = loaded[0]
    # "affecting" only occurs in the name of topic 10.2, which 1(b)(i) is tagged with
    hits = search(conn, "affecting")
    assert ("P2", "1(b)(i)") in labels(hits)
    for h in hits:
        assert "[affecting" not in h["snippet"].lower() and "Factors" not in h["snippet"]
    stem_hit = search(conn, "decreases")[0]
    assert "[decreases]" in stem_hit["snippet"]          # stem preferred when it has the hit


def test_topic_filter_inherits_ancestor_topics(cfg, rasterized, contract, tmp_path):
    from conftest import write_contract
    from ingest.load import load_document
    contract["a.json"]["questions"][3]["topics"] = ["10.3"]          # context node 1(b)
    load_document(rasterized[0], cfg, "synthetic-test-paper", src_dir=write_contract(tmp_path / "j", contract))
    assert set(labels(search(rasterized[0], "", topic="10.3"))) == {("P2", "1(b)(i)"), ("P2", "1(b)(ii)")}


def test_exact_formula_outranks_prefix_match(cfg, rasterized, contract, tmp_path):
    from conftest import write_contract
    from ingest.load import load_document
    qs = contract["b.json"]["questions"]
    qs[0].update(confidence="high", stem="Calculate the mass of H₂O formed.")              # 1(c): exact
    contract["a.json"]["questions"][2]["stem"] = "Hydrogen peroxide, H₂O₂, decomposes. Name the gas."  # 1(a)
    load_document(rasterized[0], cfg, "synthetic-test-paper", src_dir=write_contract(tmp_path / "j", contract))
    order = labels(search(rasterized[0], "h2o", paper="P2"))
    assert order.index(("P2", "1(c)")) < order.index(("P2", "1(a)"))


def test_stopwords_do_not_drag_in_unrelated_questions(loaded):
    # "of" is in almost every stem; it must not make any-word fill return everything
    assert labels(search(loaded[0], "of zzzunknown", limit=20)) == []


def test_synonyms_in_search(loaded, tmp_path, monkeypatch):
    import ingest.search as srch
    f = tmp_path / "syn.json"
    f.write_text('{"synonyms": {"limestone": ["calcium carbonate"]}}')
    monkeypatch.setattr(srch, "SYNONYMS_PATH", f)
    assert labels(search(loaded[0], "limestone")) == [("P1", "1")]       # MCQ stem: "calcium carbonate"


def test_own_text_outranks_inherited_context(loaded):
    # "acid" is in the root stem (context of every part) and nowhere else... except 1(a)'s own text
    # after this edit-free check: parts that only inherit it rank below a part that has it itself
    hits = search(loaded[0], "gas")
    assert hits[0]["label"] == "1(a)"                                  # "Name the gas produced"


def test_part_crop_is_on_the_parts_page(loaded, cfg):
    hit = [h for h in search(loaded[0], "powdered", assets_root=cfg.assets_dir) if h["label"] == "1(b)(ii)"][0]
    full = hit["assets"]["full_question"]
    assert len(full) == 2 and len(hit["assets"]["part"]) == 2 and hit["assets"]["page"] == full   # spans both
    c = search(loaded[0], "calculate volume", assets_root=cfg.assets_dir, include_review=True)[0]
    assert c["label"] == "1(c)" and c["assets"]["page"] == full[1:]          # 1(c) is printed on page 1 only
