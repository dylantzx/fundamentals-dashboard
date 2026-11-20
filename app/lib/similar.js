// "Questions like this one": ranks the other practice items in the bank by how
// close they are to a given one. Two signals, both cheap and explainable:
//   1. the syllabus tags they share: same subtopic, then same main topic of the printed
//      question (from the topic tags CSV), then any shared topic; and
//   2. how alike the wording is (TF-IDF cosine over stem, context, options, answers and
//      the question's one-line summary).
// Parts of the same printed question are left out: they are not "another" question.
// Each other printed question appears at most once (its closest part), so the list varies.
// Pure, no I/O.

import { topicCodeOf } from './syllabus.js';

const STOPWORDS = new Set(`a an and are as at be by can for from has have in is it its of on or that the this to was
which with what when why how use used using these those their there they them than then into also not no one two
each other does do which state give name explain describe suggest show shows shown fig figure table below above
following student students answer marks mark`.split(/\s+/));

const SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };

/** Lower-case word stems, with H₂O read as h2o so formulas match. */
export function tokens(text) {
  return String(text || '')
    .replace(/[₀-₉]/g, (c) => SUB[c])
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

/** A light stemmer: enough that "reacts", "reacting" and "reaction" meet. */
function stem(w) {
  if (w.length <= 4) return w;
  return w.replace(/(ations?|ions?|ing|ed|es|s)$/, '') || w;
}

/** Weight of each reason, so a shared subtopic always outranks similar wording alone. */
const W_SUBTOPIC = 3;
const W_MAIN = 1.5;
const W_TOPIC = 1;
const W_TEXT = 2;
const W_SAME_TYPE = 0.25;
/** Below this, wording alone is too weak to call two questions alike. */
const MIN_TEXT = 0.15;

/**
 * @param {Array<{ id: string, rootId: string, type: string, codeSet: Set<string>, searchText: string,
 *   summary?: string, mainTopic?: { code: string, name: string } | null }>} items
 */
export function buildSimilarity(items) {
  const docs = items.map((it) => {
    const tf = new Map();
    for (const t of tokens(`${it.searchText}\n${it.summary || ''}`)) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
  });
  const df = new Map();
  for (const tf of docs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = items.length;
  const vectors = docs.map((tf) => {
    const v = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * Math.log((n + 1) / (df.get(t) + 0.5));
      if (w <= 0) continue;
      v.set(t, w);
      norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  });
  const topicsOf = items.map((it) => new Set([...it.codeSet].map(topicCodeOf)));
  const index = new Map(items.map((it, i) => [it.id, i]));

  function cosine(a, b) {
    const [small, big] = a.v.size < b.v.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [t, w] of small.v) {
      const o = big.v.get(t);
      if (o) dot += w * o;
    }
    return dot / (a.norm * b.norm);
  }

  /**
   * The closest other questions, best first, each with why it was picked.
   * @param {string} id
   * @param {number} [limit]
   * @returns {Array<{ item: any, score: number, shared: string[], sharedTopics: string[], text: number }>}
   */
  function similar(id, limit = 5) {
    const i = index.get(id);
    if (i === undefined) return [];
    const me = items[i];
    const out = [];
    for (let j = 0; j < n; j++) {
      const other = items[j];
      if (other.rootId === me.rootId) continue;
      const shared = [...me.codeSet].filter((c) => other.codeSet.has(c));
      const sharedTopics = [...topicsOf[i]].filter((c) => topicsOf[j].has(c));
      const text = cosine(vectors[i], vectors[j]);
      const sameMain = !!(me.mainTopic?.code && me.mainTopic.code === other.mainTopic?.code);
      if (!shared.length && !sharedTopics.length && !sameMain && text < MIN_TEXT) continue;
      const score = W_SUBTOPIC * shared.length + (sameMain ? W_MAIN : 0) + W_TOPIC * sharedTopics.length
        + W_TEXT * text + (other.type === me.type ? W_SAME_TYPE : 0);
      out.push({ item: other, score, shared, sameMain, sharedTopics, text });
    }
    return bestPerQuestion(out, limit);
  }

  return { similar };
}

/**
 * Best first, keeping only the closest part of each printed question.
 * @template {{ item: { id: string, rootId: string }, score: number }} T
 * @param {T[]} list @param {number} limit @returns {T[]}
 */
export function bestPerQuestion(list, limit) {
  const sorted = [...list].sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const seen = new Set();
  const out = [];
  for (const s of sorted) {
    if (seen.has(s.item.rootId)) continue;
    seen.add(s.item.rootId);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}
