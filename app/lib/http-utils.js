// Small HTTP helpers: headers, responses, cookies, body parsing, static files.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_BODY_BYTES = 10 * 1024;

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

export const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
});

/** @param {import('node:http').ServerResponse} res */
export function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
export function sendHtml(res, status, body) {
  const buf = Buffer.from(String(body), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 */
export function sendText(res, status, text) {
  const buf = Buffer.from(text, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}

/**
 * 303 See Other, so a POST is followed by a GET.
 * @param {import('node:http').ServerResponse} res
 * @param {string} location  local path only
 */
export function redirect(res, location, status = 303) {
  res.statusCode = status;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', 0);
  res.end();
}

/** @param {string | undefined} header @returns {Record<string, string>} */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {{ maxAge?: number, path?: string }} [opts]
 */
export function serializeCookie(name, value, { maxAge, path: p = '/' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${p}; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) s += `; Max-Age=${Math.floor(maxAge)}`;
  return s;
}

export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Reads the request body, rejecting with HttpError(413) beyond `limit` bytes.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'Payload Too Large'));
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        req.resume();
        reject(new HttpError(413, 'Payload Too Large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/**
 * Reads and parses an application/x-www-form-urlencoded body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, string>>}
 */
export async function readForm(req, limit = MAX_BODY_BYTES) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const body = await readBody(req, limit);
  if (type && type !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Unsupported Media Type');
  /** @type {Record<string, string>} */
  const out = Object.create(null);
  for (const [k, v] of new URLSearchParams(body)) if (!(k in out)) out[k] = v;
  return out;
}

/**
 * Serves a file from `rootDir`. Returns false (and sends nothing) if the path
 * is unsafe or no such file exists, so the caller can send its 404 page.
 * @param {import('node:http').ServerResponse} res
 * @param {string} rootDir  absolute directory
 * @param {string} relUrlPath  the part of the URL path after the mount point (still percent-encoded)
 * @returns {Promise<boolean>}
 */
export async function serveStatic(res, rootDir, relUrlPath) {
  let rel;
  try {
    rel = decodeURIComponent(relUrlPath);
  } catch {
    return false;
  }
  if (!rel || rel.includes('\0') || rel.includes('\\')) return false;
  const segments = rel.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return false;

  const root = path.resolve(rootDir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return false;

  const type = CONTENT_TYPES[/** @type {keyof typeof CONTENT_TYPES} */ (path.extname(full).toLowerCase())];
  if (!type) return false;

  let realRoot, realFull, stat;
  try {
    realRoot = await fs.promises.realpath(root);
    realFull = await fs.promises.realpath(full);
    if (!realFull.startsWith(realRoot + path.sep)) return false;
    stat = await fs.promises.stat(realFull);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const data = await fs.promises.readFile(realFull);
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', data.length);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(data);
  return true;
}
