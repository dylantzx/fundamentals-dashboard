import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  hashPassword,
  verifyPassword,
  createAuthenticator,
  scryptNFromEnv,
  DEFAULT_SCRYPT_N,
} from '../lib/auth.js';

const N = 16; // tiny N keeps the tests fast

test('hash format is scrypt$N$r$p$saltHex$hashHex with a 16-byte salt', async () => {
  const h = await hashPassword('correct horse', { N });
  const parts = h.split('$');
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', String(N), '8', '1']);
  assert.match(parts[4], /^[0-9a-f]{32}$/);
  assert.match(parts[5], /^[0-9a-f]{64}$/);
  assert.ok(!h.includes('correct horse'));
});

test('default N is 16384', async () => {
  assert.equal(DEFAULT_SCRYPT_N, 16384);
  const h = await hashPassword('pw');
  assert.equal(h.split('$')[1], '16384');
  assert.equal(scryptNFromEnv({}), 16384);
  assert.equal(scryptNFromEnv({ STEADY_SCRYPT_N: '1024' }), 1024);
  assert.equal(scryptNFromEnv({ STEADY_SCRYPT_N: '1000' }), 16384, 'non power of two ignored');
});

test('same password gets a different salt each time', async () => {
  const a = await hashPassword('same', { N });
  const b = await hashPassword('same', { N });
  assert.notEqual(a, b);
});

test('verifyPassword accepts the right password and rejects others', async () => {
  const h = await hashPassword('s3cret-pass', { N });
  assert.equal(await verifyPassword('s3cret-pass', h), true);
  assert.equal(await verifyPassword('s3cret-pasS', h), false);
  assert.equal(await verifyPassword('', h), false);
});

test('verifyPassword uses timingSafeEqual', async (t) => {
  const h = await hashPassword('pw12345678', { N });
  const spy = t.mock.method(crypto, 'timingSafeEqual');
  await verifyPassword('pw12345678', h);
  await verifyPassword('wrong', h);
  assert.equal(spy.mock.callCount(), 2);
});

test('verifyPassword rejects malformed hashes without throwing', async () => {
  for (const bad of ['', 'plain', 'scrypt$16$8$1$zz$zz', 'bcrypt$16$8$1$00$00', 'scrypt$15$8$1$' + '0'.repeat(32) + '$' + '0'.repeat(64), null]) {
    assert.equal(await verifyPassword('x', /** @type {any} */ (bad)), false);
  }
});

function fakeStore(users) {
  return { findUserByUsername: (u) => users.find((x) => x.username.toLowerCase() === u.toLowerCase()) ?? null };
}

test('authenticate returns the user only for the right password', async () => {
  const user = { id: '1', username: 'Mei', role: 'student', passwordHash: await hashPassword('password1', { N }) };
  const auth = createAuthenticator(fakeStore([user]), { N });
  assert.equal(await auth.authenticate('mei', 'password1'), user);
  assert.equal(await auth.authenticate('mei', 'password2'), null);
  assert.equal(await auth.authenticate('nobody', 'password1'), null);
});

test('unknown username still runs a scrypt hash', async (t) => {
  const user = { id: '1', username: 'Mei', role: 'student', passwordHash: await hashPassword('password1', { N }) };
  const auth = createAuthenticator(fakeStore([user]), { N });
  await auth.authenticate('nobody', 'warmup'); // creates the dummy hash once

  const spy = t.mock.method(crypto, 'scrypt');
  await auth.authenticate('mei', 'wrong-password');
  const known = spy.mock.callCount();
  await auth.authenticate('nobody', 'wrong-password');
  const unknown = spy.mock.callCount() - known;
  assert.equal(known, 1);
  assert.equal(unknown, 1, 'unknown user costs the same single scrypt as a known one');
  assert.equal(spy.mock.calls[1].arguments[3].N, N, 'dummy hash uses the same N');
});

test('unknown-user login takes about as long as a known-user login', async () => {
  const bigN = 4096;
  const user = { id: '1', username: 'Mei', role: 'student', passwordHash: await hashPassword('password1', { N: bigN }) };
  const auth = createAuthenticator(fakeStore([user]), { N: bigN });
  await auth.authenticate('nobody', 'warmup');
  const time = async (name) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) await auth.authenticate(name, 'wrong');
    return Number(process.hrtime.bigint() - t0);
  };
  const known = await time('mei');
  const unknown = await time('nobody');
  // Loose bound: without the dummy hash the unknown path would be ~1000x faster.
  assert.ok(unknown > known * 0.3, `unknown ${unknown}ns vs known ${known}ns`);
});
