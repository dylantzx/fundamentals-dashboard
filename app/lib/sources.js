// Recommended study sources: free, no-login pages for each topic, kept in
// content/sources.json and checked by hand. Pure loader and validator: a broken
// file stops the app from starting, with a plain message saying what is wrong.

import fs from 'node:fs';
import { TOPICS } from './ratings.js';

/** Kinds of source, in the order the /learn page shows them. No videos. */
export const SOURCE_TYPES = Object.freeze(['notes', 'syllabus', 'interactive']);

/** How many sources each topic must have. */
export const MIN_PER_TOPIC = 2;
export const MAX_PER_TOPIC = 4;

const REQUIRED = ['title', 'publisher', 'url', 'type', 'why', 'checkedOn'];
const TOPIC_IDS = new Set(TOPICS.map((t) => t.id));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{ title: string, publisher: string, url: string, type: 'notes' | 'syllabus' | 'interactive',
 *   why: string, checkedOn: string, caution?: string }} Source
 * @typedef {{ checkedOn: string, topics: Record<string, Source[]> }} Sources
 */

export class SourcesError extends Error {
  /** @param {string[]} problems */
  constructor(problems, file = 'content/sources.json') {
    super(`Steady can't start: ${file} has a problem.\n  - ${problems.join('\n  - ')}`);
    this.name = 'SourcesError';
    this.problems = problems;
  }
}

/** True for an absolute https:// URL with a host and no user name or password. */
export function isSafeUrl(u) {
  if (typeof u !== 'string' || /\s/.test(u)) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 400;

/**
 * Lists everything wrong with the parsed file. An empty list means it is fine.
 * @param {any} data @returns {string[]}
 */
export function validateSources(data) {
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['the file must hold one JSON object'];
  if (!DATE_RE.test(String(data.checkedOn ?? ''))) problems.push('"checkedOn" must be a date like 2026-11-20');
  const topics = data.topics;
  if (!topics || typeof topics !== 'object' || Array.isArray(topics)) return [...problems, '"topics" must be an object keyed by topic id'];

  for (const id of Object.keys(topics)) {
    if (!TOPIC_IDS.has(id)) problems.push(`unknown topic id "${id}" (expected one of ${[...TOPIC_IDS].join(', ')})`);
  }
  for (const id of TOPIC_IDS) {
    const list = topics[id];
    if (!Array.isArray(list)) {
      problems.push(`topic ${id} has no list of sources`);
      continue;
    }
    if (list.length < MIN_PER_TOPIC || list.length > MAX_PER_TOPIC) {
      problems.push(`topic ${id} has ${list.length} sources; it needs ${MIN_PER_TOPIC} to ${MAX_PER_TOPIC}`);
    }
    list.forEach((s, i) => {
      const where = `${id} source ${i + 1}`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        problems.push(`${where} is not an object`);
        return;
      }
      for (const f of REQUIRED) if (!text(s[f])) problems.push(`${where} is missing "${f}"`);
      if (text(s.url) && !isSafeUrl(s.url)) problems.push(`${where} has a bad url (it must start with https://)`);
      if (text(s.type) && !SOURCE_TYPES.includes(s.type)) {
        problems.push(`${where} has type "${s.type}"; allowed: ${SOURCE_TYPES.join(', ')}`);
      }
      if (text(s.checkedOn) && !DATE_RE.test(s.checkedOn)) problems.push(`${where} "checkedOn" must be a date like 2026-11-20`);
      if (s.caution !== undefined && !text(s.caution)) problems.push(`${where} has an empty "caution"`);
    });
  }
  return problems;
}

/**
 * Validates and returns a clean, frozen copy.
 * @param {any} data @param {string} [file] @returns {Sources}
 */
export function parseSources(data, file) {
  const problems = validateSources(data);
  if (problems.length) throw new SourcesError(problems, file);
  /** @type {Record<string, Source[]>} */
  const topics = {};
  for (const { id } of TOPICS) {
    topics[id] = Object.freeze(data.topics[id].map((s) => Object.freeze({
      title: s.title.trim(),
      publisher: s.publisher.trim(),
      url: s.url.trim(),
      type: s.type,
      why: s.why.trim(),
      checkedOn: s.checkedOn,
      ...(s.caution ? { caution: s.caution.trim() } : {}),
    })));
  }
  return Object.freeze({ checkedOn: data.checkedOn, topics: Object.freeze(topics) });
}

/**
 * Reads content/sources.json. Throws a SourcesError (plain message) if it is
 * missing, not JSON, or fails the checks above.
 * @param {string} file @returns {Sources}
 */
export function loadSources(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new SourcesError([`the file could not be read at ${file}`], file);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new SourcesError([`it is not valid JSON (${err.message})`], file);
  }
  return parseSources(data, file);
}
