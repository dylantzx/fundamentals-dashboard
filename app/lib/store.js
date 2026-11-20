// JSON-file store for users and progress.
// The whole database lives in `${dataDir}/db.json` and is held in memory.
// Every change is written atomically: write a temp file, fsync, then rename over db.json.
// Before each read or write the store stats db.json (cheap) and reloads it if
// another process (e.g. scripts/seed-demo.js) replaced it since the last load or save.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * @typedef {{ id: string, username: string, role: 'parent' | 'student', passwordHash: string, createdAt: string }} User
 * @typedef {{ topics: Record<string, { right: number, total: number }>, checksDone: number }} Progress
 * @typedef {{ version: 1, users: User[], progress: Record<string, Progress> }} Db
 */

const ROLES = new Set(['parent', 'student']);

/** @returns {Db} */
function emptyDb() {
  return { version: 1, users: [], progress: {} };
}

/** @returns {Progress} */
function defaultProgress() {
  return { topics: {}, checksDone: 0 };
}

/** @param {string} dataDir */
export function createStore(dataDir) {
  if (!dataDir) throw new Error('createStore: dataDir is required');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'db.json');

  /** Identity of db.json as last loaded/saved by this store: null = no file. @type {string | null} */
  let stamp = null;

  /**
   * Every atomic save is a rename, so the inode changes; mtime and size catch in-place edits.
   * @param {fs.Stats} st
   */
  const stampOf = (st) => `${st.ino}:${st.size}:${st.mtimeMs}`;

  /** @returns {string | null} */
  function statStamp() {
    try {
      return stampOf(fs.statSync(file));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
      throw err;
    }
  }

  // Stat before loading: if the file changes in between, the next refresh sees it.
  stamp = statStamp();
  /** @type {Db} */
  let db = load();

  /** Reloads db.json if it changed on disk since this store last loaded or saved it. */
  function refresh() {
    const now = statStamp();
    if (now === stamp) return;
    try {
      db = load();
    } catch {
      return; // unreadable right now: keep the in-memory copy and try again next time
    }
    stamp = now;
  }

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return emptyDb();
      throw err;
    }
    const parsed = JSON.parse(text);
    return {
      version: 1,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {},
    };
  }

  function save() {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    let written;
    try {
      fs.writeFileSync(fd, JSON.stringify(db, null, 2) + '\n');
      fs.fsyncSync(fd);
      written = stampOf(fs.fstatSync(fd)); // rename keeps inode, size and mtime
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
    stamp = written; // our own write: don't reload it next time
  }

  /** @param {User | undefined | null} u */
  const copy = (u) => (u ? { ...u } : null);

  return {
    /** Path of the JSON file (useful for tests and tooling). */
    file,

    hasUsers() {
      refresh();
      return db.users.length > 0;
    },

    /** @param {string} username */
    findUserByUsername(username) {
      if (typeof username !== 'string') return null;
      refresh();
      const wanted = username.trim().toLowerCase();
      if (!wanted) return null;
      return copy(db.users.find((u) => u.username.toLowerCase() === wanted));
    },

    /** @param {string} id */
    getUser(id) {
      refresh();
      return copy(db.users.find((u) => u.id === id));
    },

    /** @param {{ username: string, role: 'parent' | 'student', passwordHash: string }} input */
    addUser({ username, role, passwordHash }) {
      if (typeof username !== 'string' || !username.trim()) throw new Error('addUser: username is required');
      if (!ROLES.has(role)) throw new Error('addUser: role must be parent or student');
      if (typeof passwordHash !== 'string' || !passwordHash) throw new Error('addUser: passwordHash is required');
      if (this.findUserByUsername(username)) /* also refreshes */ throw new Error('addUser: username already taken');
      /** @type {User} */
      const user = {
        id: crypto.randomBytes(16).toString('hex'),
        username: username.trim(),
        role,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      try {
        save();
      } catch (err) {
        db.users.pop();
        throw err;
      }
      return { ...user };
    },

    listUsers() {
      refresh();
      return db.users.map((u) => ({ ...u }));
    },

    /** @param {string} userId @returns {Progress} */
    getProgress(userId) {
      refresh();
      const p = db.progress[userId];
      if (!p) return defaultProgress();
      return structuredClone(p);
    },

    /** @param {string} userId @param {Progress} progress */
    setProgress(userId, progress) {
      refresh();
      const prev = db.progress[userId];
      db.progress[userId] = structuredClone({
        topics: progress?.topics ?? {},
        checksDone: progress?.checksDone ?? 0,
      });
      try {
        save();
      } catch (err) {
        if (prev === undefined) delete db.progress[userId];
        else db.progress[userId] = prev;
        throw err;
      }
    },

    /** Re-read db.json from disk (e.g. after another process changed it). */
    reload() {
      stamp = statStamp();
      db = load();
    },
  };
}
