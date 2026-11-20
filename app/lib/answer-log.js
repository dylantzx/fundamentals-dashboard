// Append-only log of every finished question, one row per answer.
// Lives in its own file, `${dataDir}/answers.json`, next to the store's db.json.
// Every change is written atomically: write a temp file (mode 0600), fsync, then
// rename over answers.json. Before each read or write the log stats the file and
// reloads it if another process replaced it since this instance last loaded or saved.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * @typedef {{
 *   id: number,                      // 1, 2, 3 ... in the order added (ties in time are ordered by id)
 *   userId: string,
 *   topicId: string,                 // 't1' .. 't6'
 *   questionId: string,
 *   correct: boolean,                // right first time
 *   level: 'core' | 'exam',
 *   pool: 'practice' | 'check',
 *   at: number,                      // finish time, ms since the epoch
 * }} Answer
 * @typedef {{ version: 1, nextId: number, answers: Answer[] }} LogFile
 */

const LEVELS = new Set(['core', 'exam']);
const POOLS = new Set(['practice', 'check']);

/** @returns {LogFile} */
function emptyLog() {
  return { version: 1, nextId: 1, answers: [] };
}

const nonEmpty = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200;

/** @param {string} dataDir */
export function createAnswerLog(dataDir) {
  if (!dataDir) throw new Error('createAnswerLog: dataDir is required');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'answers.json');

  /** @param {fs.Stats} st */
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

  /** @returns {LogFile} */
  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return emptyLog();
      throw err;
    }
    const parsed = JSON.parse(text);
    const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
    const maxId = answers.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0);
    return { version: 1, nextId: Math.max(Number(parsed.nextId) || 1, maxId + 1), answers };
  }

  let stamp = statStamp();
  let log = load();

  function refresh() {
    const now = statStamp();
    if (now === stamp) return;
    try {
      log = load();
    } catch {
      return; // unreadable right now: keep the in-memory copy and try again next time
    }
    stamp = now;
  }

  function save() {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    let written;
    try {
      fs.writeFileSync(fd, JSON.stringify(log) + '\n');
      fs.fsyncSync(fd);
      written = stampOf(fs.fstatSync(fd));
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

  return {
    /** Path of the JSON file (useful for tests and tooling). */
    file,

    /**
     * Appends one finished question and returns it with its id.
     * @param {Omit<Answer, 'id'>} a
     * @returns {Answer}
     */
    add({ userId, topicId, questionId, correct, level, pool, at }) {
      if (!nonEmpty(userId)) throw new Error('answerLog.add: userId is required');
      if (!nonEmpty(topicId)) throw new Error('answerLog.add: topicId is required');
      if (!nonEmpty(questionId)) throw new Error('answerLog.add: questionId is required');
      if (typeof correct !== 'boolean') throw new Error('answerLog.add: correct must be true or false');
      if (!LEVELS.has(level)) throw new Error("answerLog.add: level must be 'core' or 'exam'");
      if (!POOLS.has(pool)) throw new Error("answerLog.add: pool must be 'practice' or 'check'");
      if (!Number.isFinite(at)) throw new Error('answerLog.add: at must be a time in ms');
      refresh();
      /** @type {Answer} */
      const answer = { id: log.nextId, userId, topicId, questionId, correct, level, pool, at };
      log.answers.push(answer);
      log.nextId += 1;
      try {
        save();
      } catch (err) {
        log.answers.pop();
        log.nextId -= 1;
        throw err;
      }
      return { ...answer };
    },

    /**
     * One user's answers, oldest first (in the order added).
     * @param {string} userId
     * @returns {Answer[]}
     */
    list(userId) {
      refresh();
      return log.answers.filter((a) => a.userId === userId).map((a) => ({ ...a }));
    },
  };
}
