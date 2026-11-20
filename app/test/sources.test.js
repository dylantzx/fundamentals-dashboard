// Study sources (content/sources.json), topic summaries (content/summaries.json),
// the topic illustrations, the /learn/:topicId page and the dashboard's "Study notes" links.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server.js';
import { views, buildDashboardModel, publicDir } from './helpers/app-parts.js';
import { validateSources, parseSources, loadSources, isSafeUrl, SOURCE_TYPES, SourcesError } from '../lib/sources.js';
import { validateSummaries, loadSummaries, SummariesError } from '../lib/summaries.js';
import { ILLUSTRATIONS, ILLUSTRATION_IDS, renderIllustration } from '../views/illustrations/index.js';
import { renderLearn } from '../views/learn.js';
import { TOPICS } from '../lib/ratings.js';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES_FILE = path.join(APP, 'content', 'sources.json');
const SUMMARIES_FILE = path.join(APP, 'content', 'summaries.json');
const realSources = () => JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
const realSummaries = () => JSON.parse(fs.readFileSync(SUMMARIES_FILE, 'utf8'));

const EVIL = '<img src=x onerror=1>';
const EVIL_ESCAPED = '&lt;img src=x onerror=1&gt;';

const src = (over = {}) => ({
  title: 'A page', publisher: 'Someone', url: 'https://example.org/notes', type: 'notes',
  why: 'It helps.', checkedOn: '2026-11-20', ...over,
});
const goodFile = () => ({
  checkedOn: '2026-11-20',
  topics: Object.fromEntries(TOPICS.map((t) => [t.id, [src(), src({ type: 'syllabus', url: 'https://example.org/syllabus.pdf#page=3' })]])),
});

// ---- the sources validator ---------------------------------------------------

describe('sources validator', () => {
  test('a good file passes', () => {
    assert.deepEqual(validateSources(goodFile()), []);
    const parsed = parseSources(goodFile());
    assert.equal(parsed.topics.t1.length, 2);
    assert.ok(Object.isFrozen(parsed.topics.t1[0]));
  });

  test('a bad URL fails', () => {
    for (const url of ['http://example.org/x', 'javascript:alert(1)', '//example.org/x', '/learn/t1',
      'https://user:pw@example.org/', 'https://exa mple.org/', 'data:text/html,hi', 'ftp://example.org/']) {
      const f = goodFile();
      f.topics.t2[0].url = url;
      assert.match(validateSources(f).join('\n'), /t2 source 1 has a bad url/, url);
    }
  });

  test('an unknown topic fails', () => {
    const f = goodFile();
    f.topics.t9 = [src(), src()];
    assert.match(validateSources(f).join('\n'), /unknown topic id "t9"/);
    const g = goodFile();
    delete g.topics.t4;
    assert.match(validateSources(g).join('\n'), /topic t4 has no list/);
  });

  test('a bad type fails, and videos are not allowed', () => {
    assert.deepEqual(SOURCE_TYPES, ['notes', 'syllabus', 'interactive']);
    for (const type of ['video', 'blog', 'NOTES']) {
      const f = goodFile();
      f.topics.t3[1].type = type;
      assert.match(validateSources(f).join('\n'), new RegExp(`t3 source 2 has type "${type}"`));
    }
  });

  test('a missing field fails', () => {
    for (const field of ['title', 'publisher', 'url', 'type', 'why', 'checkedOn']) {
      const f = goodFile();
      delete f.topics.t5[0][field];
      assert.match(validateSources(f).join('\n'), new RegExp(`t5 source 1 is missing "${field}"`), field);
      const g = goodFile();
      g.topics.t5[0][field] = '   ';
      assert.match(validateSources(g).join('\n'), new RegExp(`missing "${field}"`), `${field} blank`);
    }
  });

  test('too few or too many sources fail', () => {
    const f = goodFile();
    f.topics.t1 = [src()];
    assert.match(validateSources(f).join('\n'), /t1 has 1 sources; it needs 2 to 4/);
    const g = goodFile();
    g.topics.t1 = [src(), src(), src(), src(), src()];
    assert.match(validateSources(g).join('\n'), /t1 has 5 sources/);
  });

  test('loadSources throws a plain SourcesError for missing, non-JSON and invalid files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-src-'));
    assert.throws(() => loadSources(path.join(dir, 'nope.json')), (e) => e instanceof SourcesError && /could not be read/.test(e.message));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    assert.throws(() => loadSources(path.join(dir, 'bad.json')), (e) => e instanceof SourcesError && /not valid JSON/.test(e.message));
    const f = goodFile();
    f.topics.t1[0].url = 'http://insecure.example/';
    fs.writeFileSync(path.join(dir, 'insecure.json'), JSON.stringify(f));
    assert.throws(() => loadSources(path.join(dir, 'insecure.json')), (e) =>
      e instanceof SourcesError && e.message.startsWith("Steady can't start:") && /bad url/.test(e.message));
  });

  test('isSafeUrl only accepts https', () => {
    assert.equal(isSafeUrl('https://www.bbc.co.uk/bitesize/guides/z3sg2nb/revision/3'), true);
    assert.equal(isSafeUrl('http://www.bbc.co.uk/'), false);
    assert.equal(isSafeUrl(42), false);
  });
});

// ---- the real sources.json ----------------------------------------------------

describe('the real content/sources.json', () => {
  test('passes the validator', () => {
    assert.deepEqual(validateSources(realSources()), []);
    assert.doesNotThrow(() => loadSources(SOURCES_FILE));
  });

  test('every topic has 2 to 4 sources and no videos', () => {
    const { topics } = loadSources(SOURCES_FILE);
    for (const t of TOPICS) {
      const list = topics[t.id];
      assert.ok(list.length >= 2 && list.length <= 4, `${t.id} has ${list.length}`);
      assert.equal(list.filter((s) => s.type === 'video').length, 0, `${t.id} has a video`);
      assert.ok(list.some((s) => s.type === 'notes'), `${t.id} has notes`);
      for (const s of list) {
        assert.ok(!/youtube|youtu\.be|vimeo/i.test(s.url), `${t.id}: ${s.url}`);
        assert.ok(isSafeUrl(s.url));
      }
    }
  });
});

// ---- the summaries and illustrations -------------------------------------------

describe('content/summaries.json', () => {
  test('validates: all 6 topics with every section, and only known illustrations', () => {
    assert.deepEqual(validateSummaries(realSummaries(), { illustrationIds: ILLUSTRATION_IDS }), []);
    const sums = loadSummaries(SUMMARIES_FILE, { illustrationIds: ILLUSTRATION_IDS });
    for (const t of TOPICS) {
      const s = sums[t.id];
      assert.ok(s.bigIdea, `${t.id} big idea`);
      assert.ok(s.keyPoints.length >= 3 && s.keyPoints.length <= 5, `${t.id} key points`);
      assert.ok(s.example.question && s.example.steps.length && s.example.answer, `${t.id} example`);
      assert.ok(s.mistake.wrong && s.mistake.right, `${t.id} mistake`);
      assert.ok(s.illustrations.length >= 1 && s.illustrations.length <= 2, `${t.id} illustrations`);
    }
  });

  test('a missing section, a missing topic or an unknown illustration fails', () => {
    const a = realSummaries();
    delete a.topics.t3.mistake;
    assert.match(validateSummaries(a).join('\n'), /t3 "mistake"/);
    const b = realSummaries();
    delete b.topics.t6;
    assert.match(validateSummaries(b).join('\n'), /topic t6 has no summary/);
    const c = realSummaries();
    c.topics.t2.illustrations = ['not-a-drawing'];
    assert.match(validateSummaries(c, { illustrationIds: ILLUSTRATION_IDS }).join('\n'), /unknown illustration "not-a-drawing"/);
    const d = realSummaries();
    d.topics.t1.keyPoints = ['only one'];
    assert.match(validateSummaries(d).join('\n'), /t1 "keyPoints"/);
    const e = realSummaries();
    e.topics.t5.example.steps = [];
    assert.match(validateSummaries(e).join('\n'), /t5 "example"/);
  });

  test('loadSummaries throws a plain SummariesError on a broken file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-sum-'));
    fs.writeFileSync(path.join(dir, 'bad.json'), '[1,2');
    assert.throws(() => loadSummaries(path.join(dir, 'bad.json')), (e) =>
      e instanceof SummariesError && e.message.startsWith("Steady can't start:"));
  });

  test('no video links or embeds slip into the summaries', () => {
    assert.ok(!/youtube|youtu\.be|<iframe|https?:/i.test(fs.readFileSync(SUMMARIES_FILE, 'utf8')));
  });
});

describe('illustrations', () => {
  test('every illustration renders with <title> and <desc> and nothing outside', () => {
    assert.ok(ILLUSTRATION_IDS.length >= 6);
    for (const id of ILLUSTRATION_IDS) {
      const out = renderIllustration(id);
      assert.match(out, /^<svg class="ill" viewBox="0 0 \d+ \d+" role="img" aria-labelledby="ill-[a-z0-9-]+-t ill-[a-z0-9-]+-d"/, id);
      assert.match(out, new RegExp(`<title id="ill-${id}-t">[^<]{10,}</title>`), `${id} title`);
      assert.match(out, new RegExp(`<desc id="ill-${id}-d">[^<]{40,}</desc>`), `${id} desc`);
      assert.ok(out.endsWith('</svg>'), id);
      assert.ok(!/<script|<foreignObject|<image|<use|<iframe|\son[a-z]+=|href=|url\(|@import/i.test(out), `${id} has an outside reference or script`);
      // the only URL allowed is the SVG namespace itself
      assert.deepEqual([...out.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]), ['http://www.w3.org/2000/svg'], id);
      assert.ok(!/NaN|undefined/.test(out), `${id} has a broken number`);
    }
  });

  test('every summary names drawings that exist, and unknown names render nothing', () => {
    for (const t of Object.values(realSummaries().topics)) for (const ill of t.illustrations) assert.ok(Object.hasOwn(ILLUSTRATIONS, ill), ill);
    assert.equal(renderIllustration('nope'), '');
    assert.equal(renderIllustration('__proto__'), '');
  });

  test('the dot-and-cross drawings balance', () => {
    const count = (s, re) => (s.match(re) || []).length;
    const DOT = /class="ill-dot"/g, CROSS = /class="ill-cross"/g;
    // NaCl: Na atom 1 cross; Cl atom 7 dots; Na⁺ 8 crosses; Cl⁻ 7 dots + 1 cross. Key adds 1 of each.
    const ionic = renderIllustration('ionic-nacl');
    assert.equal(count(ionic, CROSS), 1 + 8 + 1 + 1);
    assert.equal(count(ionic, DOT), 7 + 7 + 1);
    // H₂: one shared pair (1 dot + 1 cross), plus the key.
    const h2 = renderIllustration('covalent-h2');
    assert.equal(count(h2, DOT), 1 + 1);
    assert.equal(count(h2, CROSS), 1 + 1);
    // H₂O: oxygen's 6 outer electrons as dots (2 in bonds + 2 lone pairs), 2 hydrogen crosses, plus the key.
    const h2o = renderIllustration('covalent-h2o');
    assert.equal(count(h2o, DOT), 6 + 1);
    assert.equal(count(h2o, CROSS), 2 + 1);
    // Shells: sodium 2.8.1 + chlorine 2.8.7 = 11 + 17 electrons.
    assert.equal(count(renderIllustration('shells-na-cl'), DOT), 28);
    // Lithium-7: 3 protons, 4 neutrons and 3 electrons, plus one of each in the key.
    const li = renderIllustration('atom-lithium');
    assert.equal(count(li, /class="ill-p"/g), 3 + 1);
    assert.equal(count(li, /class="ill-n"/g), 4 + 1);
    assert.equal(count(li, /class="ill-e"/g), 3 + 1);
  });
});

// ---- the /learn view ---------------------------------------------------------------

describe('renderLearn', () => {
  const sums = loadSummaries(SUMMARIES_FILE, { illustrationIds: ILLUSTRATION_IDS });
  const sources = loadSources(SOURCES_FILE);
  const base = (over = {}) => ({
    user: { username: 'jun_wei' }, topic: TOPICS[2], summary: sums.t3, sources: sources.topics.t3, practiseHref: '/practise/t3', ...over,
  });

  test('summary first, then "Want to read more?", then the way back to practising', () => {
    const out = renderLearn(base());
    assert.match(out, /<h1 class="t-h1">Understand: Isotopes<\/h1>/);
    const order = ['The big idea', '<svg class="ill"', 'Key points', 'Worked example', 'Common mistake',
      'Want to read more?', 'Prefer to read it explained another way? These are free and match what your syllabus asks.',
      'Steady works offline; these links need the internet.', 'Back to practising'];
    let at = -1;
    for (const s of order) {
      const i = out.indexOf(s);
      assert.ok(i > at, `"${s}" in order`);
      at = i;
    }
    assert.match(out, /<a class="btn btn-primary btn-lg" href="\/practise\/t3">Back to practising/);
  });

  test('notes come before syllabus and interactive pages', () => {
    const out = renderLearn(base());
    const notes = out.indexOf('Calculating relative atomic mass');
    const sim = out.indexOf('Isotopes and Atomic Mass');
    const syl = out.indexOf('6092 syllabus');
    assert.ok(notes > 0 && sim > notes && syl > notes);
  });

  test('every outside link opens in a new tab safely and says so to screen readers', () => {
    const out = renderLearn(base());
    const links = [...out.matchAll(/<a class="source-title" href="([^"]+)"([^>]*)>/g)];
    assert.equal(links.length, sources.topics.t3.length);
    for (const [, href, attrs] of links) {
      assert.ok(href.startsWith('https://'), href);
      assert.match(attrs, /target="_blank"/);
      assert.match(attrs, /rel="noopener noreferrer"/);
    }
    assert.equal(out.split('<span class="sr-only"> (opens another website)</span>').length - 1, links.length);
    assert.ok(!/<iframe|<img[^>]+https?:|<video|<embed|<object/i.test(out), 'nothing embedded');
  });

  test('escapes every text and blocks unsafe URLs', () => {
    const evilSource = { title: EVIL, publisher: EVIL, url: 'javascript:alert(1)', type: 'notes', why: EVIL, checkedOn: '2026-11-20', caution: EVIL };
    const evilSummary = {
      bigIdea: EVIL, keyPoints: [EVIL, 'b', 'c'], example: { question: EVIL, steps: [EVIL], answer: EVIL },
      mistake: { wrong: EVIL, right: EVIL }, illustrations: ['nope'],
    };
    const out = renderLearn(base({ topic: { id: 't1', n: 1, name: EVIL }, summary: evilSummary, sources: [evilSource], user: { username: EVIL }, practiseHref: '//evil.example' }));
    assert.ok(!out.includes(EVIL));
    assert.ok(out.includes(EVIL_ESCAPED));
    assert.ok(!out.includes('javascript:'));
    assert.match(out, /<a class="source-title" href="#"/);
    assert.match(out, /<a class="btn btn-primary btn-lg" href="#">Back to practising/);
  });
});

// ---- the server: /learn/:topicId and the dashboard links ----------------------------------

describe('GET /learn/:topicId', () => {
  const PARENT = { username: 'MumTan', password: 'parent-pass-123' };
  const STUDENT = { username: 'mei', password: 'student-pass-456' };
  let server, base, studentCookie, parentCookie;

  const req = (p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const post = (p, form) => fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const login = async (who) => (await post('/login', who)).headers.get('set-cookie').split(';')[0];

  before(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-learn-'));
    server = createApp({ dataDir, scryptN: 16, views, buildDashboardModel, publicDir, bankDir: null, log: () => {} });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await post('/setup', {
      parentUsername: PARENT.username, parentPassword: PARENT.password,
      studentUsername: STUDENT.username, studentPassword: STUDENT.password,
    });
    studentCookie = await login(STUDENT);
    parentCookie = await login(PARENT);
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  test('renders for a student, for every topic, with a strict CSP', async () => {
    for (const t of TOPICS) {
      const res = await req(`/learn/${t.id}`, studentCookie);
      assert.equal(res.status, 200, t.id);
      const body = await res.text();
      assert.ok(body.includes(`Understand: ${t.name}`), t.id);
      assert.ok(body.indexOf('The big idea') < body.indexOf('Want to read more?'), `${t.id}: summary before links`);
      assert.ok(body.includes(`<a class="btn btn-primary btn-lg" href="/practise/${t.id}">Back to practising`), t.id);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /img-src 'self' data:/);
      assert.ok(!/frame-src|child-src|https?:/.test(csp), 'CSP allows nothing outside');
    }
  });

  test('redirects a parent home and anonymous visitors to log in', async () => {
    const asParent = await req('/learn/t1', parentCookie);
    assert.equal(asParent.status, 303);
    assert.equal(asParent.headers.get('location'), '/parent');
    const anon = await req('/learn/t1');
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/login');
  });

  test('an unknown topic is a 404', async () => {
    assert.equal((await req('/learn/t9', studentCookie)).status, 404);
    assert.equal((await req('/learn/__proto__', studentCookie)).status, 404);
  });

  test('the dashboard tiles link to /learn/tN, next to Practise', async () => {
    const body = await (await req('/dashboard', studentCookie)).text();
    for (const t of TOPICS) {
      assert.ok(body.includes(`<a class="study-link" href="/learn/${t.id}">Study notes<span class="sr-only">: ${t.name}</span></a>`), t.id);
    }
    assert.equal(body.split('<span class="topic-go">Practise').length - 1, 6);
    assert.ok(!/<a class="topic[^"]*"[^>]*>(?:(?!<\/a>)[\s\S])*<a /.test(body), 'no link nested inside a tile link');
  });

  test('a broken sources or summaries file stops the app with a plain message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-broken-'));
    const bad = realSources();
    bad.topics.t2[0].type = 'video';
    fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(bad));
    assert.throws(() => createApp({ dataDir: dir, bankDir: null, sourcesFile: path.join(dir, 'sources.json'), log: () => {} }),
      (e) => e.name === 'SourcesError' && /t2 source 1 has type "video"/.test(e.message));
    fs.writeFileSync(path.join(dir, 'summaries.json'), '{}');
    assert.throws(() => createApp({ dataDir: dir, bankDir: null, summariesFile: path.join(dir, 'summaries.json'), log: () => {} }),
      (e) => e.name === 'SummariesError');
  });
});
