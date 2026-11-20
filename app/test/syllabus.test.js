// The MOE 6092 syllabus panel, the question-level topic tags CSV, "similar questions",
// the /bank/topic and /bank/try pages. Pure parts run always; the rest runs against the
// real ../question-bank (skipped if it isn't there), like test/practice.test.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server.js';
import { loadQuestionBank } from '../lib/question-bank.js';
import {
  loadSyllabus, parseSyllabus, placeInSyllabus, compareCodes, topicCodeOf, CODE_RE, EMPTY_SYLLABUS,
} from '../lib/syllabus.js';
import { parseCsv, toTopicTags, loadTopicTags, findTag, topicByName } from '../lib/topic-tags.js';
import { tokens, buildSimilarity, bestPerQuestion } from '../lib/similar.js';
import { renderBankQuestion, renderBankTopic, renderTry } from '../views/practice.js';
import { views, buildDashboardModel, publicDir } from './helpers/app-parts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const BANK_DIR = path.join(REPO, 'question-bank');
const SYLLABUS_FILE = path.join(REPO, 'taxonomy', 'o_level_chemistry_6092.json');
const TAGS_FILE = path.join(REPO, 'assets', 'chemistry_topic_tags.csv');
const HAVE_BANK = fs.existsSync(path.join(BANK_DIR, 'export.json'));
const HAVE_SYLLABUS = fs.existsSync(SYLLABUS_FILE);
const HAVE_TAGS = fs.existsSync(TAGS_FILE);
const NEED_ALL = !(HAVE_BANK && HAVE_SYLLABUS && HAVE_TAGS) && 'no question bank, syllabus or topic tags CSV';
const STUDENT = { username: 'mei', password: 'student-pass-456' };
const PARENT = { username: 'MumTan', password: 'parent-pass-123' };

/** A small syllabus in the taxonomy JSON's shape. */
const MINI_SYLLABUS = parseSyllabus({
  syllabus: 'GCE O-Level Chemistry 6092 (2024)',
  topics: [
    { code: '2', name: 'The Particulate Nature of Matter', subtopics: [
      { code: '2.1', name: 'Kinetic particle theory' }, { code: '2.2', name: 'Atomic structure' }] },
    { code: '10', name: 'Rate of Reactions', subtopics: [
      { code: '10.1', name: 'Measuring rate' }, { code: '10.2', name: 'Factors affecting rate (concentration, temperature)' }] },
    { code: 'x', name: 'Not a code', subtopics: [] },
    { code: '11', name: 42 },
  ],
});

// ---- syllabus ---------------------------------------------------------------

describe('syllabus', () => {
  test('parseSyllabus keeps well-formed topics and reads the title', () => {
    assert.equal(MINI_SYLLABUS.title, 'O-Level Chemistry (6092)');
    assert.deepEqual([...MINI_SYLLABUS.topics.keys()], ['2', '10']);
    assert.deepEqual(MINI_SYLLABUS.subtopics.get('10.2'), { code: '10.2', name: 'Factors affecting rate (concentration, temperature)', topic: '10' });
    assert.equal(parseSyllabus(null).topics.size, 0);
    assert.equal(parseSyllabus({}).title, EMPTY_SYLLABUS.title);
  });

  test('codes: CODE_RE, topicCodeOf and natural order', () => {
    for (const ok of ['1', '10', '10.2', '2.11']) assert.ok(CODE_RE.test(ok), ok);
    for (const bad of ['', '10.', '.2', '100', '1.2.3', 'a', '10.2x']) assert.ok(!CODE_RE.test(bad), bad);
    assert.equal(topicCodeOf('10.2'), '10');
    assert.equal(topicCodeOf('3'), '3');
    assert.deepEqual(['10.1', '2.2', '10', '2.10', '2.9', '1'].sort(compareCodes), ['1', '2.2', '2.9', '2.10', '10', '10.1']);
  });

  test('placeInSyllabus names the topic and subtopic, falling back to the tag', () => {
    assert.deepEqual(placeInSyllabus(MINI_SYLLABUS, { code: '10.2' }), {
      topic: { code: '10', name: 'Rate of Reactions' },
      subtopic: { code: '10.2', name: 'Factors affecting rate (concentration, temperature)' },
    });
    assert.deepEqual(placeInSyllabus(EMPTY_SYLLABUS, { code: '4.1', name: 'The mole' }), {
      topic: { code: '4', name: '' }, subtopic: { code: '4.1', name: 'The mole' },
    });
  });

  test('loadSyllabus falls back to an empty syllabus on a missing or broken file', () => {
    assert.equal(loadSyllabus('/no/such/file.json'), EMPTY_SYLLABUS);
    assert.equal(loadSyllabus(null), EMPTY_SYLLABUS);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-syl-'));
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    const lines = [];
    assert.equal(loadSyllabus(bad, (l) => lines.push(l)), EMPTY_SYLLABUS);
    assert.equal(lines.length, 1);
  });

  test('the real taxonomy has the twelve 6092 topics', { skip: !HAVE_SYLLABUS && 'no taxonomy file' }, () => {
    const s = loadSyllabus(SYLLABUS_FILE);
    assert.equal(s.title, 'O-Level Chemistry (6092)');
    assert.deepEqual([...s.topics.keys()], ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    assert.equal(s.subtopics.get('2.1').topic, '2');
  });
});

// ---- topic tags CSV -----------------------------------------------------------

describe('topic tags CSV', () => {
  test('parseCsv handles quoted commas, doubled quotes, CRLF, a BOM and blank lines', () => {
    const text = '﻿school,question_no,summary\r\n'
      + 'Montfort,A3,"rate vs concentration, collision theory"\r\n'
      + '\r\n'
      + 'Fu Hua,4,"the ""best"" answer, then ""why"""\n'
      + 'Yishun Town,"B9","line one\nline two"\n'
      + 'Short row,7';
    assert.deepEqual(parseCsv(text), [
      { school: 'Montfort', question_no: 'A3', summary: 'rate vs concentration, collision theory' },
      { school: 'Fu Hua', question_no: '4', summary: 'the "best" answer, then "why"' },
      { school: 'Yishun Town', question_no: 'B9', summary: 'line one\nline two' },
      { school: 'Short row', question_no: '7', summary: '' },
    ]);
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('a,b\n'), []);
  });

  test('toTopicTags reads question numbers, papers and secondary topics', () => {
    const csv = 'school,year,paper,question_no,primary_topic,secondary_topics,summary\n'
      + 'Montfort,2025,p2,A3,Rate of Reactions,Maintaining Air Quality,"rate, collisions"\n'
      + 'Montfort,2025,P2,B9,Organic Chemistry,Chemical Energetics; Chemical Calculations ;,fuels\n'
      + 'Montfort,2025,P1,12,Atomic Structure,None (single topic),isotopes\n'
      + 'Montfort,2025,P1,,Atomic Structure,,no question number\n'
      + ',2025,P1,13,Atomic Structure,,no school\n';
    assert.deepEqual(toTopicTags(parseCsv(csv)), [
      { school: 'Montfort', year: '2025', paper: 'P2', question: '3', primary: 'Rate of Reactions', secondary: ['Maintaining Air Quality'], summary: 'rate, collisions' },
      { school: 'Montfort', year: '2025', paper: 'P2', question: '9', primary: 'Organic Chemistry', secondary: ['Chemical Energetics', 'Chemical Calculations'], summary: 'fuels' },
      { school: 'Montfort', year: '2025', paper: 'P1', question: '12', primary: 'Atomic Structure', secondary: [], summary: 'isotopes' },
    ]);
  });

  test('findTag matches a short school name and section-lettered question numbers', () => {
    const tags = [
      { school: 'Montfort', year: '2025', paper: 'P2', question: '3', primary: 'Rate of Reactions', secondary: [], summary: '' },
      { school: 'Fu Hua', year: '2025', paper: 'P2', question: '3', primary: 'Redox Chemistry', secondary: [], summary: '' },
    ];
    assert.equal(findTag(tags, { school: 'Montfort Secondary School', year: 2025, paper: 'p2', label: '3' }), tags[0]);
    assert.equal(findTag(tags, { school: 'Fu Hua Secondary', year: '2025', paper: 'P2', label: '3' }), tags[1]);
    assert.equal(findTag(tags, { school: 'Montfort Secondary School', paper: 'P2', label: '3' }), tags[0], 'no year: any year');
    assert.equal(findTag(tags, { school: 'Montfort Secondary School', year: 2024, paper: 'P2', label: '3' }), null);
    assert.equal(findTag(tags, { school: 'Montfort Secondary School', year: 2025, paper: 'P1', label: '3' }), null);
    assert.equal(findTag(tags, { school: 'Montfort Secondary School', year: 2025, paper: 'P2', label: 'A3' }), null);
    assert.equal(findTag(tags, { school: 'Ang Mo Kio', year: 2025, paper: 'P2', label: '3' }), null);
  });

  test('topicByName splits topic 2 into its halves and finds the rest by name', () => {
    assert.deepEqual(topicByName(MINI_SYLLABUS, 'Kinetic Particle Theory'), { code: '2.1', name: 'Kinetic Particle Theory' });
    assert.deepEqual(topicByName(MINI_SYLLABUS, ' atomic structure '), { code: '2.2', name: ' atomic structure ' });
    assert.deepEqual(topicByName(MINI_SYLLABUS, 'rate of reactions'), { code: '10', name: 'Rate of Reactions' });
    assert.deepEqual(topicByName(MINI_SYLLABUS, 'Alchemy'), { code: '', name: 'Alchemy' });
    // The split works even with no syllabus loaded.
    assert.equal(topicByName(EMPTY_SYLLABUS, 'Atomic Structure').code, '2.2');
  });

  test('loadTopicTags returns [] for a missing file', () => {
    assert.deepEqual(loadTopicTags('/no/such/file.csv'), []);
    assert.deepEqual(loadTopicTags(undefined), []);
  });

  test('every topic name in the real CSV is a place in the real syllabus', { skip: !(HAVE_TAGS && HAVE_SYLLABUS) && 'no CSV or taxonomy' }, () => {
    const syllabus = loadSyllabus(SYLLABUS_FILE);
    const tags = loadTopicTags(TAGS_FILE);
    assert.ok(tags.length > 100);
    for (const name of new Set(tags.flatMap((t) => [t.primary, ...t.secondary]))) {
      assert.ok(topicByName(syllabus, name).code, `"${name}" has no syllabus code`);
    }
    assert.equal(topicByName(syllabus, 'Kinetic Particle Theory').code, '2.1');
    assert.equal(topicByName(syllabus, 'Atomic Structure').code, '2.2');
    assert.equal(topicByName(syllabus, 'The Particulate Nature of Matter').code, '2');
    // A summary with a comma came through as one field.
    assert.ok(tags.some((t) => t.summary === 'rate vs concentration, collision theory, SO2 source, catalyst'));
    // One row per printed question.
    const keys = tags.map((t) => [t.school, t.year, t.paper, t.question].join('|'));
    assert.equal(new Set(keys).size, keys.length);
  });
});

// ---- similar questions ----------------------------------------------------------

describe('similar questions', () => {
  const MARBLE = 'Marble chips react with hydrochloric acid and the rate of carbon dioxide release is measured with a gas syringe';
  const it = (id, rootId, type, codes, searchText, extra = {}) => ({ id, rootId, type, codeSet: new Set(codes), searchText, ...extra });
  const items = [
    it('a1', 'A', 'mcq', ['10.2'], MARBLE),
    it('a2', 'A', 'mcq', ['10.2'], MARBLE),
    it('b1', 'B', 'structured', ['10.2'], 'Draw a dot and cross diagram for a methane molecule'),
    it('c1', 'C', 'structured', ['3.2'], MARBLE),
    it('c2', 'C', 'structured', ['3.2'], 'Marble chips react with hydrochloric acid'),
    it('d1', 'D', 'mcq', ['10.1'], 'Electrolysis of concentrated brine with inert electrodes'),
    it('e1', 'E', 'mcq', [], 'Fractional distillation of crude oil into fractions'),
    it('f1', 'F', 'mcq', [], 'Haber process: ammonia with an iron catalyst'),
    it('g1', 'G', 'mcq', [], 'Fermentation of glucose by yeast to ethanol'),
  ];
  const { similar } = buildSimilarity(items);

  test('tokens reads subscripts, drops stopwords and numbers, and stems', () => {
    assert.deepEqual(tokens('H₂O and CO₂'), ['h2o', 'co2']);
    assert.deepEqual(tokens('The 25 reacting'), ['react']);
    assert.deepEqual(tokens(null), []);
  });

  test('never the same printed question, at most one part of each other one, best first', () => {
    const list = similar('a1', 10);
    assert.ok(list.length >= 2);
    assert.ok(list.every((s) => s.item.rootId !== 'A'));
    const roots = list.map((s) => s.item.rootId);
    assert.equal(new Set(roots).size, roots.length);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].score >= list[i].score);
    for (const s of list) assert.deepEqual(Object.keys(s).sort(), ['item', 'sameMain', 'score', 'shared', 'sharedTopics', 'text']);
    // Unrelated questions are left out.
    assert.ok(!roots.includes('E') && !roots.includes('F') && !roots.includes('G'));
    assert.deepEqual(similar('a1', 1).map((s) => s.item.id), [list[0].item.id]);
    assert.deepEqual(similar('nope'), []);
  });

  test('a shared subtopic outranks identical wording alone', () => {
    const [first, second, third] = similar('a1', 10);
    assert.equal(first.item.id, 'b1');
    assert.deepEqual(first.shared, ['10.2']);
    assert.equal(second.item.id, 'c1', 'the closest part of question C');
    assert.deepEqual(second.shared, []);
    assert.deepEqual(second.sharedTopics, []);
    assert.ok(second.text > 0.9, `text ${second.text}`);
    assert.ok(first.text < 0.1);
    assert.equal(third.item.id, 'd1', 'same topic 10, different subtopic');
    assert.deepEqual(third.sharedTopics, ['10']);
  });

  test('the same main topic counts', () => {
    const withMain = items.map((x) => ({ ...x, mainTopic: ['E', 'G'].includes(x.rootId) ? { code: '7', name: 'Redox Chemistry' } : null }));
    const list = buildSimilarity(withMain).similar('e1', 5);
    assert.equal(list[0].item.id, 'g1');
    assert.equal(list[0].sameMain, true);
  });

  test('bestPerQuestion sorts, keeps one per question and ties by id', () => {
    const e = (id, rootId, score) => ({ item: { id, rootId }, score });
    assert.deepEqual(bestPerQuestion([e('x2', 'X', 1), e('y1', 'Y', 2), e('x1', 'X', 1), e('z1', 'Z', 0.5)], 5).map((s) => s.item.id), ['y1', 'x1', 'z1']);
    assert.equal(bestPerQuestion([e('x1', 'X', 1), e('y1', 'Y', 2)], 1).length, 1);
  });
});

// ---- the real bank ----------------------------------------------------------------

describe('the bank with syllabus and topic tags', { skip: NEED_ALL }, () => {
  const syllabus = HAVE_SYLLABUS ? loadSyllabus(SYLLABUS_FILE) : EMPTY_SYLLABUS;
  const tags = HAVE_TAGS ? loadTopicTags(TAGS_FILE) : [];
  const bank = !NEED_ALL ? loadQuestionBank(BANK_DIR, { syllabus, topicTags: tags }) : null;

  test('every bank question has a row in the topic tags CSV', () => {
    assert.ok(bank.roots.length > 0);
    for (const root of bank.roots) {
      const paper = bank.papers.find((p) => p.documentId === root.document_id && p.paper === root.paper);
      const tag = findTag(tags, { school: paper.school, year: paper.year, paper: root.paper, label: root.label });
      assert.ok(tag, `${paper.school} ${root.paper} Q${root.label} has no tag`);
      const about = bank.about(root.id);
      assert.ok(about.main?.code, `${root.paper} Q${root.label} has no main topic`);
      assert.equal(about.summary, tag.summary);
    }
    assert.deepEqual(bank.about('q_nope'), { main: null, also: [], summary: '' });
  });

  test('items carry their syllabus places, main topic and summary', () => {
    for (const item of bank.items) {
      assert.equal(item.syllabusTitle, 'O-Level Chemistry (6092)');
      assert.equal(item.syllabus.length, item.topics.length);
      for (const p of item.syllabus) {
        assert.equal(p.topic.code, topicCodeOf(p.subtopic.code));
        assert.ok(p.topic.name, `${item.id} ${p.subtopic.code} has no topic name`);
      }
      assert.ok(item.mainTopic?.code);
      assert.ok(Array.isArray(item.alsoTopics));
      assert.equal(typeof item.summary, 'string');
      assert.equal(item.rootLabel, bank.root(item.rootId).label);
      assert.ok(item.steadyTopics.every((t) => bank.forTopic(t).includes(item)));
    }
    // P2 Q3 is "A3" in the CSV.
    const p2q3 = bank.roots.find((r) => r.paper === 'P2' && r.label === '3');
    if (p2q3) assert.equal(bank.about(p2q3.id).main.code, '10');
  });

  test('syllabus index and forSyllabus', () => {
    const codes = bank.syllabusIndex.map((t) => t.code);
    assert.deepEqual(codes, [...codes].sort(compareCodes));
    for (const t of bank.syllabusIndex) {
      assert.ok(t.count > 0);
      const all = bank.forSyllabus(t.code);
      for (const st of t.subtopics) {
        assert.equal(topicCodeOf(st.code), t.code);
        for (const x of bank.forSyllabus(st.code)) assert.ok(all.includes(x), `${st.code} item missing from topic ${t.code}`);
      }
    }
    assert.deepEqual(bank.forSyllabus('99'), []);
  });

  test('similar() and similarToRoot() keep their rules across the whole bank', () => {
    for (const item of bank.items) {
      const list = bank.similar(item.id, 5);
      assert.ok(list.length <= 5);
      const roots = list.map((s) => s.item.rootId);
      assert.ok(!roots.includes(item.rootId), `${item.id} lists its own question`);
      assert.equal(new Set(roots).size, roots.length, `${item.id} lists a question twice`);
      for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].score >= list[i].score);
    }
    for (const root of bank.roots) {
      const list = bank.similarToRoot(root.id, 5);
      const roots = list.map((s) => s.item.rootId);
      assert.ok(!roots.includes(root.id));
      assert.equal(new Set(roots).size, roots.length);
      for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].score >= list[i].score);
    }
    assert.deepEqual(bank.similarToRoot('q_nope'), []);
  });
});

// ---- HTML escaping -------------------------------------------------------------------

describe('syllabus views escape bank and CSV text', { skip: NEED_ALL }, () => {
  const EVIL = '<script>alert(1)</script>';
  const EVIL_TOPIC = '<img src=x onerror=alert(2)>';
  const syllabus = HAVE_SYLLABUS ? loadSyllabus(SYLLABUS_FILE) : EMPTY_SYLLABUS;
  // Every row's summary is hostile, and one secondary topic is an unknown (unlinked) name.
  const tags = HAVE_TAGS ? loadTopicTags(TAGS_FILE).map((t) => ({ ...t, summary: EVIL, secondary: [...t.secondary, EVIL_TOPIC] })) : [];
  const bank = !NEED_ALL ? loadQuestionBank(BANK_DIR, { syllabus, topicTags: tags }) : null;
  const user = { username: 'mei' };
  const clean = (htmlText, where) => {
    assert.ok(!htmlText.includes('<script>alert'), `${where}: raw <script>`);
    assert.ok(!htmlText.includes('<img src=x'), `${where}: raw <img>`);
  };

  test('bank question page: summary and topic names are escaped', () => {
    const root = bank.roots[0];
    const page = String(renderBankQuestion({
      user, root, paperName: 'Paper 1', source: 'Montfort',
      about: { ...bank.about(root.id), places: bank.items.filter((i) => i.rootId === root.id).flatMap((i) => i.syllabus) },
      syllabusTitle: bank.syllabusTitle,
      similar: bank.similarToRoot(root.id, 5),
    }));
    clean(page, 'bank question');
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(page.includes('&lt;img src=x onerror=alert(2)&gt;'));
    assert.match(page, /class="q-syllabus"/);
  });

  test('topic page and try page: summaries in lists are escaped', () => {
    const mcq = bank.items.find((i) => i.type === 'mcq' && i.id === i.rootId);
    const code = mcq.syllabus[0].subtopic.code;
    const topicPage = String(renderBankTopic({
      user, code, title: code, parent: null, syllabusTitle: bank.syllabusTitle, subtopics: [],
      items: bank.forSyllabus(code), backHref: '/bank',
    }));
    clean(topicPage, 'topic page');
    assert.ok(topicPage.includes('&lt;script&gt;'), 'an MCQ is listed by its summary');

    const tryPage = String(renderTry({
      user, item: mcq, feedback: { picked: mcq.correctOption }, similar: bank.similar(mcq.id, 3), source: 'Montfort',
    }));
    clean(tryPage, 'try page');
    assert.match(tryPage, /Similar questions in the bank/);
  });
});

// ---- pages -------------------------------------------------------------------------

describe('syllabus and try pages', { skip: NEED_ALL }, () => {
  let server, base, dataDir, student, parent;

  const req = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const get = (p, cookie) => req(p, { headers: cookie ? { cookie } : {} });
  const post = (p, form, cookie) => req(p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form).toString(),
  });
  async function login(who) {
    const res = await post('/login', who);
    assert.equal(res.status, 303);
    return res.headers.get('set-cookie').split(';')[0];
  }
  const userId = (who) => server.store.findUserByUsername(who.username).id;
  const progress = () => server.store.getProgress(userId(STUDENT));
  const logged = (who) => server.answers.list(userId(who));
  const topicCount = (t) => progress().topics[t] || { right: 0, total: 0 };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-syllabus-'));
    server = createApp({
      dataDir, scryptN: 16, views, buildDashboardModel, publicDir, bankDir: BANK_DIR, log: () => {},
      syllabusFile: SYLLABUS_FILE, topicTagsFile: TAGS_FILE,
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    await post('/setup', {
      parentUsername: PARENT.username, parentPassword: PARENT.password,
      studentUsername: STUDENT.username, studentPassword: STUDENT.password,
    });
    student = await login(STUDENT);
    parent = await login(PARENT);
  });
  after(() => new Promise((r) => server.close(r)));

  test('topic and subtopic pages; unknown codes are 404', async () => {
    let res = await get('/bank/topic/10', student);
    assert.equal(res.status, 200);
    let body = await res.text();
    assert.match(body, /Topic 10 · Rate of Reactions/);
    assert.match(body, /href="\/bank\/topic\/10\.2"/);
    assert.match(body, /href="\/bank\/try\/[A-Za-z0-9_-]+"/);

    res = await get('/bank/topic/10.2', parent);
    assert.equal(res.status, 200);
    body = await res.text();
    const n = server.bank.forSyllabus('10.2').length;
    assert.match(body, new RegExp(`${n} questions? in the bank on this subtopic`));
    assert.match(body, /href="\/bank\/topic\/10"/);

    for (const p of ['/bank/topic/99', '/bank/topic/10.9', '/bank/topic/6.9']) {
      assert.equal((await get(p, student)).status, 404, p);
    }
    // Malformed codes are a 404 too, not the generic /bank "Coming next" placeholder.
    for (const p of ['/bank/topic/10.', '/bank/topic/1.2.3', '/bank/topic/abc', '/bank/topic/100']) {
      const r = await get(p, student);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(await r.text(), /questions? in the bank on this/, p);
    }
  });

  test('syllabus and try pages need a login', async () => {
    const item = server.bank.items[0];
    for (const p of ['/bank/topic/10', '/bank/topic/10.2', '/bank/topic/99', `/bank/try/${item.id}`]) {
      const res = await get(p);
      assert.equal(res.status, 303, p);
      assert.equal(res.headers.get('location'), '/login', p);
    }
    const res = await post(`/bank/try/${item.id}/answer`, { choice: 'A', self: 'right' });
    assert.equal(res.headers.get('location'), '/login');
    // An unknown id is a 404, like /bank/q/q_nope; logged out it still goes to /login.
    const nope = await get('/bank/try/q_nope', student);
    assert.equal(nope.status, 404);
    assert.equal((await get('/bank/try/q_nope')).headers.get('location'), '/login');
    assert.doesNotMatch(await nope.text(), /name="choice"|Show the mark scheme/);
    assert.equal((await post('/bank/try/q_nope/answer', { choice: 'A' }, student)).status, 404);
  });

  test('/bank lists syllabus topics; a question page shows its place and similar questions', async () => {
    const index = await (await get('/bank', student)).text();
    assert.match(index, /By MOE syllabus topic/);
    for (const t of server.bank.syllabusIndex) assert.ok(index.includes(`href="/bank/topic/${t.code}"`), t.code);

    const root = server.bank.roots.find((r) => server.bank.similarToRoot(r.id, 5).length);
    const page = await (await get(`/bank/q/${root.id}`, student)).text();
    assert.match(page, /class="q-syllabus"/);
    assert.match(page, /MOE syllabus/);
    assert.match(page, /<section class="similar"[^>]*>\s*<h2 class="similar-h"[^>]*>Similar questions/);
    assert.match(page, /href="\/bank\/try\//);
  });

  test('try an MCQ: wrong then right, recorded for the student', async () => {
    const item = server.bank.items.find((i) => i.type === 'mcq' && i.steadyTopics.length);
    assert.ok(item, 'an MCQ on a Steady topic');
    const topic = item.steadyTopics[0];
    const url = `/bank/try/${item.id}`;

    const page = await (await get(url, student)).text();
    assert.match(page, new RegExp(`action="${url}/answer"`));
    assert.match(page, /name="choice"/);
    assert.match(page, /class="q-syllabus"/);
    assert.doesNotMatch(page, /Similar questions in the bank/, 'no similar list before answering');

    const before = topicCount(topic);
    const nLogged = logged(STUDENT).length;
    const wrong = item.options.find((o) => o.label !== item.correctOption).label;
    let res = await post(`${url}/answer`, { choice: wrong }, student);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${url}?picked=${wrong}`);
    assert.deepEqual(topicCount(topic), { right: before.right, total: before.total + 1 });
    const last = logged(STUDENT).at(-1);
    assert.equal(logged(STUDENT).length, nLogged + 1);
    assert.deepEqual({ topicId: last.topicId, questionId: last.questionId, correct: last.correct, level: last.level, pool: last.pool },
      { topicId: topic, questionId: item.id, correct: false, level: 'exam', pool: 'practice' });

    const after = await (await get(res.headers.get('location'), student)).text();
    assert.match(after, new RegExp(`The answer is ${item.correctOption}`));
    assert.doesNotMatch(after, /name="choice"/);
    const sim = server.bank.similar(item.id, 3);
    if (sim.length) {
      assert.match(after, /Similar questions in the bank/);
      for (const s of sim) assert.ok(after.includes(`href="/bank/try/${s.item.id}"`), s.item.id);
      assert.match(after, /Next similar question/);
    }

    res = await post(`${url}/answer`, { choice: item.correctOption }, student);
    assert.equal(res.headers.get('location'), `${url}?picked=${item.correctOption}`);
    assert.deepEqual(topicCount(topic), { right: before.right + 1, total: before.total + 2 });
    assert.equal(logged(STUDENT).at(-1).correct, true);
    assert.match(await (await get(res.headers.get('location'), student)).text(), /Right\./);
  });

  test('try a structured part: self-marked and recorded', async () => {
    const item = server.bank.items.find((i) => i.type === 'structured' && i.steadyTopics.length);
    assert.ok(item, 'a written part on a Steady topic');
    const topic = item.steadyTopics[0];
    const url = `/bank/try/${item.id}`;
    const page = await (await get(url, student)).text();
    assert.match(page, /Show the mark scheme/);
    assert.match(page, /name="self" value="right"/);
    assert.doesNotMatch(page, /Similar questions in the bank/);

    const before = topicCount(topic);
    const res = await post(`${url}/answer`, { self: 'wrong' }, student);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${url}?self=wrong`);
    assert.deepEqual(topicCount(topic), { right: before.right, total: before.total + 1 });
    assert.equal(logged(STUDENT).at(-1).questionId, item.id);
    const after = await (await get(res.headers.get('location'), student)).text();
    assert.match(after, /class="q-scheme"/);
    assert.doesNotMatch(after, /name="self"/);
    if (server.bank.similar(item.id, 3).length) assert.match(after, /Similar questions in the bank/);
    // Reloading the result does not count it again.
    await get(res.headers.get('location'), student);
    assert.deepEqual(topicCount(topic), { right: before.right, total: before.total + 1 });
  });

  test('a parent can try a question but nothing is recorded', async () => {
    const item = server.bank.items.find((i) => i.type === 'mcq' && i.steadyTopics.length);
    const url = `/bank/try/${item.id}`;
    assert.equal((await get(url, parent)).status, 200);
    const before = progress();
    const nStudent = logged(STUDENT).length;
    const res = await post(`${url}/answer`, { choice: item.correctOption }, parent);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${url}?picked=${item.correctOption}`);
    assert.deepEqual(logged(PARENT), []);
    assert.equal(logged(STUDENT).length, nStudent);
    assert.deepEqual(progress(), before);
    assert.match(await (await get(res.headers.get('location'), parent)).text(), /Right\./);
  });

  test('bad answers redirect back without recording; off-topic questions are not recorded', async () => {
    const mcq = server.bank.items.find((i) => i.type === 'mcq' && i.steadyTopics.length);
    const part = server.bank.items.find((i) => i.type === 'structured');
    const before = progress();
    const n = logged(STUDENT).length;
    for (const [item, form] of [[mcq, { choice: 'Z' }], [mcq, {}], [mcq, { self: 'right' }], [part, { self: 'maybe' }], [part, { choice: 'A' }]]) {
      const res = await post(`/bank/try/${item.id}/answer`, form, student);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/bank/try/${item.id}`, JSON.stringify(form));
    }
    // A made-up ?picked= shows the question again, not a result.
    const page = await (await get(`/bank/try/${mcq.id}?picked=Z`, student)).text();
    assert.match(page, /name="choice"/);
    assert.doesNotMatch(page, /Similar questions in the bank/);

    const offTopic = server.bank.items.find((i) => i.type === 'mcq' && !i.steadyTopics.length);
    assert.ok(offTopic);
    const res = await post(`/bank/try/${offTopic.id}/answer`, { choice: offTopic.correctOption }, student);
    assert.equal(res.headers.get('location'), `/bank/try/${offTopic.id}?picked=${offTopic.correctOption}`);
    assert.deepEqual(progress(), before);
    assert.equal(logged(STUDENT).length, n);
  });

  test('practice shows the syllabus panel, and similar questions only after answering', async () => {
    const item = server.bank.forTopic('t3')[0];
    let body = await (await get('/practise/t3?i=0', student)).text();
    assert.match(body, /class="q-syllabus"/);
    assert.match(body, /MOE syllabus/);
    assert.match(body, /href="\/bank\/topic\/2\.2"/);
    assert.doesNotMatch(body, /Similar questions in the bank/);

    body = await (await get(`/practise/t3?i=0&picked=${item.correctOption}`, student)).text();
    assert.match(body, /Similar questions in the bank/);
    for (const s of server.bank.similar(item.id, 3)) assert.ok(body.includes(`href="/bank/try/${s.item.id}"`), s.item.id);
  });
});

describe('a crafted topic tags CSV through the server', { skip: NEED_ALL }, () => {
  let server, base, cookie;
  before(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-tags-'));
    // The real CSV with every summary replaced by a quoted, comma-holding <script>.
    const lines = fs.readFileSync(TAGS_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const head = parseCsv(lines[0] + '\n' + lines[0])[0];
    const cols = Object.keys(head);
    const rows = parseCsv(lines.join('\n')).map((r) => cols.map((c) => (c === 'summary' ? '"<script>alert(""x"")</script>, sneaky"' : `"${r[c].replace(/"/g, '""')}"`)).join(','));
    const file = path.join(dir, 'tags.csv');
    fs.writeFileSync(file, [cols.join(','), ...rows].join('\r\n'));
    server = createApp({
      dataDir: dir, scryptN: 16, views, buildDashboardModel, publicDir, bankDir: BANK_DIR, log: () => {},
      syllabusFile: SYLLABUS_FILE, topicTagsFile: file,
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, form) => fetch(base + p, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
    });
    await post('/setup', {
      parentUsername: PARENT.username, parentPassword: PARENT.password,
      studentUsername: STUDENT.username, studentPassword: STUDENT.password,
    });
    cookie = (await post('/login', STUDENT)).headers.get('set-cookie').split(';')[0];
  });
  after(() => new Promise((r) => server.close(r)));

  test('summaries reach the pages escaped', async () => {
    assert.equal(server.bank.about(server.bank.roots[0].id).summary, '<script>alert("x")</script>, sneaky');
    const root = server.bank.roots[0];
    const mcq = server.bank.items.find((i) => i.type === 'mcq' && i.id === i.rootId);
    for (const p of [`/bank/q/${root.id}`, `/bank/topic/${mcq.syllabus[0].subtopic.code}`, `/bank/try/${mcq.id}?picked=${mcq.correctOption}`]) {
      const body = await (await fetch(base + p, { headers: { cookie } })).text();
      assert.ok(!body.includes('<script>alert'), p);
      assert.ok(body.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;, sneaky'), p);
    }
  });
});
