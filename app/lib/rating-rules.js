// The rating rules of PRD section 6.2, 6.3 (rules 1 and 2) and 6.5.
// Pure: plain data in, plain data out. No I/O, no clock, no randomness.
//
// Input answers have the shape lib/answer-log.js stores:
//   { id, topicId, questionId, correct /* right first time */, level: 'core'|'exam', pool: 'practice'|'check', at /* ms */ }

/** @typedef {'unrated' | 'shaky' | 'getting' | 'solid'} Label */

/** Finished questions looked at (PRD 6.2 "latest five"). */
export const LOOK_AT = 5;
/** Fewer than this many finished questions: Not rated yet. */
export const MIN_TO_RATE = 3;
/** Exam-level right answers Solid needs. */
export const EXAM_FOR_SOLID = 2;

/**
 * PRD 6.2 table, by how many were looked at: the fewest right answers for
 * Getting there and for Solid.
 */
const THRESHOLDS = Object.freeze({
  5: Object.freeze({ getting: 3, solid: 4 }),
  4: Object.freeze({ getting: 2, solid: 4 }),
  3: Object.freeze({ getting: 2, solid: 3 }),
});

/** PRD 6.3 rule 1, lowest first: Shaky, Not rated yet, Getting there, Solid. */
export const WEAKNESS_RANK = Object.freeze({ shaky: 0, unrated: 1, getting: 2, solid: 3 });

/** PRD 6.5 points. */
const POINTS = Object.freeze({ shaky: 1, getting: 2, solid: 3 });

/** Orders ids: whole numbers as numbers (so 9 before 10), anything else as strings. */
export function compareIds(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
    const d = Number(sa) - Number(sb);
    if (d !== 0) return d;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Finish order, oldest first: by `at`, equal times by id (IMPL 5.1). */
function byFinish(a, b) {
  return (Number(a.at) || 0) - (Number(b.at) || 0) || compareIds(a.id, b.id);
}

/**
 * R6.2: the label of one topic from its finished questions, practice and
 * check together. Looks at the latest five; there is no time input, so
 * labels cannot fade. Never mutates the input.
 *
 * @param {Array<{ id: any, correct: boolean, level?: string, at: number }>} answers one topic's answers
 * @returns {{ label: Label, lookedAt: number, right: number, examRight: number, heldBack: boolean }}
 *   heldBack: true when the right count reached Solid but fewer than two of them were Exam level.
 */
export function labelOf(answers) {
  const latest = [...(answers || [])].filter((a) => a != null).sort(byFinish).slice(-LOOK_AT);
  const lookedAt = latest.length;
  const rightOnes = latest.filter((a) => a.correct === true);
  const right = rightOnes.length;
  const examRight = rightOnes.filter((a) => a.level === 'exam').length;
  if (lookedAt < MIN_TO_RATE) return { label: 'unrated', lookedAt, right, examRight, heldBack: false };
  const t = THRESHOLDS[lookedAt];
  if (right >= t.solid) {
    return examRight >= EXAM_FOR_SOLID
      ? { label: 'solid', lookedAt, right, examRight, heldBack: false }
      : { label: 'getting', lookedAt, right, examRight, heldBack: true };
  }
  return { label: right >= t.getting ? 'getting' : 'shaky', lookedAt, right, examRight, heldBack: false };
}

/** Accepts a label string or a `{ label }` object (e.g. a labelOf result). */
function nameOf(l) {
  const s = l == null ? 'unrated' : typeof l === 'string' ? l : l.label;
  return Object.hasOwn(WEAKNESS_RANK, s) ? s : 'unrated';
}

/**
 * R6.3 rules 1 and 2: the index of the weakest topic. Lowest label wins in the
 * order Shaky, Not rated yet, Getting there, Solid; a tie goes to the earlier
 * topic in the list. Null for an empty list.
 *
 * @param {Array<Label | { label: Label }>} labels in topic order
 * @returns {number | null}
 */
export function weakest(labels) {
  let best = null;
  (labels || []).forEach((l, i) => {
    if (best === null || WEAKNESS_RANK[nameOf(l)] < WEAKNESS_RANK[nameOf(labels[best])]) best = i;
  });
  return best;
}

/**
 * R6.5: the overall Chemistry label. Shaky 1, Getting there 2, Solid 3, added
 * over the six topics: 6-9 Shaky, 10-14 Getting there, 15-18 Solid. No label
 * (null) until all six are rated. Never Solid while any topic is Shaky:
 * Getting there instead. Also returns how many are rated and the weakest
 * topic's index, so the card can always name it.
 *
 * @param {Array<Label | { label: Label }>} labels the six topic labels, in topic order
 * @returns {{ label: 'shaky' | 'getting' | 'solid' | null, rated: number, total: number | null, weakest: number | null }}
 */
export function chemistryLabel(labels) {
  const names = (labels || []).map(nameOf);
  const rated = names.filter((n) => Object.hasOwn(POINTS, n)).length;
  const weak = weakest(names);
  if (names.length !== 6 || rated < 6) return { label: null, rated, total: null, weakest: weak };
  const total = names.reduce((sum, n) => sum + POINTS[n], 0);
  let label = total <= 9 ? 'shaky' : total <= 14 ? 'getting' : 'solid';
  if (label === 'solid' && names.includes('shaky')) label = 'getting';
  return { label, rated, total, weakest: weak };
}
