import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../lib/store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'steady-store-'));
}

test('creates the data dir and starts empty', () => {
  const dir = path.join(tmpDir(), 'nested', 'data');
  const store = createStore(dir);
  assert.ok(fs.statSync(dir).isDirectory());
  assert.equal(store.hasUsers(), false);
  assert.deepEqual(store.listUsers(), []);
  assert.equal(fs.existsSync(path.join(dir, 'db.json')), false, 'nothing written until a change');
});

test('addUser, getUser, case-insensitive findUserByUsername', () => {
  const store = createStore(tmpDir());
  const u = store.addUser({ username: 'Mei', role: 'student', passwordHash: 'scrypt$x' });
  assert.match(u.id, /^[0-9a-f]{32}$/);
  assert.equal(u.role, 'student');
  assert.ok(!Number.isNaN(Date.parse(u.createdAt)));
  assert.equal(store.hasUsers(), true);
  assert.deepEqual(store.getUser(u.id), u);
  assert.deepEqual(store.findUserByUsername('mei'), u);
  assert.deepEqual(store.findUserByUsername('MEI'), u);
  assert.equal(store.findUserByUsername('nobody'), null);
  assert.equal(store.getUser('nope'), null);
});

test('addUser validates role and rejects duplicate usernames', () => {
  const store = createStore(tmpDir());
  store.addUser({ username: 'Mum', role: 'parent', passwordHash: 'h' });
  assert.throws(() => store.addUser({ username: 'mum', role: 'student', passwordHash: 'h' }), /taken/);
  assert.throws(() => store.addUser({ username: 'x', role: 'admin', passwordHash: 'h' }), /role/);
  assert.equal(store.listUsers().length, 1);
});

test('returned objects are copies', () => {
  const store = createStore(tmpDir());
  const u = store.addUser({ username: 'a', role: 'parent', passwordHash: 'h' });
  u.role = 'student';
  assert.equal(store.getUser(u.id).role, 'parent');
  const p = store.getProgress(u.id);
  p.checksDone = 5;
  assert.equal(store.getProgress(u.id).checksDone, 0);
});

test('progress defaults and persists', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const u = store.addUser({ username: 'mei', role: 'student', passwordHash: 'h' });
  assert.deepEqual(store.getProgress(u.id), { topics: {}, checksDone: 0 });
  const progress = { topics: { t1: { right: 2, total: 3 } }, checksDone: 2 };
  store.setProgress(u.id, progress);
  assert.deepEqual(store.getProgress(u.id), progress);

  const again = createStore(dir);
  assert.deepEqual(again.getProgress(u.id), progress);
  assert.deepEqual(again.getUser(u.id), u);
});

test('reload() still forces a re-read from disk', () => {
  const dir = tmpDir();
  const a = createStore(dir);
  const b = createStore(dir);
  const u = a.addUser({ username: 'mei', role: 'student', passwordHash: 'h' });
  b.reload();
  assert.equal(b.getUser(u.id).username, 'mei');
});

test('writes atomically: tmp file then rename, no leftovers, mode 0600', (t) => {
  const dir = tmpDir();
  const store = createStore(dir);
  const renames = t.mock.method(fs, 'renameSync');
  store.addUser({ username: 'mei', role: 'student', passwordHash: 'h' });
  assert.equal(renames.mock.callCount(), 1);
  const [from, to] = renames.mock.calls[0].arguments;
  assert.equal(to, path.join(dir, 'db.json'));
  assert.equal(path.dirname(from), dir);
  assert.match(path.basename(from), /^db\.json\..+\.tmp$/);
  assert.deepEqual(fs.readdirSync(dir), ['db.json']);
  assert.equal(fs.statSync(path.join(dir, 'db.json')).mode & 0o777, 0o600);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.equal(parsed.users.length, 1);
});

test('a failed write leaves db.json and memory unchanged', (t) => {
  const dir = tmpDir();
  const store = createStore(dir);
  const first = store.addUser({ username: 'mum', role: 'parent', passwordHash: 'h' });
  const before = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');

  t.mock.method(fs, 'renameSync', () => {
    throw new Error('disk full');
  });
  assert.throws(() => store.addUser({ username: 'mei', role: 'student', passwordHash: 'h' }), /disk full/);
  assert.throws(() => store.setProgress(first.id, { topics: {}, checksDone: 3 }), /disk full/);
  t.mock.restoreAll();

  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['db.json'], 'temp file cleaned up');
  assert.equal(store.listUsers().length, 1);
  assert.equal(store.findUserByUsername('mei'), null);
  assert.equal(store.getProgress(first.id).checksDone, 0);
});

test('a store sees changes another store (process) wrote to the same dir', () => {
  const dir = tmpDir();
  const a = createStore(dir);
  const u = a.addUser({ username: 'mei', role: 'student', passwordHash: 'h' });
  assert.deepEqual(a.getProgress(u.id), { topics: {}, checksDone: 0 });

  // e.g. scripts/seed-demo.js run while the server is up
  const b = createStore(dir);
  const seeded = { topics: { t1: { right: 1, total: 3 } }, checksDone: 6 };
  b.setProgress(u.id, seeded);

  assert.deepEqual(a.getProgress(u.id), seeded, 'next read reloads without a restart');

  b.addUser({ username: 'mum', role: 'parent', passwordHash: 'h' });
  assert.equal(a.findUserByUsername('MUM').role, 'parent');
  assert.equal(a.listUsers().length, 2);
});

test('a write after another store changed the file keeps that change', () => {
  const dir = tmpDir();
  const a = createStore(dir);
  const b = createStore(dir);
  const mum = b.addUser({ username: 'mum', role: 'parent', passwordHash: 'h' });
  const mei = a.addUser({ username: 'mei', role: 'student', passwordHash: 'h' });
  const onDisk = createStore(dir);
  assert.deepEqual(onDisk.listUsers().map((x) => x.id).sort(), [mum.id, mei.id].sort());
});

test('reads do not re-read db.json when nothing changed, including after own writes', (t) => {
  const dir = tmpDir();
  const a = createStore(dir);
  const u = a.addUser({ username: 'mei', role: 'student', passwordHash: 'h' });
  a.setProgress(u.id, { topics: {}, checksDone: 1 });
  const reads = t.mock.method(fs, 'readFileSync');
  for (let i = 0; i < 5; i++) {
    a.getProgress(u.id);
    a.getUser(u.id);
    a.hasUsers();
  }
  assert.equal(reads.mock.callCount(), 0);
});
