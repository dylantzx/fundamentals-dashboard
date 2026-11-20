// Password hashing with scrypt.
// Stored format: scrypt$N$r$p$saltHex$hashHex  (16-byte random salt, 32-byte key)

import crypto from 'node:crypto';

export const DEFAULT_SCRYPT_N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

/** @returns {number} N from env STEADY_SCRYPT_N, else the default. */
export function scryptNFromEnv(env = process.env) {
  const n = Number(env.STEADY_SCRYPT_N);
  return isValidN(n) ? n : DEFAULT_SCRYPT_N;
}

/** @param {number} n */
function isValidN(n) {
  return Number.isInteger(n) && n >= 2 && n <= 2 ** 20 && (n & (n - 1)) === 0;
}

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} N
 * @param {number} r
 * @param {number} p
 * @returns {Promise<Buffer>}
 */
function scrypt(password, salt, N, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * @param {string} password
 * @param {{ N?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function hashPassword(password, { N = DEFAULT_SCRYPT_N } = {}) {
  if (typeof password !== 'string') throw new TypeError('password must be a string');
  if (!isValidN(N)) throw new RangeError('scrypt N must be a power of two');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('hex'), key.toString('hex')].join('$');
}

/** @param {string} stored */
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!isValidN(N) || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (!/^[0-9a-f]+$/i.test(parts[4]) || !/^[0-9a-f]+$/i.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'hex');
  const hash = Buffer.from(parts[5], 'hex');
  if (salt.length < 8 || hash.length !== KEYLEN) return null;
  return { N, r, p, salt, hash };
}

/**
 * Constant-time check of a password against a stored hash.
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed || typeof password !== 'string') return false;
  const key = await scrypt(password, parsed.salt, parsed.N, parsed.r, parsed.p);
  return key.length === parsed.hash.length && crypto.timingSafeEqual(key, parsed.hash);
}

/**
 * Creates an authenticator bound to a store and an N.
 * For an unknown username it still runs one scrypt (against a dummy hash) so
 * response time does not reveal whether the account exists.
 * @param {{ findUserByUsername(u: string): any }} store
 * @param {{ N?: number }} [opts]
 */
export function createAuthenticator(store, { N = DEFAULT_SCRYPT_N } = {}) {
  /** @type {Promise<string> | null} */
  let dummyHash = null;
  const getDummy = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'), { N }));

  return {
    /** Exposed for tests: how many scrypt verifications were run. */
    stats: { verifications: 0 },

    /**
     * @param {string} username
     * @param {string} password
     * @returns {Promise<any | null>} the user, or null
     */
    async authenticate(username, password) {
      const user = typeof username === 'string' ? store.findUserByUsername(username) : null;
      const stored = user ? user.passwordHash : await getDummy();
      this.stats.verifications++;
      const ok = await verifyPassword(typeof password === 'string' ? password : '', stored);
      return user && ok ? user : null;
    },

    /** @param {string} password */
    hash(password) {
      return hashPassword(password, { N });
    },
  };
}
