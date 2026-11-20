// The real question bank: loads question-bank/export.json (see question-bank/HANDOFF.md)
// and turns it into practice items for Steady's six Chemistry topics.
//
// Rules from HANDOFF.md that this module enforces:
//   - only top-level questions with tree_review_status "ok" are ever shown;
//   - a part is shown with its ancestors' stems (`context`) and its ancestors' figures.

import fs from 'node:fs';
import path from 'node:path';

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
 */
export function loadQuestionBank(bankDir) {
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
        items.push(toItem(node, root, paper, ancestors, parentFigures, ownFigures));
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
    /** One line describing where the questions come from. */
    sourceLine() {
      const p = [...papers.values()][0];
      return p ? `${p.school} · ${p.exam}` : 'Exam papers';
    },
  };
}

function toItem(node, root, paper, ancestors, parentFigures, ownFigures) {
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
  };
}
