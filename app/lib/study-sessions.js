// Study sessions and the parent's record of each one (PRD story 8, IMPL 3.2 and 7.5).
//
// A study session is one student login: it starts at login and ends at log out,
// after 20 minutes without an action (idle), or when the same account logs in
// again (replaced). Every request made with that login is an action: it moves
// lastActionAt and may grow longestPauseMs (the longest gap between two actions
// in a row; the login itself is the first action).
//
// The parent's record of a session (Stayed / Went to video / Not recorded, and a
// note) lives in the same file. No record means Not recorded.
//
// Everything is kept in `${dataDir}/study-sessions.json`, held in memory and
// written atomically on every change (temp file, fsync, rename; mode 0600).
// Times are stored as ISO strings; the clock is injected so tests move time.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const IDLE_MS = 20 * 60 * 1000;
export const NOTE_MAX = 1000;
export const STATUSES = Object.freeze(['not_recorded', 'stayed', 'went_to_video']);

/**
 * @typedef {'logout' | 'idle' | 'replaced'} EndReason
 * @typedef {{ id: string, userId: string, startedAt: string, lastActionAt: string,
 *             longestPauseMs: number, endedAt: string | null, endReason: EndReason | null }} StudySession
 * @typedef {{ status: 'not_recorded' | 'stayed' | 'went_to_video', note: string, updatedAt: string }} ParentRecord
 */

/** Milliseconds from an ISO string or a number; NaN if neither. @param {unknown} t */
export function toMs(t) {
  if (typeof t === 'number') return t;
  if (typeof t === 'string') return Date.parse(t);
  if (t instanceof Date) return t.getTime();
  return NaN;
}

/**
 * Normalises a note: CRLF -> LF (browsers send CRLF, but count LF against
 * maxlength), then capped at NOTE_MAX characters without splitting a surrogate pair.
 * @param {unknown} s
 */
export function cleanNote(s) {
  let note = String(s ?? '').replace(/\r\n?/g, '\n');
  if (note.length > NOTE_MAX) {
    note = note.slice(0, NOTE_MAX);
    if (/[\uD800-\uDBFF]$/.test(note)) note = note.slice(0, -1);
  }
  return note;
}

/**
 * @param {string} dataDir
 * @param {{ now?: () => number, idleMs?: number }} [opts]
 */
export function createStudySessions(dataDir, { now = Date.now, idleMs = IDLE_MS } = {}) {
  if (!dataDir) throw new Error('createStudySessions: dataDir is required');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'study-sessions.json');

  /** @type {{ version: 1, sessions: StudySession[], parentRecords: Record<string, ParentRecord> }} */
  let db = load();

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { version: 1, sessions: [], parentRecords: {} };
      throw err;
    }
    const parsed = JSON.parse(text);
    return {
      version: 1,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      parentRecords: parsed.parentRecords && typeof parsed.parentRecords === 'object' ? parsed.parentRecords : {},
    };
  }

  function save() {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(db, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  /** Runs a change and saves it; on a failed save the in-memory copy is put back. @param {() => any} fn */
  function change(fn) {
    const before = structuredClone(db);
    const out = fn();
    try {
      save();
    } catch (err) {
      db = before;
      throw err;
    }
    return out;
  }

  const iso = (ms) => new Date(ms).toISOString();
  const find = (id) => (typeof id === 'string' ? db.sessions.find((s) => s.id === id) : undefined);
  const copy = (s) => (s ? { ...s } : null);

  /** Closes one open session in memory (no save). The idle end is at the 20-minute mark. */
  function closeIn(s, reason, at) {
    if (!s || s.endedAt) return false;
    const last = toMs(s.lastActionAt);
    const end = reason === 'idle' ? Math.min(at, last + idleMs) : at;
    s.endedAt = iso(Math.max(end, last));
    s.endReason = reason;
    return true;
  }

  /** Closes, in memory, every open session whose 20 minutes have passed. */
  function closeStaleIn(t) {
    let n = 0;
    for (const s of db.sessions) if (!s.endedAt && t - toMs(s.lastActionAt) > idleMs && closeIn(s, 'idle', t)) n++;
    return n;
  }

  return {
    file,

    /**
     * A student logged in: closes stale sessions (idle) and this account's other
     * open sessions (replaced), then starts a new one.
     * @param {string} userId @returns {StudySession}
     */
    start(userId) {
      return change(() => {
        const t = now();
        closeStaleIn(t);
        for (const s of db.sessions) if (s.userId === userId && !s.endedAt) closeIn(s, 'replaced', t);
        /** @type {StudySession} */
        const s = {
          id: crypto.randomBytes(12).toString('hex'),
          userId,
          startedAt: iso(t),
          lastActionAt: iso(t),
          longestPauseMs: 0,
          endedAt: null,
          endReason: null,
        };
        db.sessions.push(s);
        return { ...s };
      });
    },

    /**
     * One action made with this login. Ignored for unknown or ended sessions.
     * @param {string} id @returns {StudySession | null}
     */
    action(id) {
      const s = find(id);
      if (!s || s.endedAt) return null;
      return change(() => {
        const t = Math.max(now(), toMs(s.lastActionAt));
        const gap = t - toMs(s.lastActionAt);
        s.lastActionAt = iso(t);
        if (gap > s.longestPauseMs) s.longestPauseMs = gap;
        return { ...s };
      });
    },

    /**
     * Ends a session. For `idle` the end is the 20-minute mark after the last action.
     * Ending an ended or unknown session does nothing.
     * @param {string} id @param {EndReason} reason @returns {boolean}
     */
    end(id, reason) {
      const s = find(id);
      if (!s || s.endedAt) return false;
      return change(() => closeIn(s, reason, now()));
    },

    /** Closes every open session whose 20 minutes have passed (on start, login and the parent page). */
    closeStale() {
      const t = now();
      if (!db.sessions.some((s) => !s.endedAt && t - toMs(s.lastActionAt) > idleMs)) return 0;
      return change(() => closeStaleIn(t));
    },

    /**
     * Closes every open session, as after a restart: the in-memory logins are gone.
     * Each ends at the 20-minute mark or now, whichever is earlier.
     */
    closeAllOpen() {
      if (!db.sessions.some((s) => !s.endedAt)) return 0;
      return change(() => {
        const t = now();
        let n = 0;
        for (const s of db.sessions) if (closeIn(s, 'idle', t)) n++;
        return n;
      });
    },

    /** @param {string} id */
    get(id) {
      return copy(find(id));
    },

    /** A student's sessions, newest first. @param {string} userId */
    list(userId) {
      return db.sessions
        .filter((s) => s.userId === userId)
        .map((s) => ({ ...s }))
        .sort((a, b) => toMs(b.startedAt) - toMs(a.startedAt));
    },

    /** The parent's record for a session (Not recorded if there is none). @param {string} sessionId @returns {ParentRecord} */
    getRecord(sessionId) {
      const r = Object.hasOwn(db.parentRecords, sessionId) ? db.parentRecords[sessionId] : null;
      return r ? { ...r } : { status: 'not_recorded', note: '', updatedAt: '' };
    },

    /**
     * Saves the parent's record. The note is normalised and capped at 1000 characters.
     * @param {string} sessionId @param {{ status: string, note?: string }} input
     * @returns {ParentRecord}
     */
    setRecord(sessionId, { status, note = '' }) {
      if (!find(sessionId)) throw new Error('setRecord: unknown session');
      if (!STATUSES.includes(status)) throw new Error('setRecord: bad status');
      return change(() => {
        const prev = Object.hasOwn(db.parentRecords, sessionId) ? db.parentRecords[sessionId] : null;
        // updatedAt doubles as the version the form posts back, so it always moves forward.
        let t = now();
        if (prev && toMs(prev.updatedAt) >= t) t = toMs(prev.updatedAt) + 1;
        /** @type {ParentRecord} */
        const rec = { status: /** @type {ParentRecord['status']} */ (status), note: cleanNote(note), updatedAt: iso(t) };
        db.parentRecords[sessionId] = rec;
        return { ...rec };
      });
    },
  };
}
