// Request routing for Steady.

import {
  applySecurityHeaders,
  sendHtml,
  sendText,
  redirect,
  parseCookies,
  serializeCookie,
  readForm,
  serveStatic,
  HttpError,
} from './http-utils.js';
import { COOKIE_NAME } from './sessions.js';

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * @typedef {{
 *   renderLogin(o: { error: null | 'bad-credentials', username: string, notice: null | 'logged-out' | 'idle' }): string,
 *   renderSetup(o: { errors: Record<string, string>, values: { parentUsername: string, studentUsername: string } }): string,
 *   renderDashboard(model: any): string,
 *   renderParentHome(o: { user: { username: string }, student: { username: string } | null }): string,
 *   renderComingNext(o: { title: string, backHref: string }): string,
 *   renderNotFound(): string,
 * }} Views
 *
 * @typedef {{
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   sessions: ReturnType<typeof import('./sessions.js').createSessions>,
 *   auth: ReturnType<typeof import('./auth.js').createAuthenticator>,
 *   loadUi: () => Promise<{ views: Views, buildDashboardModel: (o: { user: any, progress: any }) => any }>,
 *   publicDir: string,
 *   log: (line: string) => void,
 * }} RouteDeps
 */

/** Titles for the "Coming next" placeholder pages. */
const COMING_NEXT = [
  { re: /^\/practise\/([A-Za-z0-9_-]{1,32})$/, title: 'Practice' },
  { re: /^\/check\/([0-9]{1,2})$/, title: 'Quick check' },
  { re: /^\/subjects?\/([A-Za-z0-9_-]{1,32})$/, title: 'Subjects' },
  { re: /^\/coming-next$/, title: 'Coming next' },
];

/** @param {RouteDeps} deps */
export function createRouter(deps) {
  const { store, sessions, auth, loadUi, publicDir, log } = deps;

  /**
   * Resolves the current session.
   * @returns {{ user: any | null, sid: string | undefined, expired: boolean }}
   */
  function currentUser(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const s = sessions.touch(sid);
    if (s.status === 'ok') {
      const user = store.getUser(s.userId);
      if (user) return { user, sid, expired: false };
      sessions.destroy(sid);
    }
    return { user: null, sid, expired: s.status === 'expired' };
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', { maxAge: 0 }));
  }

  /** Sends anonymous visitors to /login (with notice=idle if their session timed out). */
  function toLogin(res, ctx) {
    if (ctx.expired) {
      clearCookie(res);
      return redirect(res, '/login?notice=idle');
    }
    if (ctx.sid) clearCookie(res);
    return redirect(res, '/login');
  }

  const homeFor = (user) => (user.role === 'student' ? '/dashboard' : '/parent');

  /**
   * Rejects cross-site POSTs when the browser names a different origin.
   * SameSite=Lax is the main defence. A missing or "null" Origin is allowed:
   * with Referrer-Policy: no-referrer, browsers send `Origin: null` on our own form posts.
   */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function notFound(res) {
    const { views } = await loadUi();
    sendHtml(res, 404, views.renderNotFound());
  }

  // ---- handlers -------------------------------------------------------------

  async function getRoot(req, res) {
    if (!store.hasUsers()) return redirect(res, '/setup');
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    return redirect(res, homeFor(ctx.user));
  }

  async function getSetup(req, res) {
    if (store.hasUsers()) return redirect(res, '/login');
    const { views } = await loadUi();
    sendHtml(res, 200, views.renderSetup({ errors: {}, values: { parentUsername: '', studentUsername: '' } }));
  }

  async function postSetup(req, res) {
    if (store.hasUsers()) {
      await readForm(req);
      return redirect(res, '/login');
    }
    const form = await readForm(req);
    const values = {
      parentUsername: (form.parentUsername ?? '').trim(),
      studentUsername: (form.studentUsername ?? '').trim(),
    };
    const parentPassword = form.parentPassword ?? '';
    const studentPassword = form.studentPassword ?? '';

    /** @type {Record<string, string>} */
    const errors = {};
    for (const [field, who] of [['parentUsername', 'parent'], ['studentUsername', 'student']]) {
      const v = values[field];
      if (!v) errors[field] = `Choose a username for the ${who}.`;
      else if (!USERNAME_RE.test(v))
        errors[field] = 'Use 1 to 32 letters, numbers, dots, dashes or underscores, starting with a letter or number.';
    }
    if (!errors.parentUsername && !errors.studentUsername &&
        values.parentUsername.toLowerCase() === values.studentUsername.toLowerCase()) {
      errors.studentUsername = 'The student needs a different username from the parent.';
    }
    for (const [field, pw] of [['parentPassword', parentPassword], ['studentPassword', studentPassword]]) {
      if (pw.length < MIN_PASSWORD_LENGTH) errors[field] = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
      else if (pw.length > MAX_PASSWORD_LENGTH) errors[field] = `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
    }

    if (Object.keys(errors).length) {
      const { views } = await loadUi();
      return sendHtml(res, 400, views.renderSetup({ errors, values }));
    }

    const [parentHash, studentHash] = await Promise.all([auth.hash(parentPassword), auth.hash(studentPassword)]);
    // Re-check after the async hashing so two racing submissions can't both create accounts.
    if (store.hasUsers()) return redirect(res, '/login');
    store.addUser({ username: values.parentUsername, role: 'parent', passwordHash: parentHash });
    store.addUser({ username: values.studentUsername, role: 'student', passwordHash: studentHash });
    return redirect(res, '/login');
  }

  async function getLogin(req, res, url) {
    if (!store.hasUsers()) return redirect(res, '/setup');
    const ctx = currentUser(req);
    if (ctx.user) return redirect(res, homeFor(ctx.user));
    const n = url.searchParams.get('notice');
    const notice = n === 'logged-out' || n === 'idle' ? n : null;
    if (ctx.sid) clearCookie(res);
    const { views } = await loadUi();
    sendHtml(res, 200, views.renderLogin({ error: null, username: '', notice }));
  }

  async function postLogin(req, res) {
    if (!store.hasUsers()) {
      await readForm(req);
      return redirect(res, '/setup');
    }
    const form = await readForm(req);
    const username = (form.username ?? '').trim().slice(0, 64);
    const password = (form.password ?? '').slice(0, MAX_PASSWORD_LENGTH);
    const user = await auth.authenticate(username, password);
    if (!user) {
      const { views } = await loadUi();
      return sendHtml(res, 401, views.renderLogin({ error: 'bad-credentials', username, notice: null }));
    }
    // Fresh session id on every login (no fixation); drop any old one.
    const oldSid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    sessions.destroy(oldSid);
    const sid = sessions.create(user.id);
    res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, sid));
    return redirect(res, '/');
  }

  async function postLogout(req, res) {
    await readForm(req);
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    sessions.destroy(sid);
    clearCookie(res);
    return redirect(res, '/login?notice=logged-out');
  }

  async function getDashboard(req, res) {
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    if (ctx.user.role !== 'student') return redirect(res, homeFor(ctx.user));
    const { views, buildDashboardModel } = await loadUi();
    const model = buildDashboardModel({ user: ctx.user, progress: store.getProgress(ctx.user.id) });
    sendHtml(res, 200, views.renderDashboard(model));
  }

  async function getParent(req, res) {
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    if (ctx.user.role !== 'parent') return redirect(res, homeFor(ctx.user));
    const student = store.listUsers().find((u) => u.role === 'student');
    const { views } = await loadUi();
    sendHtml(res, 200, views.renderParentHome({
      user: { username: ctx.user.username },
      student: student ? { username: student.username } : null,
    }));
  }

  async function getComingNext(req, res, title) {
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    const { views } = await loadUi();
    sendHtml(res, 200, views.renderComingNext({ title, backHref: homeFor(ctx.user) }));
  }

  // ---- dispatch -------------------------------------------------------------

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function route(req, res) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;

    if (method === 'POST' && !sameOrigin(req)) {
      req.resume();
      return sendText(res, 403, 'Forbidden');
    }

    if (p === '/' && method === 'GET') return getRoot(req, res);
    if (p === '/setup') {
      if (method === 'GET') return getSetup(req, res);
      if (method === 'POST') return postSetup(req, res);
    }
    if (p === '/login') {
      if (method === 'GET') return getLogin(req, res, url);
      if (method === 'POST') return postLogin(req, res);
    }
    if (p === '/logout' && method === 'POST') return postLogout(req, res);
    if (p === '/dashboard' && method === 'GET') return getDashboard(req, res);
    if (p === '/parent' && method === 'GET') return getParent(req, res);

    if (method === 'GET' && p.startsWith('/public/')) {
      // Use the raw (still-encoded) path so %2e%2e etc. are checked after decoding.
      const rawPath = (req.url || '').split('?')[0];
      if (await serveStatic(res, publicDir, rawPath.slice('/public/'.length))) return;
      return notFound(res);
    }

    if (method === 'GET') {
      for (const { re, title } of COMING_NEXT) if (re.test(p)) return getComingNext(req, res, title);
    }

    if (method !== 'GET') req.resume();
    return notFound(res);
  }

  /**
   * The request handler: security headers, routing, error handling and a
   * one-line access log (method, path, status only: never bodies or query strings).
   */
  return async function handler(req, res) {
    applySecurityHeaders(res);
    const started = Date.now();
    res.on('finish', () => {
      const pathOnly = (req.url || '/').split('?')[0];
      log(`${req.method} ${pathOnly} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        return sendText(res, err.status, err.message);
      }
      log(`error handling ${req.method} ${(req.url || '/').split('?')[0]}: ${err && err.name}: ${err && err.message}`);
      return sendText(res, 500, 'Something went wrong.');
    }
  };
}
