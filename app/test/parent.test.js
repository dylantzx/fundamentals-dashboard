// The parent page and the study sessions behind it, through the real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server.js';
import { views, buildDashboardModel, publicDir } from './helpers/app-parts.js';

const PARENT = { username: 'MumTan', password: 'parent-pass-123' };
const STUDENT = { username: 'mei', password: 'student-pass-456' };
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 20, 8, 0, 0);

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-parent-'));
  const clock = { t: T0 };
  const server = createApp({ dataDir, scryptN: 16, now: () => clock.t, views, buildDashboardModel, publicDir, bankDir: null, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const get = (p, cookie) => req(p, { headers: cookie ? { cookie } : {} });
  const post = (p, form, cookie) => req(p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form).toString(),
  });
  const loginRaw = (who) => post('/login', { username: who.username, password: who.password });
  async function login(who) {
    const res = await loginRaw(who);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    return res.headers.get('set-cookie').split(';')[0];
  }
  await post('/setup', {
    parentUsername: PARENT.username, parentPassword: PARENT.password,
    studentUsername: STUDENT.username, studentPassword: STUDENT.password,
  });
  const studentId = server.store.findUserByUsername(STUDENT.username).id;
  const studies = () => server.studySessions.list(studentId);
  const page = async (cookie) => (await get('/parent', cookie)).text();
  const close = () => new Promise((r) => server.close(r));
  return { server, dataDir, clock, get, post, login, loginRaw, studentId, studies, page, close };
}

const loc = (res) => res.headers.get('location');
/** One session's card from the page. */
function card(body, id) {
  const start = body.indexOf(`<article class="card session" id="s-${id}"`);
  assert.ok(start >= 0, `card for ${id}`);
  return body.slice(start, body.indexOf('</article>', start));
}
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const versionOf = (c) => /name="v" value="([^"]*)"/.exec(c)[1];

test('a study session starts at student login and ends at logout; parents get none', async () => {
  const app = await startApp();
  try {
    await app.login(PARENT);
    assert.equal(app.studies().length, 0);
    const c = await app.login(STUDENT);
    const [s] = app.studies();
    assert.equal(s.startedAt, new Date(T0).toISOString());
    assert.equal(s.endedAt, null);
    app.clock.t += 3 * MIN;
    await app.post('/logout', {}, c);
    const [ended] = app.studies();
    assert.equal(ended.endReason, 'logout');
    assert.equal(ended.endedAt, new Date(T0 + 3 * MIN).toISOString());
  } finally { await app.close(); }
});

test('idle: 20 minutes with no action ends it at the 20-minute mark', async () => {
  const app = await startApp();
  try {
    const c = await app.login(STUDENT);
    app.clock.t += 4 * MIN;
    await app.get('/dashboard', c);
    app.clock.t += 25 * MIN;
    const res = await app.get('/dashboard', c);
    assert.equal(loc(res), '/login?notice=idle');
    const [s] = app.studies();
    assert.equal(s.endReason, 'idle');
    assert.equal(s.endedAt, new Date(T0 + 24 * MIN).toISOString());
    assert.equal(s.lastActionAt, new Date(T0 + 4 * MIN).toISOString());
  } finally { await app.close(); }
});

test('idle without a later request: closed when the parent page is opened', async () => {
  const app = await startApp();
  try {
    await app.login(STUDENT);
    app.clock.t += 30 * MIN;
    const p = await app.login(PARENT);
    await app.page(p);
    assert.equal(app.studies()[0].endReason, 'idle');
  } finally { await app.close(); }
});

test('logging in again replaces the earlier session and its login', async () => {
  const app = await startApp();
  try {
    const first = await app.login(STUDENT);
    app.clock.t += MIN;
    const second = await app.login(STUDENT);
    const [newer, older] = app.studies();
    assert.equal(older.endReason, 'replaced');
    assert.equal(newer.endedAt, null);
    assert.equal(loc(await app.get('/dashboard', first)), '/login', 'old login no longer works');
    assert.equal((await app.get('/dashboard', second)).status, 200);
  } finally { await app.close(); }
});

test('time spent and the longest pause come from his requests (not the style sheet)', async () => {
  const app = await startApp();
  try {
    const c = await app.login(STUDENT);
    app.clock.t += 2 * MIN; await app.get('/dashboard', c);
    app.clock.t += 9 * MIN; await app.get('/dashboard', c);
    app.clock.t += 1 * MIN; await app.get('/dashboard', c);
    app.clock.t += 5 * MIN; await app.get('/public/styles.css', c);
    const [s] = app.studies();
    assert.equal(s.longestPauseMs, 9 * MIN);
    assert.equal(s.lastActionAt, new Date(T0 + 12 * MIN).toISOString());
    const p = await app.login(PARENT);
    const t = text(card(await app.page(p), s.id));
    assert.match(t, /Time spent 12 min/);
    assert.match(t, /Longest pause 9 min/);
  } finally { await app.close(); }
});

test('per-session counts and each topic’s label at the start and the end', async () => {
  const app = await startApp();
  try {
    const add = (topicId, correct, at, questionId = 'q') =>
      app.server.answers.add({ userId: app.studentId, topicId, questionId, correct, level: 'exam', pool: 'practice', at });
    // Session 1: three wrong on Isotopes.
    const c1 = await app.login(STUDENT);
    for (let i = 0; i < 3; i++) { app.clock.t += MIN; await app.get('/dashboard', c1); add('t3', false, app.clock.t); }
    await app.post('/logout', {}, c1);
    // Session 2: three right on Isotopes, one right and one wrong on Covalent bonding.
    app.clock.t += 60 * MIN;
    const c2 = await app.login(STUDENT);
    for (const [topic, ok] of [['t3', true], ['t3', true], ['t3', true], ['t5', true], ['t5', false]]) {
      app.clock.t += MIN; await app.get('/dashboard', c2); add(topic, ok, app.clock.t);
    }
    await app.post('/logout', {}, c2);
    // An answer outside both sessions counts for neither.
    add('t1', true, app.clock.t + 10 * MIN);

    const [s2, s1] = app.studies();
    const body = await app.page(await app.login(PARENT));
    assert.ok(body.indexOf(`id="s-${s2.id}"`) < body.indexOf(`id="s-${s1.id}"`), 'newest first');

    const one = text(card(body, s1.id));
    assert.match(one, /Questions answered 3/);
    assert.match(one, /Right first time 0 of 3/);
    assert.match(one, /Isotopes 3 \(0 right first time\) Not rated yet Shaky/);

    const two = card(body, s2.id);
    const t2 = text(two);
    assert.match(t2, /Questions answered 5/);
    assert.match(t2, /Right first time 4 of 5/);
    assert.match(t2, /Isotopes 3 \(3 right first time\) Shaky Getting there/);
    assert.match(t2, /Covalent bonding 2 \(1 right first time\) Not rated yet Not rated yet/);
    assert.ok(!t2.includes('Subatomic'), 'the answer after the session is not counted');
    assert.ok(two.indexOf('Isotopes') < two.indexOf('Covalent bonding'), 'topics in list order');
  } finally { await app.close(); }
});

test('the record form saves, can be changed later, and stale or invalid posts are ignored', async () => {
  const app = await startApp();
  try {
    await app.login(STUDENT);
    const p = await app.login(PARENT);
    const [s] = app.studies();
    let c = card(await app.page(p), s.id);
    assert.match(c, /value="not_recorded" checked/, 'starts at Not recorded');
    const v0 = versionOf(c);

    const res = await app.post(`/parent/sessions/${s.id}/record`, { v: v0, status: 'stayed', note: 'Asked me once.' }, p);
    assert.equal(res.status, 303);
    assert.equal(loc(res), `/parent?saved=${s.id}#s-${s.id}`);
    const savedPage = await (await app.get(loc(res), p)).text();
    c = card(savedPage, s.id);
    assert.match(c, /value="stayed" checked/);
    assert.match(c, /Asked me once\./);
    assert.match(c, /Saved\./);
    assert.match(text(savedPage), /1 of 1 recorded session marked Stayed/);

    // The old form (version v0) posted again: dropped.
    const stale = await app.post(`/parent/sessions/${s.id}/record`, { v: v0, status: 'went_to_video', note: 'old' }, p);
    assert.equal(loc(stale), `/parent?notice=stale#s-${s.id}`);
    assert.equal(app.server.studySessions.getRecord(s.id).status, 'stayed');
    assert.match(await (await app.get('/parent?notice=stale', p)).text(), /changed in another window/);

    // Changing it later with the current version works.
    const v1 = versionOf(c);
    await app.post(`/parent/sessions/${s.id}/record`, { v: v1, status: 'went_to_video', note: 'Opened a video.' }, p);
    assert.equal(app.server.studySessions.getRecord(s.id).status, 'went_to_video');

    const v2 = app.server.studySessions.getRecord(s.id).updatedAt;
    for (const [url, form] of [
      [`/parent/sessions/${s.id}/record`, { v: v2, status: 'maybe', note: '' }],
      [`/parent/sessions/${s.id}/record`, { v: v2, note: '' }],
      ['/parent/sessions/abc123/record', { v: '0', status: 'stayed' }],
    ]) {
      const r = await app.post(url, form, p);
      assert.equal(r.status, 303, url);
      assert.match(loc(r), /^\/parent\?notice=invalid/);
    }
    assert.equal(app.server.studySessions.getRecord(s.id).note, 'Opened a video.');
  } finally { await app.close(); }
});

test('the test summary counts Stayed out of the recorded sessions against 2 of 3', async () => {
  const app = await startApp();
  try {
    for (let i = 0; i < 3; i++) { await app.login(STUDENT); app.clock.t += MIN; }
    const p = await app.login(PARENT);
    const ids = app.studies().map((s) => s.id);
    const set = (id, status) => app.post(`/parent/sessions/${id}/record`, { v: app.server.studySessions.getRecord(id).updatedAt || '0', status, note: '' }, p);
    assert.match(text(await app.page(p)), /0 of 0 recorded sessions marked Stayed Nothing recorded yet/);
    await set(ids[0], 'stayed');
    await set(ids[1], 'went_to_video');
    let t = text(await app.page(p));
    assert.match(t, /1 of 2 recorded sessions marked Stayed 1 more Stayed session needed/);
    assert.match(t, /at least 2 of 3 sessions/);
    await set(ids[2], 'stayed');
    t = text(await app.page(p));
    assert.match(t, /2 of 3 recorded sessions marked Stayed Target met/);
  } finally { await app.close(); }
});

test('the note is capped at 1000 characters and escaped', async () => {
  const app = await startApp();
  try {
    await app.login(STUDENT);
    const p = await app.login(PARENT);
    const [s] = app.studies();
    const evil = '<script>alert(1)</script>';
    await app.post(`/parent/sessions/${s.id}/record`, { v: '0', status: 'stayed', note: evil + 'x'.repeat(1500) }, p);
    const note = app.server.studySessions.getRecord(s.id).note;
    assert.equal(note.length, 1000);
    const body = await app.page(p);
    assert.ok(!body.includes(evil));
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.match(body, /maxlength="1000"/);
  } finally { await app.close(); }
});

test('a student cannot reach or post to any /parent address; anonymous users go to login', async () => {
  const app = await startApp();
  try {
    const st = await app.login(STUDENT);
    const [s] = app.studies();
    for (const p of ['/parent', '/parent/', '/parent/sessions', `/parent/sessions/${s.id}/record`, '/parent/student/password']) {
      const r = await app.get(p, st);
      assert.equal(r.status, 303, p);
      assert.equal(loc(r), '/dashboard', p);
      assert.equal(loc(await app.get(p)), '/login', `anonymous ${p}`);
    }
    const r1 = await app.post(`/parent/sessions/${s.id}/record`, { v: '0', status: 'went_to_video', note: 'x' }, st);
    assert.equal(loc(r1), '/dashboard');
    assert.equal(app.server.studySessions.getRecord(s.id).status, 'not_recorded');
    const r2 = await app.post('/parent/student/password', { password: 'hijacked-123', confirm: 'hijacked-123' }, st);
    assert.equal(loc(r2), '/dashboard');
    assert.equal((await app.loginRaw({ ...STUDENT, password: 'hijacked-123' })).status, 401);
    const dash = await (await app.get('/dashboard', await app.login(STUDENT))).text();
    assert.ok(!/Stayed|Went to video|video/i.test(dash), 'nothing on his page mentions the record');
  } finally { await app.close(); }
});

test('password reset: validated with field errors, never echoed, then works for login', async () => {
  const app = await startApp();
  try {
    const p = await app.login(PARENT);
    const short = await app.post('/parent/student/password', { password: 'abc1234', confirm: 'abc1234' }, p);
    assert.equal(short.status, 400);
    const sb = await short.text();
    assert.match(sb, /Use at least 8 characters\./);
    assert.match(sb, /id="pw-password"[^>]*aria-invalid="true"/);
    assert.ok(!sb.includes('abc1234'), 'never echoed');
    assert.match(sb, /<details class="pw-reset" open>/);

    const diff = await app.post('/parent/student/password', { password: 'new-secret-99', confirm: 'new-secret-98' }, p);
    assert.equal(diff.status, 400);
    const db = await diff.text();
    assert.match(db, /The two passwords are different/);
    assert.ok(!db.includes('new-secret-9'));

    assert.equal((await app.loginRaw(STUDENT)).status, 303, 'old password still works after failed attempts');
    const ok = await app.post('/parent/student/password', { password: 'new-secret-99', confirm: 'new-secret-99' }, p);
    assert.equal(ok.status, 303);
    assert.equal(loc(ok), '/parent?notice=password-changed#student');
    assert.match(await (await app.get('/parent?notice=password-changed', p)).text(), /Password changed/);
    assert.equal((await app.loginRaw(STUDENT)).status, 401, 'old password no longer works');
    await app.login({ ...STUDENT, password: 'new-secret-99' });
    await app.login(PARENT); // the parent's own password is untouched
    const raw = fs.readFileSync(path.join(app.dataDir, 'db.json'), 'utf8');
    assert.ok(!raw.includes('new-secret-99'), 'only the hash is stored');
    assert.equal(fs.statSync(path.join(app.dataDir, 'db.json')).mode & 0o777, 0o600);
  } finally { await app.close(); }
});

test('the parent page never shows his actual answers', async () => {
  const app = await startApp();
  try {
    const c = await app.login(STUDENT);
    app.clock.t += MIN;
    await app.get('/dashboard', c);
    for (const correct of [true, false, true]) {
      app.server.answers.add({ userId: app.studentId, topicId: 't2', questionId: 'Q-SECRET-41', correct, level: 'exam', pool: 'practice', at: app.clock.t });
    }
    const body = await app.page(await app.login(PARENT));
    assert.match(text(body), /Electron arrangement 3 \(2 right first time\)/, 'topics and scores are shown');
    assert.ok(!body.includes('Q-SECRET-41'), 'no question ids');
    assert.ok(!/Your answer|You answered|picked|chose/i.test(body), 'no answer content');
    assert.match(text(body), /not the actual answers/);
  } finally { await app.close(); }
});
