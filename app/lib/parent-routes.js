// The parent's pages: every address under /parent.
//
//   GET  /parent                          sessions, the test summary, the student account
//   POST /parent/sessions/:id/record      Stayed / Went to video / Not recorded, and a note
//   POST /parent/student/password         reset the student's password
//
// Only a parent login gets in. A student is sent to the dashboard and anyone
// else to the login page, for every /parent address and method.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { sendHtml, redirect, readForm } from './http-utils.js';
import { STATUSES } from './study-sessions.js';
import { buildParentModel } from './parent-model.js';
import { labelOf } from './rating-rules.js';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const NOTICES = new Set(['stale', 'invalid', 'password-changed']);

/**
 * @param {{
 *   store: any, auth: any, studySessions: any,
 *   answers: { list(userId: string): any[] } | null,   // lib/answer-log.js
 *   loadUi: () => Promise<{ views: any }>,
 *   currentUser: (req: any) => { user: any, sid?: string, expired: boolean },
 *   toLogin: (res: any, ctx: any) => void,
 *   homeFor: (user: any) => string,
 *   notFound: (res: any) => Promise<void>,
 * }} deps
 */
export function createParentRoutes(deps) {
  const { store, auth, studySessions, answers: answerLog, loadUi, currentUser, toLogin, homeFor, notFound } = deps;

  const studentOf = () => store.listUsers().find((u) => u.role === 'student') ?? null;

  async function renderPage(res, status, ctx, extra = {}) {
    const student = studentOf();
    studySessions.closeStale();
    let model;
    if (student) {
      const sessions = studySessions.list(student.id);
      const records = Object.fromEntries(sessions.map((s) => [s.id, studySessions.getRecord(s.id)]));
      const answers = answerLog ? answerLog.list(student.id) : [];
      model = buildParentModel({ user: ctx.user, student, sessions, records, answers, labelOf });
    } else {
      model = buildParentModel({ user: ctx.user, student: null, labelOf: () => ({ label: 'unrated' }) });
    }
    const { views } = await loadUi();
    sendHtml(res, status, views.renderParentHome({ ...model, ...extra }));
  }

  async function getParent(req, res, url, ctx) {
    const n = url.searchParams.get('notice');
    const saved = url.searchParams.get('saved');
    return renderPage(res, 200, ctx, {
      notice: NOTICES.has(n) ? n : null,
      savedId: saved && /^[0-9a-f]{1,64}$/.test(saved) ? saved : null,
    });
  }

  async function postRecord(req, res, id) {
    const form = await readForm(req);
    const student = studentOf();
    const session = studySessions.get(id);
    if (!student || !session || session.userId !== student.id) return redirect(res, '/parent?notice=invalid');
    if (!STATUSES.includes(form.status) || typeof form.note !== 'string' && form.note !== undefined) {
      return redirect(res, `/parent?notice=invalid#s-${id}`);
    }
    // The form carries the version it was drawn from; a newer save wins and this one is dropped.
    const current = studySessions.getRecord(id);
    if ((form.v ?? '') !== (current.updatedAt || '0')) return redirect(res, `/parent?notice=stale#s-${id}`);
    studySessions.setRecord(id, { status: form.status, note: form.note ?? '' });
    return redirect(res, `/parent?saved=${id}#s-${id}`);
  }

  async function postPassword(req, res, ctx) {
    const form = await readForm(req);
    const student = studentOf();
    if (!student) return redirect(res, '/parent?notice=invalid');
    const password = typeof form.password === 'string' ? form.password : '';
    const confirm = typeof form.confirm === 'string' ? form.confirm : '';
    /** @type {Record<string, string>} */
    const errors = {};
    if (password.length < MIN_PASSWORD_LENGTH) errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    else if (password.length > MAX_PASSWORD_LENGTH) errors.password = `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
    else if (confirm !== password) errors.confirm = 'The two passwords are different. Type the same one twice.';
    if (Object.keys(errors).length) return renderPage(res, 400, ctx, { passwordErrors: errors });
    writeUserPasswordHash(store, student.id, await auth.hash(password));
    return redirect(res, '/parent?notice=password-changed#student');
  }

  /**
   * Handles any /parent address. @returns {Promise<void>}
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
   * @param {URL} url @param {string} method
   */
  return async function handleParent(req, res, url, method) {
    const ctx = currentUser(req);
    if (!ctx.user || ctx.user.role !== 'parent') {
      if (method !== 'GET') req.resume();
      return ctx.user ? redirect(res, homeFor(ctx.user)) : toLogin(res, ctx);
    }
    const p = url.pathname;
    if (p === '/parent' && method === 'GET') return getParent(req, res, url, ctx);
    if (method === 'POST') {
      const m = /^\/parent\/sessions\/([0-9a-f]{1,64})\/record$/.exec(p);
      if (m) return postRecord(req, res, m[1]);
      if (p === '/parent/student/password') return postPassword(req, res, ctx);
      req.resume();
    }
    return notFound(res);
  };
}

/**
 * Sets one user's password hash in db.json.
 *
 * lib/store.js has no "change password" call and is not ours to edit, so this
 * writes db.json the same way the store does (temp file, fsync, rename, 0600)
 * and then tells the store to reload. The store is built for this: it already
 * picks up db.json changes made by other writers (scripts/seed-demo.js).
 * TODO after the merge: replace with a store.setPasswordHash(userId, hash).
 *
 * @param {{ file: string, reload(): void, getUser(id: string): any }} store
 * @param {string} userId @param {string} passwordHash
 */
export function writeUserPasswordHash(store, userId, passwordHash) {
  store.getUser(userId); // refresh from disk first
  const db = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  const user = Array.isArray(db.users) ? db.users.find((u) => u.id === userId) : null;
  if (!user) throw new Error('writeUserPasswordHash: unknown user');
  user.passwordHash = passwordHash;
  user.passwordChangedAt = new Date().toISOString();
  const tmp = `${store.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(db, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, store.file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  store.reload();
}
