import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnswerLog } from '../lib/answer-log.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'steady-answers-'));
const row = (over = {}) => ({
  userId: 'u1', topicId: 't3', questionId: 'q-1', correct: true, level: 'exam', pool: 'practice', at: 1000, ...over,
});

test('add appends rows with increasing ids; list returns one user\'s rows, oldest first', () => {
  const log = createAnswerLog(tmpDir());
  assert.deepEqual(log.list('u1'), []);
  const a = log.add(row());
  const b = log.add(row({ userId: 'u2', correct: false }));
  const c = log.add(row({ questionId: 'q-2', pool: 'check', level: 'core', at: 2000 }));
  assert.deepEqual([a.id, b.id, c.id], [1, 2, 3]);
  assert.deepEqual(a, { id: 1, ...row() });
  assert.deepEqual(log.list('u1').map((x) => x.id), [1, 3]);
  assert.deepEqual(log.list('u2'), [{ id: 2, ...row({ userId: 'u2', correct: false }) }]);
  assert.equal(log.file.endsWith('answers.json'), true);
});

test('list hands out copies: changing them does not change the log', () => {
  const log = createAnswerLog(tmpDir());
  log.add(row());
  log.list('u1')[0].correct = false;
  assert.equal(log.list('u1')[0].correct, true);
});

test('add rejects bad rows and logs nothing', () => {
  const log = createAnswerLog(tmpDir());
  for (const bad of [
    { userId: '' }, { topicId: undefined }, { questionId: 3 }, { correct: 'yes' },
    { level: 'hard' }, { pool: 'quiz' }, { at: NaN }, { at: '1000' },
  ]) {
    assert.throws(() => log.add(row(bad)), /answerLog\.add/, JSON.stringify(bad));
  }
  assert.deepEqual(log.list('u1'), []);
  assert.equal(fs.existsSync(log.file), false);
});

test('reload across instances: a second instance sees the first one\'s rows, and ids carry on', () => {
  const dir = tmpDir();
  const one = createAnswerLog(dir);
  const two = createAnswerLog(dir);
  one.add(row());
  assert.deepEqual(two.list('u1').map((x) => x.id), [1]); // two reloads after one wrote
  two.add(row({ questionId: 'q-2' }));
  assert.deepEqual(one.list('u1').map((x) => [x.id, x.questionId]), [[1, 'q-1'], [2, 'q-2']]);
  const three = createAnswerLog(dir); // a fresh process
  assert.equal(three.add(row()).id, 3);
  assert.equal(one.list('u1').length, 3);
});

test('atomic write: answers.json is complete JSON with mode 0600 and no temp file is left behind', () => {
  const dir = tmpDir();
  const log = createAnswerLog(dir);
  for (let i = 0; i < 5; i++) log.add(row({ questionId: `q-${i}`, at: i }));
  const parsed = JSON.parse(fs.readFileSync(log.file, 'utf8'));
  assert.equal(parsed.answers.length, 5);
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['answers.json']);
  // The file is replaced (new inode) rather than written in place.
  const ino = fs.statSync(log.file).ino;
  log.add(row());
  assert.notEqual(fs.statSync(log.file).ino, ino);
});

test('atomic write: if the rename fails the old file and the in-memory log are unchanged', () => {
  const dir = tmpDir();
  const log = createAnswerLog(dir);
  log.add(row());
  const before = fs.readFileSync(log.file, 'utf8');
  // Make answers.json a directory so rename over it fails, then put the file back.
  const keep = path.join(dir, 'keep.json');
  fs.renameSync(log.file, keep);
  fs.mkdirSync(log.file);
  fs.writeFileSync(path.join(log.file, 'x'), '');
  assert.throws(() => log.add(row({ questionId: 'q-2' })));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  fs.rmSync(log.file, { recursive: true });
  fs.renameSync(keep, log.file);
  assert.equal(fs.readFileSync(log.file, 'utf8'), before);
  assert.deepEqual(log.list('u1').map((x) => x.questionId), ['q-1']);
  assert.equal(log.add(row({ questionId: 'q-3' })).id, 2); // the failed id is not used up
});

test('an unreadable file on disk keeps the last good copy in memory', () => {
  const dir = tmpDir();
  const log = createAnswerLog(dir);
  log.add(row());
  fs.writeFileSync(log.file, '{ not json');
  assert.equal(log.list('u1').length, 1);
});
