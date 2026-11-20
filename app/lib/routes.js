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
import { TOPICS, LABEL_TEXT, labelFor } from './ratings.js';
import { renderPractice, renderBankIndex, renderBankQuestion } from '../views/practice.js';
import { createParentRoutes } from './parent-routes.js';

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
 *   bank?: ReturnType<typeof import('./question-bank.js').loadQuestionBank> | null,
 *   log: (line: string) => void,
 *   studySessions: ReturnType<typeof import('./study-sessions.js').createStudySessions>,
 *   loadParentData: () => Promise<{ answerLog: { list(userId: string): any[] }, labelOf: (answers: any[]) => any }>,
 * }} RouteDeps
 */

/** Titles for the "Coming next" placeholder pages. */
const COMING_NEXT = [
  { re: /^\/practise\/([A-Za-z0-9_-]{1,32})$/, title: 'Practice' },
  { re: /^\/check\/([0-9]{1,2})$/, title: 'Quick check' },
  { re: /^\/subjects?\/([A-Za-z0-9_-]{1,32})$/, title: 'Subjects' },
  { re: /^\/coming-next$/, title: 'Coming next' },
  { re: /^\/bank(\/.*)?$/, title: 'Question bank' },
];

/** @param {RouteDeps} deps */
export function createRouter(deps) {
  const { store, sessions, auth, loadUi, publicDir, log } = deps;
  const bank = deps.bank ?? null;
  const { studySessions } = deps;

  /** Ends the study session tied to a login, if it has one. */
  function endStudy(meta, reason) {
    if (meta && meta.studyId) studySessions.end(meta.studyId, reason);
  }

  /**
   * Resolves the current session.
   * @returns {{ user: any | null, sid: string | undefined, expired: boolean }}
   */
  function currentUser(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const s = sessions.touch(sid);
    if (s.status === 'expired') endStudy(s.meta, 'idle');
    if (s.status === 'ok') {
      if (s.meta && s.meta.studyId) studySessions.action(s.meta.studyId);
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
    // A new login also ends this account's earlier logins (and their study sessions).
    const oldSid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    endStudy(sessions.destroy(oldSid), 'replaced');
    for (const meta of sessions.destroyUser(user.id)) endStudy(meta, 'replaced');
    const meta = user.role === 'student' ? { studyId: studySessions.start(user.id).id } : undefined;
    const sid = sessions.create(user.id, meta);
    res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, sid));
    return redirect(res, '/');
  }

  async function postLogout(req, res) {
    await readForm(req);
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    endStudy(sessions.destroy(sid), 'logout');
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

  // Everything under /parent (lib/parent-routes.js).
  const handleParent = createParentRoutes({
    store, auth, studySessions, loadParentData: deps.loadParentData, loadUi, currentUser, toLogin, homeFor, notFound,
  });

  async function getComingNext(req, res, title) {
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    const { views } = await loadUi();
    sendHtml(res, 200, views.renderComingNext({ title, backHref: homeFor(ctx.user) }));
  }

  // ---- practice from the real question bank ---------------------------------

  /** Questions per practice set and per quick check (as the dashboard promises). */
  const PRACTICE_SIZE = 5;
  const CHECK_SIZE = 3;

  /**
   * The question set behind /practise/:topicId or /check/:n, or null if there is none.
   * @param {'practise' | 'check'} mode @param {string} key
   */
  function practiceSet(mode, key) {
    if (!bank) return null;
    let topic, checkN;
    if (mode === 'check') {
      checkN = Number(key);
      topic = Number.isInteger(checkN) ? TOPICS[checkN - 1] : undefined;
    } else {
      topic = TOPICS.find((t) => t.id === key);
    }
    if (!topic) return null;
    const all = bank.forTopic(topic.id);
    // A check is short: MCQs first, since they mark themselves.
    const items = mode === 'check'
      ? [...all.filter((i) => i.type === 'mcq'), ...all.filter((i) => i.type !== 'mcq')].slice(0, CHECK_SIZE)
      : all.slice(0, PRACTICE_SIZE);
    const base = mode === 'check' ? `/check/${checkN}` : `/practise/${topic.id}`;
    return { mode, topic, checkN, items, base };
  }

  function ratingFor(progress, topicId) {
    const s = progress.topics?.[topicId] || {};
    const total = Math.max(0, Math.floor(Number(s.total) || 0));
    const right = Math.min(total, Math.max(0, Math.floor(Number(s.right) || 0)));
    const label = labelFor({ right, total });
    return { label, labelText: LABEL_TEXT[label], right, total };
  }

  async function getPractice(req, res, url, set) {
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    if (ctx.user.role !== 'student') return redirect(res, homeFor(ctx.user));
    const count = set.items.length;
    const done = url.searchParams.get('done') === '1';
    const index = Number(url.searchParams.get('i') ?? 0);
    if (!done && count && !(Number.isInteger(index) && index >= 0 && index < count)) return redirect(res, set.base);
    const item = done || !count ? null : set.items[index];
    const picked = url.searchParams.get('picked');
    const feedback = item && item.type === 'mcq' && item.options.some((o) => o.label === picked) ? { picked } : null;
    const isLast = index === count - 1;
    sendHtml(res, 200, renderPractice({
      user: { username: ctx.user.username },
      mode: set.mode,
      checkN: set.checkN,
      topic: set.topic,
      rating: ratingFor(store.getProgress(ctx.user.id), set.topic.id),
      base: set.base,
      index: done ? count : index,
      count,
      item,
      feedback,
      nextHref: isLast ? `${set.base}?done=1` : `${set.base}?i=${index + 1}`,
      isLast,
      done,
      source: bank.sourceLine(),
    }));
  }

  async function postPracticeAnswer(req, res, set) {
    const form = await readForm(req);
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    if (ctx.user.role !== 'student') return redirect(res, homeFor(ctx.user));
    const index = Number(form.i);
    const item = Number.isInteger(index) ? set.items[index] : undefined;
    if (!item) return redirect(res, set.base);

    let right;
    if (item.type === 'mcq') {
      if (!item.options.some((o) => o.label === form.choice)) return redirect(res, `${set.base}?i=${index}`);
      right = form.choice === item.correctOption;
    } else {
      if (form.self !== 'right' && form.self !== 'wrong') return redirect(res, `${set.base}?i=${index}`);
      right = form.self === 'right';
    }

    const progress = store.getProgress(ctx.user.id);
    const prev = progress.topics[set.topic.id] || { right: 0, total: 0 };
    progress.topics[set.topic.id] = { right: (prev.right || 0) + (right ? 1 : 0), total: (prev.total || 0) + 1 };
    const isLast = index === set.items.length - 1;
    if (set.mode === 'check' && isLast && progress.checksDone === set.checkN - 1) progress.checksDone = set.checkN;
    store.setProgress(ctx.user.id, progress);

    if (item.type === 'mcq') return redirect(res, `${set.base}?i=${index}&picked=${form.choice}`);
    return redirect(res, isLast ? `${set.base}?done=1` : `${set.base}?i=${index + 1}`);
  }

  async function getBankIndex(req, res) {
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    const groups = bank.papers.map((p) => {
      const qs = bank.roots.filter((r) => r.paper === p.paper && r.document_id === p.documentId);
      return {
        paper: p.paper,
        title: `Paper ${p.paper.replace(/^P/, '')} (${p.paper_code}) · ${p.paper === 'P1' ? 'Multiple choice' : 'Structured'}`,
        questions: qs.map((r) => ({
          id: r.id,
          label: r.label,
          type: r.type,
          marks: r.total_marks ?? r.marks ?? 0,
          parts: countParts(r),
          preview: preview(r),
        })),
      };
    }).filter((g) => g.questions.length);
    sendHtml(res, 200, renderBankIndex({ user: { username: ctx.user.username }, groups, source: bank.sourceLine(), backHref: homeFor(ctx.user) }));
  }

  async function getBankQuestion(req, res, id) {
    const ctx = currentUser(req);
    if (!ctx.user) return toLogin(res, ctx);
    const root = bank.root(id);
    if (!root) return notFound(res);
    const p = bank.papers.find((x) => x.paper === root.paper && x.documentId === root.document_id) || {};
    sendHtml(res, 200, renderBankQuestion({
      user: { username: ctx.user.username },
      root,
      paperName: p.paper_code ? `Paper ${root.paper.replace(/^P/, '')} (${p.paper_code})` : root.paper,
      source: bank.sourceLine(),
    }));
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
    if (p === '/parent' || p.startsWith('/parent/')) return handleParent(req, res, url, method);

    if (method === 'GET' && p.startsWith('/public/')) {
      // Use the raw (still-encoded) path so %2e%2e etc. are checked after decoding.
      const rawPath = (req.url || '').split('?')[0];
      if (await serveStatic(res, publicDir, rawPath.slice('/public/'.length))) return;
      return notFound(res);
    }

    if (bank) {
      const pm = /^\/(practise|check)\/([A-Za-z0-9_-]{1,32})(\/answer)?$/.exec(p);
      const set = pm && practiceSet(pm[1], pm[2]);
      if (set) {
        if (!pm[3] && method === 'GET') return getPractice(req, res, url, set);
        if (pm[3] && method === 'POST') return postPracticeAnswer(req, res, set);
      }
      if (method === 'GET' && p === '/bank') return getBankIndex(req, res);
      const qm = /^\/bank\/q\/([A-Za-z0-9_-]{1,64})$/.exec(p);
      if (method === 'GET' && qm) return getBankQuestion(req, res, qm[1]);
      if (method === 'GET' && p.startsWith('/bank/assets/')) {
        const ctx = currentUser(req);
        if (!ctx.user) return toLogin(res, ctx);
        const rawPath = (req.url || '').split('?')[0];
        if (await serveStatic(res, bank.assetsDir, rawPath.slice('/bank/assets/'.length))) return;
        return notFound(res);
      }
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

/** Number of answerable parts in a question tree. */
function countParts(n) {
  const own = n.type === 'structured' || n.type === 'mcq' ? 1 : 0;
  return own + (n.children || []).reduce((s, c) => s + countParts(c), 0);
}

/** First line of a question, for the bank list. */
function preview(n) {
  const text = (n.stem || n.children?.[0]?.stem || '').split('\n').find((l) => l.trim() && !l.trim().startsWith('|')) || '';
  return text.length > 140 ? text.slice(0, 137).trimEnd() + '…' : text;
}
