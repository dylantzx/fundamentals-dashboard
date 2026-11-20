// End to end: answering bank questions over HTTP writes the answer log, and the
// dashboard's labels come from it (PRD 6.2 latest five), not from the old counts.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server.js';
import { createAnswerLog } from '../lib/answer-log.js';
import { views, buildDashboardModel, publicDir } from './helpers/app-parts.js';

const BANK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'question-bank');
const HAVE_BANK = fs.existsSync(path.join(BANK_DIR, 'export.json'));
const STUDENT = { username: 'mei', password: 'student-pass-456' };
const PARENT = { username: 'MumTan', password: 'parent-pass-123' };

describe('answer log drives the dashboard', { skip: !HAVE_BANK && 'no question-bank/export.json' }, () => {
  let server, base, dataDir, student, studentId;

  const req = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const post = (p, form, cookie) => req(p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(form).toString(),
  });
  const dashboard = async () => (await req('/dashboard', { headers: { cookie: student } })).text();
  /** Answers item i of a set right or wrong. */
  async function answer(base, items, i, right) {
    const item = items[i];
    const form = item.type === 'mcq'
      ? { i: String(i), choice: right ? item.correctOption : item.options.find((o) => o.label !== item.correctOption).label }
      : { i: String(i), self: right ? 'right' : 'wrong' };
    const res = await post(`${base}/answer`, form, student);
    assert.equal(res.status, 303);
  }

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-flow-'));
    server = createApp({ dataDir, scryptN: 16, views, buildDashboardModel, publicDir, bankDir: BANK_DIR, log: () => {} });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    await post('/setup', {
      parentUsername: PARENT.username, parentPassword: PARENT.password,
      studentUsername: STUDENT.username, studentPassword: STUDENT.password,
    });
    const res = await post('/login', STUDENT);
    student = res.headers.get('set-cookie').split(';')[0];
    studentId = server.store.findUserByUsername(STUDENT.username).id;
  });
  after(() => new Promise((r) => server.close(r)));

  test('answering a bank question adds a log entry with the contract shape', async () => {
    const items = server.bank.forTopic('t3');
    const t0 = Date.now();
    await answer('/practise/t3', items, 0, true);
    const rows = server.answers.list(studentId);
    assert.equal(rows.length, 1);
    const { at, ...rest } = rows[0];
    assert.deepEqual(rest, {
      id: 1, userId: studentId, topicId: 't3', questionId: items[0].id, correct: true, level: 'exam', pool: 'practice',
    });
    assert.ok(at >= t0 && at <= Date.now());
    // The file on disk is what another process (the parent page) would read.
    assert.equal(createAnswerLog(dataDir).list(studentId).length, 1);
    // The old counts are still kept.
    assert.deepEqual(server.store.getProgress(studentId).topics.t3, { right: 1, total: 1 });
  });

  test('quick-check answers are logged in the check pool', async () => {
    const items = server.bank.forTopic('t3'); // check 3 covers topic 3; both t3 items are MCQs
    await answer('/check/3', items, 0, true);
    const last = server.answers.list(studentId).at(-1);
    assert.deepEqual([last.topicId, last.pool, last.correct], ['t3', 'check', true]);
  });

  test('the dashboard label follows the latest five in the log, not the all-time counts', async () => {
    const items = server.bank.forTopic('t3');
    // Two answers in so far, both right: not rated yet.
    let body = await dashboard();
    assert.doesNotMatch(body, /id="next-title">Isotopes</);
    // One more right: three right of three, all Exam level -> Solid 3/3.
    await answer('/practise/t3', items, 1, true);
    body = await dashboard();
    assert.match(body, /chip--solid[^]*?3\/3/);
    // Then four wrong. Latest five: right, wrong x4 -> Shaky 1/5 and Next up.
    // (The all-time counts, 3 of 7, would also say Shaky; one more right shows the difference.)
    for (let k = 0; k < 4; k++) await answer('/practise/t3', items, k % 2, false);
    body = await dashboard();
    assert.match(body, /id="next-title">Isotopes</);
    assert.match(body, /chip--shaky[^]*?1\/5/);
    // Three more right. Latest five: wrong, wrong, right x3 -> Getting there 3/5.
    // The all-time counts (6 of 10 = 0.6) agree on the label but not the score.
    for (let k = 0; k < 3; k++) await answer('/practise/t3', items, k % 2, true);
    const model = buildDashboardModel({
      user: { username: STUDENT.username },
      progress: server.store.getProgress(studentId),
      answers: server.answers.list(studentId),
    });
    const t3 = model.topics.find((t) => t.id === 't3');
    assert.deepEqual([t3.label, t3.right, t3.total], ['getting', 3, 5]);
    assert.deepEqual(server.store.getProgress(studentId).topics.t3, { right: 6, total: 10 });
    body = await dashboard();
    assert.match(body, /score">3\/5</);
    assert.doesNotMatch(body, /score">6\/10</);
  });
});
