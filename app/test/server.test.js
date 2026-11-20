import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createApp } from '../server.js';
import { views, buildDashboardModel, publicDir } from './helpers/app-parts.js';

const PARENT = { username: 'MumTan', password: 'parent-pass-123' };
const STUDENT = { username: 'mei', password: 'student-pass-456' };
const MIN = 60 * 1000;

/** Starts an app on a random port with a temp data dir and a controllable clock. */
async function startApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-srv-'));
  const clock = { t: 1_700_000_000_000 };
  const logs = [];
  const server = createApp({
    dataDir,
    scryptN: 16,
    now: () => clock.t,
    views,
    buildDashboardModel,
    publicDir,
    log: (line) => logs.push(line),
    ...extra,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${port}`;

  /** fetch without following redirects */
  const req = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
  const get = (p, cookie) => req(p, { headers: cookie ? { cookie } : {} });
  const post = (p, form, cookie, headers = {}) =>
    req(p, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers },
      body: new URLSearchParams(form).toString(),
    });

  /** raw request so the path is sent exactly as written (no URL normalising) */
  const raw = (rawPath, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });

  async function setup() {
    const res = await post('/setup', {
      parentUsername: PARENT.username,
      parentPassword: PARENT.password,
      studentUsername: STUDENT.username,
      studentPassword: STUDENT.password,
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login');
  }

  /** @returns {Promise<string>} the cookie header value to send back */
  async function login(who) {
    const res = await post('/login', { username: who.username, password: who.password });
    assert.equal(res.status, 303, 'login should redirect');
    assert.equal(res.headers.get('location'), '/');
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'login sets a cookie');
    return setCookie.split(';')[0];
  }

  const close = () => new Promise((resolve) => server.close(resolve));
  return { server, dataDir, clock, logs, base, req, get, post, raw, setup, login, close };
}

const loc = (res) => res.headers.get('location');

/** The real setup view marks a field error with <p class="field-error" id="<field>-error">. */
const hasFieldError = (body, field) => body.includes(`id="${field}-error"`);

const LOGIN_ERROR = 'That username and password don’t match. Check both and try again.';
const NOTICE_IDLE = 'You were logged out after 20 minutes with no activity.';

/**
 * A copy of the real public/ folder inside a temp dir, with a secret file next
 * to it (outside public/) for the path-traversal tests.
 */
function staticFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steady-static-'));
  const dir = path.join(root, 'public');
  fs.cpSync(publicDir, dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET-OUTSIDE-PUBLIC\n');
  fs.writeFileSync(path.join(dir, '.hidden.txt'), 'SECRET-OUTSIDE-PUBLIC\n');
  return dir;
}

describe('first-run setup', () => {
  let app;
  before(async () => (app = await startApp()));
  after(() => app.close());

  test('with no users, / and /login go to /setup', async () => {
    assert.equal(loc(await app.get('/')), '/setup');
    assert.equal(loc(await app.get('/login')), '/setup');
    const res = await app.get('/setup');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /action="\/setup"/);
  });

  test('invalid input re-renders with errors and keeps usernames (never passwords)', async () => {
    const res = await app.post('/setup', {
      parentUsername: 'MumTan',
      parentPassword: 'short',
      studentUsername: 'mumtan',
      studentPassword: 'longenough1',
    });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.ok(hasFieldError(body, 'parentPassword'));
    assert.ok(hasFieldError(body, 'studentUsername'), 'same username for both is rejected');
    assert.ok(body.includes('The student needs a different username from the parent.'));
    assert.ok(!hasFieldError(body, 'parentUsername'));
    assert.ok(!hasFieldError(body, 'studentPassword'));
    assert.match(body, /role="alert"/);
    assert.match(body, /value="MumTan"/);
    assert.ok(!body.includes('longenough1'));
    assert.equal(app.server.store.hasUsers(), false);
  });

  test('missing fields are reported', async () => {
    const res = await app.post('/setup', {});
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.ok(body.includes('4 details need fixing.'));
    for (const f of ['parentUsername', 'parentPassword', 'studentUsername', 'studentPassword']) {
      assert.ok(hasFieldError(body, f), f);
    }
  });

  test('valid setup creates one parent and one student, then setup is closed', async () => {
    await app.setup();
    const users = app.server.store.listUsers();
    assert.deepEqual(users.map((u) => [u.username, u.role]).sort(), [['MumTan', 'parent'], ['mei', 'student']]);
    for (const u of users) assert.match(u.passwordHash, /^scrypt\$16\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);

    assert.equal(loc(await app.get('/setup')), '/login');
    const again = await app.post('/setup', {
      parentUsername: 'evil', parentPassword: 'evil-pass-1', studentUsername: 'evil2', studentPassword: 'evil-pass-2',
    });
    assert.equal(again.status, 303);
    assert.equal(loc(again), '/login');
    assert.equal(app.server.store.listUsers().length, 2);
    assert.equal(loc(await app.get('/')), '/login');
  });
});

describe('login, sessions and roles', () => {
  let app;
  before(async () => {
    app = await startApp();
    await app.setup();
  });
  after(() => app.close());

  test('login page renders with an allowed notice only', async () => {
    const res = await app.get('/login?notice=idle');
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(NOTICE_IDLE));
    const plain = await (await app.get('/login')).text();
    const bogus = await (await app.get('/login?notice=<script>')).text();
    assert.equal(bogus, plain, 'unknown notice is ignored');
    assert.ok(!bogus.includes('role="status"'));
  });

  test('wrong password and unknown user give the same generic error, username kept', async () => {
    const a = await app.post('/login', { username: 'mei', password: 'nope-nope' });
    const b = await app.post('/login', { username: 'ghost', password: 'nope-nope' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.headers.get('set-cookie'), null);
    const ta = await a.text();
    const tb = await b.text();
    assert.ok(ta.includes(LOGIN_ERROR));
    assert.ok(tb.includes(LOGIN_ERROR));
    assert.match(ta, /value="mei"/);
    assert.match(tb, /value="ghost"/);
    assert.equal(ta.replace('value="mei"', ''), tb.replace('value="ghost"', ''), 'no hint which part was wrong');
    assert.ok(!ta.includes('nope-nope'), 'password is never echoed');
  });

  test('username is escaped when echoed back', async () => {
    const res = await app.post('/login', { username: '"><script>x</script>', password: 'x' });
    const body = await res.text();
    assert.ok(!body.includes('<script>x</script>'));
  });

  test('success sets a secure session cookie and redirects to /', async () => {
    const res = await app.post('/login', { username: 'MEI', password: STUDENT.password });
    assert.equal(res.status, 303);
    assert.equal(loc(res), '/');
    const c = res.headers.get('set-cookie');
    assert.match(c, /^steady_sid=[0-9a-f]{64};/);
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; SameSite=Lax/);
    assert.match(c, /; Path=\//);
    assert.doesNotMatch(c, /Max-Age|Expires/i, 'session cookie, not persistent');
  });

  test('each login gets a fresh session id', async () => {
    const a = await app.login(STUDENT);
    const b = await app.login(STUDENT);
    assert.notEqual(a, b);
  });

  test('student: / -> /dashboard, /parent blocked', async () => {
    const cookie = await app.login(STUDENT);
    assert.equal(loc(await app.get('/', cookie)), '/dashboard');
    const dash = await app.get('/dashboard', cookie);
    assert.equal(dash.status, 200);
    const body = await dash.text();
    assert.match(body, /class="user-chip">.*<\/span>mei<\/span>/);
    assert.ok(body.includes('Welcome to Steady · Chemistry'), 'first-time state');
    const p = await app.get('/parent', cookie);
    assert.equal(p.status, 303);
    assert.equal(loc(p), '/dashboard');
  });

  test('dashboard uses the stored progress', async () => {
    const student = app.server.store.findUserByUsername('mei');
    app.server.store.setProgress(student.id, { topics: { t1: { right: 1, total: 3 } }, checksDone: 1 });
    const cookie = await app.login(STUDENT);
    const body = await (await app.get('/dashboard', cookie)).text();
    assert.ok(!body.includes('Welcome to Steady · Chemistry'), 'no longer first-time');
    assert.ok(body.includes('Next up in Chemistry'), 'part-way state with a Next up topic');
    app.server.store.setProgress(student.id, { topics: {}, checksDone: 0 });
  });

  test('parent: / -> /parent, /dashboard blocked', async () => {
    const cookie = await app.login(PARENT);
    assert.equal(loc(await app.get('/', cookie)), '/parent');
    const page = await app.get('/parent', cookie);
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.match(body, /Hi MumTan/);
    assert.match(body, /Student account<\/p><strong>mei<\/strong>/);
    assert.ok(body.includes('Session summaries coming soon'));
    const d = await app.get('/dashboard', cookie);
    assert.equal(d.status, 303);
    assert.equal(loc(d), '/parent');
  });

  test('anonymous users are sent to /login', async () => {
    for (const p of ['/', '/dashboard', '/parent', '/practise/t1', '/check/1']) {
      const res = await app.get(p);
      assert.equal(res.status, 303, p);
      assert.equal(loc(res), '/login', p);
    }
    assert.equal(loc(await app.get('/dashboard', 'steady_sid=' + 'a'.repeat(64))), '/login', 'forged sid');
  });

  test('logged-in user visiting /login goes home', async () => {
    const cookie = await app.login(STUDENT);
    assert.equal(loc(await app.get('/login', cookie)), '/dashboard');
  });

  test('dashboard links go to the Coming next page', async () => {
    const cookie = await app.login(STUDENT);
    for (const p of ['/practise/t1', '/practise/t6', '/check/1', '/check/6']) {
      const res = await app.get(p, cookie);
      assert.equal(res.status, 200, p);
      const body = await res.text();
      assert.match(body, /being built/);
      assert.match(body, /href="\/dashboard"/);
    }
    const parentCookie = await app.login(PARENT);
    assert.match(await (await app.get('/practise/t1', parentCookie)).text(), /href="\/parent"/);
  });

  test('idle timeout: 20 minutes of no requests logs you out', async () => {
    const cookie = await app.login(STUDENT);
    app.clock.t += 19 * MIN;
    assert.equal((await app.get('/dashboard', cookie)).status, 200, 'still in at 19 min');
    app.clock.t += 19 * MIN;
    assert.equal((await app.get('/dashboard', cookie)).status, 200, 'activity refreshed the timer');
    app.clock.t += 20 * MIN + 1000;
    const res = await app.get('/dashboard', cookie);
    assert.equal(res.status, 303);
    assert.equal(loc(res), '/login?notice=idle');
    assert.match(res.headers.get('set-cookie'), /^steady_sid=; .*Max-Age=0/);
    const after = await app.get('/dashboard', cookie);
    assert.equal(loc(after), '/login', 'session is gone for good');
  });

  test('idle timeout on / also shows the idle notice', async () => {
    const cookie = await app.login(PARENT);
    app.clock.t += 21 * MIN;
    assert.equal(loc(await app.get('/', cookie)), '/login?notice=idle');
  });

  test('logout clears the session and redirects with a notice', async () => {
    const cookie = await app.login(STUDENT);
    const res = await app.post('/logout', {}, cookie);
    assert.equal(res.status, 303);
    assert.equal(loc(res), '/login?notice=logged-out');
    assert.match(res.headers.get('set-cookie'), /^steady_sid=; .*Max-Age=0/);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/);
    const after = await app.get('/dashboard', cookie);
    assert.equal(loc(after), '/login', 'old cookie no longer works');
  });

  test('GET /logout is not a route', async () => {
    assert.equal((await app.get('/logout')).status, 404);
  });

  test('cross-site POST is refused; Origin null (no-referrer) is allowed', async () => {
    const evil = await app.post('/login', { username: 'mei', password: STUDENT.password }, null, { origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    const nul = await app.post('/login', { username: 'mei', password: STUDENT.password }, null, { origin: 'null' });
    assert.equal(nul.status, 303);
    const same = await app.post('/login', { username: 'mei', password: STUDENT.password }, null, { origin: app.base });
    assert.equal(same.status, 303);
  });
});

describe('static files, 404, headers, limits', () => {
  let app;
  const staticDir = staticFixture();
  before(async () => (app = await startApp({ publicDir: staticDir })));
  after(() => app.close());

  test('the traversal fixture exists', () => {
    assert.ok(fs.existsSync(path.join(staticDir, '..', 'secret.txt')));
  });

  test('serves public files with the right content types', async () => {
    const css = await app.get('/public/styles.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.match(await css.text(), /font-family/);
    const svg = await app.get('/public/assets/favicon.svg');
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  });

  test('path traversal is blocked', async () => {
    const attempts = [
      '/public/../secret.txt',
      '/public/..%2fsecret.txt',
      '/public/%2e%2e/secret.txt',
      '/public/%2e%2e%2fsecret.txt',
      '/public/assets/../../secret.txt',
      '/public/..%5csecret.txt',
      '/public/%2e%2e%5csecret.txt',
      '/public/styles.css%00.png',
      '/public/' + encodeURIComponent(path.join(staticDir, '..', 'secret.txt')),
      '/public//etc/passwd',
      '/public/%2fetc%2fpasswd',
      '/public/.hidden.txt',
      '/public/%E0%A4%A',
    ];
    for (const p of attempts) {
      const res = await app.raw(p);
      assert.notEqual(res.status, 200, p);
      assert.ok(!res.body.includes('SECRET-OUTSIDE-PUBLIC'), p);
      assert.ok(!res.body.includes('root:'), p);
    }
  });

  test('directories and unknown types are not served', async () => {
    assert.equal((await app.get('/public/assets')).status, 404);
    assert.equal((await app.get('/public/assets/')).status, 404);
    assert.equal((await app.get('/public/nope.css')).status, 404);
  });

  test('unknown pages get the 404 page', async () => {
    const res = await app.get('/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok((await res.text()).includes('This page doesn’t exist'));
    assert.equal((await app.req('/dashboard', { method: 'PUT' })).status, 404);
  });

  test('security headers on pages, redirects, static files and errors', async () => {
    const responses = [
      await app.get('/'),
      await app.get('/setup'),
      await app.get('/public/styles.css'),
      await app.get('/nope'),
    ];
    for (const res of responses) {
      assert.equal(
        res.headers.get('content-security-policy'),
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      );
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    }
    assert.equal((await app.get('/setup')).headers.get('cache-control'), 'no-store');
  });

  test('POST bodies over 10 KB are rejected with 413', async () => {
    const big = 'username=' + 'a'.repeat(11 * 1024) + '&password=x';
    const res = await app.raw('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(big) },
      body: big,
    });
    assert.equal(res.status, 413);

    // Chunked (no Content-Length) is also capped.
    const chunked = await new Promise((resolve, reject) => {
      const { port } = app.server.address();
      const r = http.request({ host: '127.0.0.1', port, path: '/setup', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve('reset') : reject(e)));
      for (let i = 0; i < 12; i++) r.write('x'.repeat(1024));
      r.end();
    });
    assert.ok(chunked === 413 || chunked === 'reset', String(chunked));

    const ok = 'username=' + 'a'.repeat(9 * 1024) + '&password=x';
    assert.equal((await app.raw('/setup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': ok.length }, body: ok })).status, 400);
  });

  test('non-form POST bodies are refused', async () => {
    const res = await app.raw('/login', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 }, body: '{}' });
    assert.ok(res.status === 415 || res.status === 303, String(res.status));
  });
});

test('passwords never appear in db.json or the logs', async () => {
  const app = await startApp();
  try {
    await app.setup();
    await app.login(STUDENT);
    await app.login(PARENT);
    await app.post('/login', { username: 'mei', password: 'a-wrong-password-xyz' });
    await app.post('/login?password=leak-in-query', { username: 'mei', password: 'x' });
    const db = fs.readFileSync(path.join(app.dataDir, 'db.json'), 'utf8');
    const logs = app.logs.join('\n');
    assert.ok(app.logs.length > 0, 'requests are logged');
    for (const secret of [PARENT.password, STUDENT.password, 'a-wrong-password-xyz', 'leak-in-query']) {
      assert.ok(!db.includes(secret), `db.json contains ${secret}`);
      assert.ok(!logs.includes(secret), `logs contain ${secret}`);
    }
    assert.match(logs, /POST \/login 303/);
  } finally {
    await app.close();
  }
});

test('createApp loads the real views when no overrides are given (lazy)', async () => {
  // Before the merge the real modules are missing, so a page request fails with 500
  // instead of crashing the server; after the merge it renders. Either way the
  // server stays up and redirects (which need no view) still work.
  const app = await startApp({ views: undefined, buildDashboardModel: undefined, publicDir: undefined });
  try {
    assert.equal(loc(await app.get('/')), '/setup');
    const res = await app.get('/setup');
    assert.ok(res.status === 200 || res.status === 500, String(res.status));
  } finally {
    await app.close();
  }
});
