// Question-level MOE syllabus topics, hand-checked per printed question, from
// assets/chemistry_topic_tags.csv (branch add-chemistry-topic-tags). Each row is one
// top-level question in a school paper with its primary topic, any secondary topics
// and a one-line summary of what it tests. The bank's own tags are finer (subtopic
// codes per part); these say what a whole question is mainly about.

import fs from 'node:fs';

/**
 * @typedef {{ school: string, year: string, paper: string, question: string,
 *   primary: string, secondary: string[], summary: string }} TopicTag
 */

/**
 * The CSV's topic names are the syllabus topics, except that topic 2 (The Particulate
 * Nature of Matter) is split into its two halves. Name (lower case) -> syllabus code.
 */
const SPLIT_TOPICS = { 'kinetic particle theory': '2.1', 'atomic structure': '2.2' };

/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [head = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** @param {Record<string, string>[]} records @returns {TopicTag[]} */
export function toTopicTags(records) {
  return records
    .filter((r) => r.school && r.paper && r.question_no && r.primary_topic)
    .map((r) => ({
      school: r.school,
      year: String(r.year || ''),
      paper: r.paper.toUpperCase(),
      // "A3" / "B9" in section-lettered papers; the bank labels these "3" / "9".
      question: r.question_no.replace(/^[A-Z]/i, ''),
      primary: r.primary_topic,
      secondary: /^none\b/i.test(r.secondary_topics || '')
        ? []
        : String(r.secondary_topics || '').split(';').map((t) => t.trim()).filter(Boolean),
      summary: r.summary || '',
    }));
}

/**
 * @param {string | null | undefined} file
 * @param {(line: string) => void} [log]
 * @returns {TopicTag[]}
 */
export function loadTopicTags(file, log = () => {}) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    return toTopicTags(parseCsv(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    log(`topic tags not loaded from ${file}: ${err && err.message}`);
    return [];
  }
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The tag row for a top-level bank question, or null.
 * The CSV says "Montfort" where the bank says "Montfort Secondary School".
 * @param {TopicTag[]} tags
 * @param {{ school?: string, year?: string | number, paper: string, label: string }} q
 */
export function findTag(tags, q) {
  const school = squash(q.school);
  return tags.find((t) => school.startsWith(squash(t.school)) && (!q.year || t.year === String(q.year))
    && t.paper === String(q.paper).toUpperCase() && t.question === String(q.label)) || null;
}

/**
 * A CSV topic name as a place in the syllabus: { code, name } where code is the
 * topic ("10") or, for the halves of topic 2, the subtopic ("2.1").
 * @param {import('./syllabus.js').Syllabus} syllabus @param {string} name
 */
export function topicByName(syllabus, name) {
  const key = String(name).trim().toLowerCase();
  if (SPLIT_TOPICS[key]) return { code: SPLIT_TOPICS[key], name };
  for (const t of syllabus.topics.values()) if (t.name.toLowerCase() === key) return { code: t.code, name: t.name };
  return { code: '', name };
}
