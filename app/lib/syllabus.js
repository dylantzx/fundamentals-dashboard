// The MOE / SEAB O-Level Chemistry (6092) syllabus the question bank is tagged with,
// read from taxonomy/o_level_chemistry_6092.json. It turns a subtopic code such as
// "10.2" into its place in the syllabus: "Topic 10 Chemical Kinetics › 10.2 Factors
// affecting rate and collision theory". Pure apart from the one file read.

import fs from 'node:fs';

/** Syllabus codes look like "10" (a topic) or "10.2" (a subtopic). */
export const CODE_RE = /^\d{1,2}(\.\d{1,2})?$/;

/**
 * @typedef {{ code: string, name: string }} Named
 * @typedef {{ title: string, topics: Map<string, Named & { subtopics: Named[] }>, subtopics: Map<string, Named & { topic: string }> }} Syllabus
 */

/** An empty syllabus: codes still work, they just have no topic names. */
export const EMPTY_SYLLABUS = Object.freeze({ title: 'O-Level Chemistry (6092)', topics: new Map(), subtopics: new Map() });

/**
 * @param {string | null | undefined} file
 * @param {(line: string) => void} [log]
 * @returns {Syllabus}
 */
export function loadSyllabus(file, log = () => {}) {
  if (!file || !fs.existsSync(file)) return EMPTY_SYLLABUS;
  try {
    return parseSyllabus(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    log(`syllabus not loaded from ${file}: ${err && err.message}`);
    return EMPTY_SYLLABUS;
  }
}

/** @param {any} data the taxonomy JSON @returns {Syllabus} */
export function parseSyllabus(data) {
  const topics = new Map();
  const subtopics = new Map();
  for (const t of data?.topics || []) {
    if (!CODE_RE.test(String(t.code)) || typeof t.name !== 'string') continue;
    const subs = (t.subtopics || [])
      .filter((s) => CODE_RE.test(String(s.code)) && typeof s.name === 'string')
      .map((s) => ({ code: String(s.code), name: s.name }));
    topics.set(String(t.code), { code: String(t.code), name: t.name, subtopics: subs });
    for (const s of subs) subtopics.set(s.code, { ...s, topic: String(t.code) });
  }
  const m = /O-Level Chemistry\s*(\d{4})/i.exec(data?.syllabus || '');
  return { title: m ? `O-Level Chemistry (${m[1]})` : EMPTY_SYLLABUS.title, topics, subtopics };
}

/** "10.2" -> "10" */
export const topicCodeOf = (code) => String(code).split('.')[0];

/** Natural order for codes: 2.2 before 10.1. */
export function compareCodes(a, b) {
  const [a1, a2 = 0] = String(a).split('.').map(Number);
  const [b1, b2 = 0] = String(b).split('.').map(Number);
  return a1 - b1 || a2 - b2;
}

/**
 * Where a tagged subtopic sits in the syllabus.
 * @param {Syllabus} syllabus
 * @param {{ code: string, name?: string }} tag a topic tag from the bank
 * @returns {{ topic: Named, subtopic: Named }}
 */
export function placeInSyllabus(syllabus, tag) {
  const code = String(tag.code);
  const sub = syllabus.subtopics.get(code);
  const tc = topicCodeOf(code);
  const topic = syllabus.topics.get(tc);
  return {
    topic: { code: tc, name: topic?.name || '' },
    subtopic: { code, name: sub?.name || tag.name || '' },
  };
}

/** Drops the bracketed examples from a long subtopic name: "Oxides (acidic, basic)" -> "Oxides". */
export const shortTopicName = (n) => String(n || '').replace(/\s*\(.*\)\s*$/, '');
