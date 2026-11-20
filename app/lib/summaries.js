// In-app topic summaries: Steady's own short explanation of each topic
// (big idea, key points, a worked example, a common mistake, illustrations),
// kept in content/summaries.json. Pure loader and validator: a broken file
// stops the app from starting, with a plain message, like content/sources.json.

import fs from 'node:fs';
import { TOPICS } from './ratings.js';

const TOPIC_IDS = new Set(TOPICS.map((t) => t.id));

/**
 * @typedef {{
 *   bigIdea: string,
 *   keyPoints: string[],
 *   example: { question: string, steps: string[], answer: string },
 *   mistake: { wrong: string, right: string },
 *   illustrations: string[],
 * }} Summary
 */

export class SummariesError extends Error {
  /** @param {string[]} problems */
  constructor(problems, file = 'content/summaries.json') {
    super(`Steady can't start: ${file} has a problem.\n  - ${problems.join('\n  - ')}`);
    this.name = 'SummariesError';
    this.problems = problems;
  }
}

const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 600;
const textList = (v, min, max) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(text);

/**
 * Lists everything wrong with the parsed file. An empty list means it is fine.
 * @param {any} data
 * @param {{ illustrationIds?: Iterable<string> }} [opts] known drawing ids; unchecked if omitted
 * @returns {string[]}
 */
export function validateSummaries(data, { illustrationIds } = {}) {
  const known = illustrationIds ? new Set(illustrationIds) : null;
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['the file must hold one JSON object'];
  const topics = data.topics;
  if (!topics || typeof topics !== 'object' || Array.isArray(topics)) return ['"topics" must be an object keyed by topic id'];
  for (const id of Object.keys(topics)) if (!TOPIC_IDS.has(id)) problems.push(`unknown topic id "${id}"`);

  for (const id of TOPIC_IDS) {
    const s = topics[id];
    if (!s || typeof s !== 'object') {
      problems.push(`topic ${id} has no summary`);
      continue;
    }
    if (!text(s.bigIdea)) problems.push(`${id} is missing "bigIdea"`);
    if (!textList(s.keyPoints, 3, 5)) problems.push(`${id} "keyPoints" must be 3 to 5 short texts`);
    const ex = s.example;
    if (!ex || !text(ex.question) || !textList(ex.steps, 1, 6) || !text(ex.answer)) {
      problems.push(`${id} "example" needs a question, 1 to 6 steps and an answer`);
    }
    const m = s.mistake;
    if (!m || !text(m.wrong) || !text(m.right)) problems.push(`${id} "mistake" needs "wrong" and "right"`);
    if (!Array.isArray(s.illustrations) || s.illustrations.length < 1 || s.illustrations.length > 2) {
      problems.push(`${id} "illustrations" must list 1 or 2 drawings`);
    } else if (known) {
      for (const ill of s.illustrations) if (!known.has(ill)) problems.push(`${id} names an unknown illustration "${ill}"`);
    }
  }
  return problems;
}

/**
 * Validates and returns a clean, frozen copy.
 * @param {any} data @param {{ illustrationIds?: Iterable<string>, file?: string }} [opts]
 * @returns {Record<string, Summary>}
 */
export function parseSummaries(data, opts = {}) {
  const problems = validateSummaries(data, opts);
  if (problems.length) throw new SummariesError(problems, opts.file);
  const out = {};
  for (const { id } of TOPICS) {
    const s = data.topics[id];
    out[id] = Object.freeze({
      bigIdea: s.bigIdea.trim(),
      keyPoints: Object.freeze(s.keyPoints.map((p) => p.trim())),
      example: Object.freeze({
        question: s.example.question.trim(),
        steps: Object.freeze(s.example.steps.map((p) => p.trim())),
        answer: s.example.answer.trim(),
      }),
      mistake: Object.freeze({ wrong: s.mistake.wrong.trim(), right: s.mistake.right.trim() }),
      illustrations: Object.freeze([...s.illustrations]),
    });
  }
  return Object.freeze(out);
}

/**
 * Reads content/summaries.json. Throws a SummariesError (plain message) if it
 * is missing, not JSON, or fails the checks above.
 * @param {string} file @param {{ illustrationIds?: Iterable<string> }} [opts]
 */
export function loadSummaries(file, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new SummariesError([`the file could not be read at ${file}`], file);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new SummariesError([`it is not valid JSON (${err.message})`], file);
  }
  return parseSummaries(data, { ...opts, file });
}
