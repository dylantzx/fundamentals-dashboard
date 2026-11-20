// In-memory sessions with an idle timeout.

import crypto from 'node:crypto';

export const COOKIE_NAME = 'steady_sid';
export const IDLE_MS = 20 * 60 * 1000;

/**
 * @param {{ now?: () => number, idleMs?: number }} [opts]
 */
export function createSessions({ now = Date.now, idleMs = IDLE_MS } = {}) {
  /** @type {Map<string, { userId: string, lastSeen: number, meta?: any }>} */
  const map = new Map();

  // Expired sessions are kept for a while as tombstones so the next request can
  // still be told "you were logged out for being idle"; sweep drops old ones.
  const TOMBSTONE_MS = 24 * 60 * 60 * 1000;
  function sweep() {
    const t = now();
    for (const [id, s] of map) if (t - s.lastSeen > idleMs + TOMBSTONE_MS) map.delete(id);
  }

  return {
    /**
     * @param {string} userId
     * @param {any} [meta] kept with the session and handed back by touch/destroy (e.g. { studyId })
     * @returns {string} new session id (32 random bytes, hex)
     */
    create(userId, meta) {
      sweep();
      const id = crypto.randomBytes(32).toString('hex');
      map.set(id, { userId, lastSeen: now(), meta });
      return id;
    },

    /**
     * Looks up a session and refreshes its idle timer.
     * @param {string | undefined} id
     * @returns {{ status: 'ok', userId: string, meta?: any } | { status: 'expired', meta?: any } | { status: 'none' }}
     */
    touch(id) {
      if (!id || typeof id !== 'string') return { status: 'none' };
      const s = map.get(id);
      if (!s) return { status: 'none' };
      const t = now();
      if (t - s.lastSeen > idleMs) {
        map.delete(id);
        return { status: 'expired', meta: s.meta };
      }
      s.lastSeen = t;
      return { status: 'ok', userId: s.userId, meta: s.meta };
    },

    /** @param {string | undefined} id @returns {any} the ended session's meta, if any */
    destroy(id) {
      if (!id) return undefined;
      const s = map.get(id);
      map.delete(id);
      return s?.meta;
    },

    /** Ends every session of one account (a new login replaces them). @param {string} userId @returns {any[]} their metas */
    destroyUser(userId) {
      const metas = [];
      for (const [id, s] of map) if (s.userId === userId) { metas.push(s.meta); map.delete(id); }
      return metas;
    },

    get size() {
      return map.size;
    },
  };
}
