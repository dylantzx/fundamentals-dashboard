// In-memory sessions with an idle timeout.

import crypto from 'node:crypto';

export const COOKIE_NAME = 'steady_sid';
export const IDLE_MS = 20 * 60 * 1000;

/**
 * @param {{ now?: () => number, idleMs?: number }} [opts]
 */
export function createSessions({ now = Date.now, idleMs = IDLE_MS } = {}) {
  /** @type {Map<string, { userId: string, lastSeen: number }>} */
  const map = new Map();

  // Expired sessions are kept for a while as tombstones so the next request can
  // still be told "you were logged out for being idle"; sweep drops old ones.
  const TOMBSTONE_MS = 24 * 60 * 60 * 1000;
  function sweep() {
    const t = now();
    for (const [id, s] of map) if (t - s.lastSeen > idleMs + TOMBSTONE_MS) map.delete(id);
  }

  return {
    /** @param {string} userId @returns {string} new session id (32 random bytes, hex) */
    create(userId) {
      sweep();
      const id = crypto.randomBytes(32).toString('hex');
      map.set(id, { userId, lastSeen: now() });
      return id;
    },

    /**
     * Looks up a session and refreshes its idle timer.
     * @param {string | undefined} id
     * @returns {{ status: 'ok', userId: string } | { status: 'expired' } | { status: 'none' }}
     */
    touch(id) {
      if (!id || typeof id !== 'string') return { status: 'none' };
      const s = map.get(id);
      if (!s) return { status: 'none' };
      const t = now();
      if (t - s.lastSeen > idleMs) {
        map.delete(id);
        return { status: 'expired' };
      }
      s.lastSeen = t;
      return { status: 'ok', userId: s.userId };
    },

    /** @param {string | undefined} id */
    destroy(id) {
      if (id) map.delete(id);
    },

    get size() {
      return map.size;
    },
  };
}
