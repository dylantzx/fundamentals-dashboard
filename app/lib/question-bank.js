// The real question bank: loads question-bank/export.json (see question-bank/HANDOFF.md)
// and turns it into practice items for Steady's six Chemistry topics.
//
// Rules from HANDOFF.md that this module enforces:
//   - only top-level questions with tree_review_status "ok" are ever shown;
//   - a part is shown with its ancestors' stems (`context`) and its ancestors' figures.

import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_SYLLABUS, placeInSyllabus, topicCodeOf, compareCodes } from './syllabus.js';
import { buildSimilarity, bestPerQuestion } from './similar.js';
import { findTag, topicByName } from './topic-tags.js';

/**
 * How Steady's six topics map onto the 6092 syllabus codes the bank is tagged with.
 * The bank tags atomic structure, isotopes and electron arrangement with one code
 * (2.2), so t1-t3 are split by what the question is about.
 */
const ISOTOPE_RE = /isotop|relative atomic mass/i;
const SHELL_RE = /\bshells?\b|electronic configuration|electron arrangement|outer electrons/i;

/** @type {Record<string, (codes: Set<string>, text: string) => boolean>} */
export const TOPIC_RULES = {
  t1: (c, text) => c.has('2.2') && !ISOTOPE_RE.test(text) && !SHELL_RE.test(text),
  t2: (c, text) => c.has('2.2') && SHELL_RE.test(text),
  t3: (c, text) => c.has('2.2') && ISOTOPE_RE.test(text),
  t4: (c) => c.has('3.1'),
  t5: (c) => c.has('3.2'),
  t6: (c) => c.has('3.3') || c.has('3.4'),
};

/** Table crops duplicate the transcribed Markdown tables and MCQ options, so those are hidden. */
export function showFigure(fig, node) {
  if (fig.kind !== 'table') return true;
  const hasTextTable = /^\s*\|.*\|\s*$/m.test(node.stem || '');
  return !(hasTextTable || (node.options && node.options.length));
}

/**
 * @param {string} bankDir folder holding export.json and assets/
 * @param {{
 *   explanations?: Map<string, import('./explanations.js').Explanation>,
 *   syllabus?: import('./syllabus.js').Syllabus,
 *   topicTags?: import('./topic-tags.js').TopicTag[],
 * }} [opts]
 *   explanations: why each answer is right or wrong, by question id (see lib/explanations.js);
 *   syllabus: the 6092 topic list, so tags read "Topic 10 Rate of Reactions" (see lib/syllabus.js);
 *   topicTags: each printed question's main and other topics, and a summary (see lib/topic-tags.js)
 */
export function loadQuestionBank(bankDir, opts = {}) {
  const explanations = opts.explanations ?? new Map();
  const syllabus = opts.syllabus ?? EMPTY_SYLLABUS;
  const topicTags = opts.topicTags ?? [];
  const exportPath = path.join(bankDir, 'export.json');
  const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));

  /** paper key "P1" -> paper metadata */
  const papers = new Map();
  for (const doc of data.documents || []) {
    for (const p of doc.papers || []) papers.set(`${doc.id}:${p.paper}`, { ...p, documentId: doc.id });
  }

  const roots = (data.questions || []).filter((q) => q.tree_review_status === 'ok' && q.review_status !== 'needs_review');

  /** Every practice item: an MCQ, or a structured part with a mark scheme. */
  const items = [];
  /** id -> top-level question (for the browse pages) */
  const rootsById = new Map();

  for (const root of roots) {
    rootsById.set(root.id, root);
    const paper = papers.get(`${root.document_id}:${root.paper}`) || { paper: root.paper };
    walk(root, []);

    function walk(node, ancestors) {
      if (node.review_status === 'needs_review') return;
      const answerable = node.type === 'mcq' || (node.type === 'structured' && (node.answers || []).length);
      if (answerable) {
        const parentFigures = ancestors.flatMap((a) => (a.assets?.figures || []).filter((f) => showFigure(f, a)));
        const ownFigures = (node.assets?.figures || []).filter((f) => showFigure(f, node));
        items.push(toItem(node, root, paper, ancestors, parentFigures, ownFigures, explanations.get(node.id) || null));
      }
      for (const child of node.children || []) walk(child, [...ancestors, node]);
    }
  }

  const byId = new Map(items.map((it) => [it.id, it]));

  /** @type {Record<string, any[]>} */
  const byTopic = {};
  for (const tid of Object.keys(TOPIC_RULES)) {
    byTopic[tid] = items.filter((it) => TOPIC_RULES[tid](it.codeSet, it.searchText));
  }
  /** rootId -> what the whole printed question is about (from the topic tags CSV) */
  const aboutRoot = new Map();
  for (const root of roots) {
    const paper = papers.get(`${root.document_id}:${root.paper}`) || {};
    const tag = findTag(topicTags, { school: paper.school, year: paper.year, paper: root.paper, label: root.label });
    aboutRoot.set(root.id, tag
      ? { main: topicByName(syllabus, tag.primary), also: tag.secondary.map((n) => topicByName(syllabus, n)), summary: tag.summary }
      : { main: null, also: [], summary: '' });
  }
  for (const it of items) {
    it.syllabus = it.topics.map((t) => placeInSyllabus(syllabus, t));
    it.syllabusTitle = syllabus.title;
    const about = aboutRoot.get(it.rootId);
    it.rootLabel = rootsById.get(it.rootId).label;
    it.mainTopic = about.main;
    it.alsoTopics = about.also;
    it.summary = about.summary;
    it.steadyTopics = Object.keys(TOPIC_RULES).filter((tid) => byTopic[tid].includes(it));
  }

  const { similar } = buildSimilarity(items);
  const itemsByRoot = Map.groupBy(items, (it) => it.rootId);

  /**
   * Every question tagged with a syllabus code (a subtopic "10.2" or a whole topic "10"),
   * or whose printed question has it as its main topic.
   * @param {string} code
   */
  function forSyllabus(code) {
    const isTopic = !String(code).includes('.');
    const onCode = (c) => (isTopic ? topicCodeOf(c) === code : c === code);
    return items.filter((it) => [...it.codeSet].some(onCode) || (it.mainTopic?.code && onCode(it.mainTopic.code)));
  }

  /**
   * The syllabus topics that have questions in the bank, in syllabus order,
   * each with its subtopics and how many questions are tagged with them.
   */
  const syllabusIndex = (() => {
    const counts = new Map();
    const names = new Map();
    for (const it of items) {
      for (const p of it.syllabus) {
        counts.set(p.subtopic.code, (counts.get(p.subtopic.code) || 0) + 1);
        names.set(p.subtopic.code, p);
      }
    }
    const topics = new Map();
    for (const code of [...counts.keys()].sort(compareCodes)) {
      const p = names.get(code);
      if (!topics.has(p.topic.code)) topics.set(p.topic.code, { ...p.topic, count: 0, subtopics: [] });
      const t = topics.get(p.topic.code);
      t.subtopics.push({ ...p.subtopic, count: forSyllabus(code).length });
    }
    for (const t of topics.values()) t.count = forSyllabus(t.code).length;
    return [...topics.values()];
  })();

  return {
    bankDir,
    assetsDir: path.join(bankDir, data.assets_root || 'assets'),
    exportedAt: data.exported_at,
    papers: [...papers.values()],
    items,
    roots,
    /** @param {string} id */
    item: (id) => byId.get(id) || null,
    /** @param {string} id */
    root: (id) => rootsById.get(id) || null,
    /** @param {string} topicId @returns {any[]} */
    forTopic: (topicId) => byTopic[topicId] || [],
    syllabusTitle: syllabus.title,
    /** Syllabus topics and subtopics that have questions, with counts. */
    syllabusIndex,
    /**
     * Every question tagged with a syllabus code: a subtopic ("10.2") or a whole topic ("10").
     * @param {string} code
     */
    forSyllabus,
    /** @param {string} rootId what a whole printed question is about: { main, also, summary } */
    about: (rootId) => aboutRoot.get(rootId) || { main: null, also: [], summary: '' },
    syllabus,
    /** Questions like this practice item, best first, from other printed questions. */
    similar,
    /**
     * Questions like any part of this top-level question, best first (one per other question).
     * @param {string} rootId @param {number} [limit]
     */
    similarToRoot(rootId, limit = 5) {
      return bestPerQuestion((itemsByRoot.get(rootId) || []).flatMap((it) => similar(it.id, limit)), limit);
    },
    /** One line describing where the questions come from. */
    sourceLine() {
      const p = [...papers.values()][0];
      return p ? `${p.school} · ${p.exam}` : 'Exam papers';
    },
  };
}

function toItem(node, root, paper, ancestors, parentFigures, ownFigures, explanation) {
  const codes = (node.topics || []).map((t) => t.code);
  const answers = node.answers || [];
  const text = [
    ...(node.context || []).map((c) => (typeof c === 'string' ? c : c?.stem || '')),
    node.stem || '',
    ...(node.options || []).map((o) => o.text),
    ...answers.map((a) => a.answer_text || ''),
  ].join('\n');
  return {
    id: node.id,
    rootId: root.id,
    label: node.label,
    type: node.type,
    paper: root.paper,
    paperName: paper.paper_code ? `Paper ${root.paper.replace(/^P/, '')} (${paper.paper_code})` : root.paper,
    source: paper.school ? `${paper.school}, ${paper.exam}` : '',
    marks: node.marks ?? answers.reduce((s, a) => s + (a.marks || 0), 0),
    answerSpace: node.answer_space,
    // Ancestors' stems, outermost first. The export gives [{ label, stem }].
    context: (node.context?.length ? node.context : ancestors)
      .map((c) => (typeof c === 'string' ? c : c?.stem))
      .filter(Boolean),
    stem: node.stem || '',
    options: node.options || [],
    correctOption: answers.find((a) => a.correct_option)?.correct_option || null,
    markScheme: answers.map((a) => ({ text: a.answer_text, marks: a.marks, crops: a.crops || [] })),
    parentFigures,
    ownFigures,
    regions: node.assets?.regions || [],
    fullQuestion: (root.assets?.full_question || []),
    topics: node.topics || [],
    codeSet: new Set(codes),
    searchText: text,
    hasHandwriting: !!node.has_handwriting,
    /** Why the answer is right (and each wrong option wrong), or null if none is written yet. */
    explanation,
  };
}
