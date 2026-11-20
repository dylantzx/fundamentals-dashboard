// Practice, quick checks and the bank browser, run against the real question bank
// in ../question-bank (skipped if it isn't there).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server.js';
import { loadQuestionBank } from '../lib/question-bank.js';
import { views, buildDashboardModel, publicDir } from './helpers/app-parts.js';

const BANK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'question-bank');
const HAVE_BANK = fs.existsSync(path.join(BANK_DIR, 'export.json'));
const STUDENT = { username: 'mei', password: 'student-pass-456' };
const PARENT = { username: 'MumTan', password: 'parent-pass-123' };

describe('question bank', { skip: !HAVE_BANK && 'no question-bank/export.json' }, () => {
  const bank = HAVE_BANK ? loadQuestionBank(BANK_DIR) : null;

  test('every Steady topic has real questions', () => {
    for (const t of ['t1', 't2', 't3', 't4', 't5', 't6']) assert.ok(bank.forTopic(t).length >= 1, t);
    assert.ok(bank.forTopic('t3').every((i) => /isotop|relative atomic mass/i.test(i.searchText)));
  });

  test('needs_review questions are never served', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(BANK_DIR, 'export.json'), 'utf8'));
    const flagged = raw.questions.filter((q) => q.tree_review_status !== 'ok').map((q) => q.id);
    assert.ok(flagged.length > 0);
    for (const id of flagged) {
      assert.equal(bank.root(id), null);
      assert.ok(!bank.items.some((i) => i.rootId === id));
    }
  });

  test('a part carries its ancestors\' stems and figures', () => {
    const part = bank.items.find((i) => i.paper === 'P2' && i.label === '1(a)(iv)');
    assert.ok(part);
    assert.equal(part.context.length, 2);
    assert.ok(part.context.every((c) => typeof c === 'string'));
    assert.ok(part.parentFigures.some((f) => f.caption === 'Fig. 1.1'));
  });
});

describe('practice pages', { skip: !HAVE_BANK && 'no question-bank/export.json' }, () => {
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
  const progress = () => server.store.getProgress(server.store.findUserByUsername(STUDENT.username).id);

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-practice-'));
    server = createApp({ dataDir, scryptN: 16, views, buildDashboardModel, publicDir, bankDir: BANK_DIR, log: () => {} });
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

  test('practice shows a real exam question with its source', async () => {
    const res = await get('/practise/t3', student);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /isotopes of relative isotopic masses x and x\+2/);
    assert.match(body, /Montfort Secondary School/);
    assert.match(body, /Paper 1 \(6092\/01\) · Question 4/);
    assert.match(body, /src="\/bank\/assets\/[0-9a-f]{2}\/[0-9a-f]{64}\.png"/);
  });

  test('answering an MCQ records it and shows the right answer', async () => {
    const item = server.bank.forTopic('t3')[0];
    const wrong = item.options.find((o) => o.label !== item.correctOption).label;
    let res = await post('/practise/t3/answer', { i: '0', choice: wrong }, student);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/practise/t3?i=0&picked=${wrong}`);
    let body = await (await get(res.headers.get('location'), student)).text();
    assert.match(body, new RegExp(`The answer is ${item.correctOption}`));
    assert.deepEqual(progress().topics.t3, { right: 0, total: 1 });

    res = await post('/practise/t3/answer', { i: '0', choice: item.correctOption }, student);
    body = await (await get(res.headers.get('location'), student)).text();
    assert.match(body, /Right\./);
    assert.deepEqual(progress().topics.t3, { right: 1, total: 2 });
  });

  test('structured parts are self-marked after the mark scheme', async () => {
    const items = server.bank.forTopic('t4');
    const i = items.findIndex((x) => x.type === 'structured');
    const body = await (await get(`/practise/t4?i=${i}`, student)).text();
    assert.match(body, /Show the mark scheme/);
    assert.match(body, /Fig\. 1\.1 shows the structures/);
    const res = await post('/practise/t4/answer', { i: String(i), self: 'right' }, student);
    assert.equal(res.status, 303);
    assert.deepEqual(progress().topics.t4, { right: 1, total: 1 });
  });

  test('bad answers are ignored', async () => {
    const before = progress();
    assert.equal((await post('/practise/t3/answer', { i: '0', choice: 'Z' }, student)).headers.get('location'), '/practise/t3?i=0');
    assert.equal((await post('/practise/t3/answer', { i: '99', choice: 'A' }, student)).headers.get('location'), '/practise/t3');
    assert.equal((await get('/practise/t3?i=99', student)).headers.get('location'), '/practise/t3');
    assert.deepEqual(progress(), before);
  });

  test('finishing check 1 counts as a check done', async () => {
    const n = server.bank.forTopic('t1').length;
    assert.equal(progress().checksDone, 0);
    for (let i = 0; i < Math.min(n, 3); i++) {
      const item = server.bank.forTopic('t1')[i];
      const form = item.type === 'mcq' ? { i: String(i), choice: item.correctOption } : { i: String(i), self: 'right' };
      await post('/check/1/answer', form, student);
    }
    assert.equal(progress().checksDone, 1);
    const done = await (await get('/check/1?done=1', student)).text();
    assert.match(done, /Check 1 done/);
  });

  test('parents are sent home from practice', async () => {
    assert.equal((await get('/practise/t1', parent)).headers.get('location'), '/parent');
  });

  test('bank pages and images need a login', async () => {
    const item = server.bank.forTopic('t3')[0];
    const img = `/bank/assets/${item.ownFigures[0].path}`;
    assert.equal((await get('/bank')).headers.get('location'), '/login');
    assert.equal((await get(img)).headers.get('location'), '/login');
    const res = await get(img, student);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal((await get('/bank/assets/..%2fexport.json', student)).status, 404);
  });

  test('bank index lists reviewed questions only; a question page shows every part', async () => {
    const index = await (await get('/bank', parent)).text();
    assert.match(index, /Paper 1 \(6092\/01\)/);
    const raw = JSON.parse(fs.readFileSync(path.join(BANK_DIR, 'export.json'), 'utf8'));
    for (const q of raw.questions.filter((x) => x.tree_review_status !== 'ok')) assert.ok(!index.includes(`/bank/q/${q.id}`), q.label);
    assert.equal((await get(`/bank/q/${raw.questions.find((x) => x.tree_review_status !== 'ok').id}`, student)).status, 404);
    const p2q1 = server.bank.roots.find((r) => r.paper === 'P2' && r.label === '1');
    const page = await (await get(`/bank/q/${p2q1.id}`, student)).text();
    assert.match(page, /1\(a\)\(iii\)/);
    assert.match(page, /Mark scheme/);
    assert.equal((await get('/bank/q/q_nope', student)).status, 404);
  });
});
