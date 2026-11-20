// lib/study-sessions.js: study sessions and the parent's records, on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStudySessions, cleanNote, NOTE_MAX } from '../lib/study-sessions.js';

const MIN = 60 * 1000;
const T0 = 1_700_000_000_000;

function make() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-study-'));
  const clock = { t: T0 };
  const ss = createStudySessions(dataDir, { now: () => clock.t });
  return { dataDir, clock, ss };
}

test('start records the login time; actions move lastActionAt and the longest pause', () => {
  const { clock, ss } = make();
  const s = ss.start('u1');
  assert.equal(s.startedAt, new Date(T0).toISOString());
  assert.equal(s.lastActionAt, s.startedAt);
  assert.equal(s.longestPauseMs, 0);
  assert.equal(s.endedAt, null);
  clock.t += 2 * MIN; ss.action(s.id);
  clock.t += 7 * MIN; ss.action(s.id);
  clock.t += 1 * MIN; ss.action(s.id);
  const after = ss.get(s.id);
  assert.equal(after.longestPauseMs, 7 * MIN);
  assert.equal(after.lastActionAt, new Date(T0 + 10 * MIN).toISOString());
});

test('end: logout now, idle at the 20-minute mark; ended sessions ignore actions', () => {
  const { clock, ss } = make();
  const a = ss.start('u1');
  clock.t += 5 * MIN;
  assert.equal(ss.end(a.id, 'logout'), true);
  assert.equal(ss.get(a.id).endReason, 'logout');
  assert.equal(ss.get(a.id).endedAt, new Date(T0 + 5 * MIN).toISOString());
  assert.equal(ss.end(a.id, 'idle'), false, 'already ended');
  assert.equal(ss.action(a.id), null);

  const b = ss.start('u1');
  clock.t += 45 * MIN;
  ss.end(b.id, 'idle');
  assert.equal(ss.get(b.id).endReason, 'idle');
  assert.equal(ss.get(b.id).endedAt, new Date(T0 + 5 * MIN + 20 * MIN).toISOString());
});

test('a new login replaces the open one and closes stale ones as idle', () => {
  const { clock, ss } = make();
  const other = ss.start('u2');
  clock.t += 30 * MIN;
  const a = ss.start('u1');
  clock.t += 1 * MIN;
  const b = ss.start('u1');
  assert.equal(ss.get(a.id).endReason, 'replaced');
  assert.equal(ss.get(other.id).endReason, 'idle', 'stale session of another account closed on login');
  assert.equal(ss.get(b.id).endedAt, null);
  assert.deepEqual(ss.list('u1').map((s) => s.id), [b.id, a.id], 'newest first');
});

test('closeStale and closeAllOpen (restart)', () => {
  const { clock, ss } = make();
  const a = ss.start('u1');
  clock.t += 10 * MIN;
  assert.equal(ss.closeStale(), 0);
  clock.t += 11 * MIN;
  assert.equal(ss.closeStale(), 1);
  assert.equal(ss.get(a.id).endReason, 'idle');
  const b = ss.start('u1');
  clock.t += 3 * MIN;
  assert.equal(ss.closeAllOpen(), 1);
  assert.equal(ss.get(b.id).endedAt, new Date(clock.t).toISOString(), 'ends now when under 20 minutes');
});

test('persisted atomically to study-sessions.json (0600) and reloaded', () => {
  const { dataDir, clock, ss } = make();
  const s = ss.start('u1');
  ss.setRecord(s.id, { status: 'stayed', note: 'fine' });
  const file = path.join(dataDir, 'study-sessions.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), []);
  const again = createStudySessions(dataDir, { now: () => clock.t });
  assert.equal(again.get(s.id).startedAt, s.startedAt);
  assert.equal(again.getRecord(s.id).status, 'stayed');
});

test('parent records: default Not recorded, statuses checked, updatedAt always moves on', () => {
  const { ss } = make();
  const s = ss.start('u1');
  assert.deepEqual(ss.getRecord(s.id), { status: 'not_recorded', note: '', updatedAt: '' });
  const r1 = ss.setRecord(s.id, { status: 'stayed', note: 'a' });
  const r2 = ss.setRecord(s.id, { status: 'went_to_video', note: 'b' }); // same clock tick
  assert.ok(r2.updatedAt > r1.updatedAt);
  assert.throws(() => ss.setRecord(s.id, { status: 'maybe' }));
  assert.throws(() => ss.setRecord('nope', { status: 'stayed' }));
  assert.equal(ss.getRecord('__proto__').status, 'not_recorded');
});

test('notes: CRLF becomes LF and they are capped at 1000 characters', () => {
  assert.equal(cleanNote('a\r\nb'), 'a\nb');
  assert.equal(cleanNote('x'.repeat(1500)).length, NOTE_MAX);
  const emoji = 'x'.repeat(999) + '😀';
  assert.equal(cleanNote(emoji), 'x'.repeat(999), 'no half emoji left behind');
});
