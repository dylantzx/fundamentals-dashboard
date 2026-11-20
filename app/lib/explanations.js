// Why an answer is right or wrong: hand-written explanations kept in
// content/explanations.json, keyed by question-bank id. Steady is offline,
// so these are written ahead of time, not generated while the student waits.

import fs from 'node:fs';

/**
 * @typedef {{ why: string, wrongNotes: Record<string, string>, slips: string[] }} Explanation
 */

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/**
 * Keeps only well-formed fields, so a bad entry shows less rather than breaking a page.
 * @param {any} e @returns {Explanation | null}
 */
export function cleanExplanation(e) {
  if (!e || typeof e !== 'object') return null;
  const why = str(e.why);
  /** @type {Record<string, string>} */
  const wrongNotes = {};
  if (e.wrongNotes && typeof e.wrongNotes === 'object') {
    for (const [k, v] of Object.entries(e.wrongNotes)) if (/^[A-D]$/.test(k) && str(v)) wrongNotes[k] = str(v);
  }
  const slips = Array.isArray(e.slips) ? e.slips.map(str).filter(Boolean) : [];
  if (!why && !Object.keys(wrongNotes).length && !slips.length) return null;
  return { why, wrongNotes, slips };
}

/**
 * @param {string} file path to explanations.json
 * @returns {Map<string, Explanation>} empty if the file is missing
 */
export function loadExplanations(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = new Map();
  for (const [id, e] of Object.entries(data.questions || {})) {
    const clean = cleanExplanation(e);
    if (clean) out.set(id, clean);
  }
  return out;
}
