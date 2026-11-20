// Builds everything the student dashboard shows from a user and their progress.
// Pure: no I/O, no clock, no randomness.
import { TOPICS, LABEL_TEXT, MIN_ANSWERS, labelFor } from './ratings.js';

export const CHECKS_TOTAL = 6;

/**
 * The eight subjects, in the PRD's subject-list order (PRD section 12), using
 * the short names from the mockups. Only Chemistry is live.
 */
export const SUBJECTS = Object.freeze([
  Object.freeze({ id: 'english', name: 'English', active: false }),
  Object.freeze({ id: 'mother-tongue', name: 'Mother Tongue', active: false }),
  Object.freeze({ id: 'e-math', name: 'E Math', active: false }),
  Object.freeze({ id: 'a-math', name: 'A Math', active: false }),
  Object.freeze({ id: 'chemistry', name: 'Chemistry', active: true }),
  Object.freeze({ id: 'physics', name: 'Physics', active: false }),
  Object.freeze({ id: 'biology', name: 'Biology', active: false }),
  Object.freeze({ id: 'combined-humanities', name: 'Combined Humanities', active: false }),
]);

/** Next-up order: lower rank is weaker. Unrated topics are never Next up. */
const RANK = { shaky: 0, getting: 1, solid: 2 };
/** Points for the overall Chemistry label. */
const POINTS = { shaky: 1, getting: 2, solid: 3 };
const BY_POINTS = { 1: 'shaky', 2: 'getting', 3: 'solid' };

/** Whole number >= 0, or 0 for anything else. */
function count(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Overall Chemistry label (PRD 6.5): null until all six topics are rated.
 * Then score each topic Shaky = 1, Getting there = 2, Solid = 3, take the
 * average over the six, and round to the nearest whole number with halves
 * rounding up (1.5 -> Getting there, 2.5 -> Solid). The returning sample is
 * 1+1 + 2+2+2 + 3 = 11 points, 11 / 6 = 1.83, which rounds to 2: "Getting there".
 * @param {string[]} labels one label per topic
 * @returns {'shaky' | 'getting' | 'solid' | null}
 */
export function overallLabel(labels) {
  if (labels.length !== TOPICS.length || labels.some((l) => !(l in POINTS))) return null;
  const avg = labels.reduce((sum, l) => sum + POINTS[l], 0) / labels.length;
  return BY_POINTS[Math.round(avg)];
}

/**
 * @param {{ user: { username: string }, progress?: { topics?: Record<string, { right: number, total: number }>, checksDone?: number } }} input
 */
export function buildDashboardModel({ user, progress }) {
  const scores = (progress && progress.topics) || {};
  const checksDone = Math.min(count(progress && progress.checksDone), CHECKS_TOTAL);

  const topics = TOPICS.map((t) => {
    const s = scores[t.id] || {};
    const total = count(s.total);
    const right = Math.min(count(s.right), total);
    const label = labelFor({ right, total });
    return {
      id: t.id,
      n: t.n,
      name: t.name,
      label,
      labelText: LABEL_TEXT[label],
      right,
      total,
      needMore: label === 'unrated' ? MIN_ANSWERS - total : 0,
      href: `/practise/${t.id}`,
    };
  });

  const rated = topics.filter((t) => t.label !== 'unrated');
  const state =
    rated.length === topics.length ? 'returning'
    : checksDone === 0 && rated.length === 0 ? 'first-time'
    : 'part-way';

  // Weakest rated topic; on a tie the earlier topic in the list (PRD 6.3 rule 2).
  let next = null;
  for (const t of rated) if (!next || RANK[t.label] < RANK[next.label]) next = t;
  const nextUp = next && {
    id: next.id,
    name: next.name,
    label: next.label,
    labelText: next.labelText,
    right: next.right,
    total: next.total,
    href: next.href,
    minutes: 10,
    questions: 5,
  };

  const nextCheck =
    checksDone < CHECKS_TOTAL
      ? { n: checksDone + 1, href: `/check/${checksDone + 1}`, questions: 3, minutes: 3 }
      : null;

  const breakdown = { shaky: 0, getting: 0, solid: 0, unrated: 0 };
  for (const t of topics) breakdown[t.label] += 1;
  const overall = overallLabel(topics.map((t) => t.label));

  return {
    user: { username: user.username },
    state,
    checksDone,
    checksTotal: CHECKS_TOTAL,
    topics,
    nextUp,
    nextCheck,
    chemistry: {
      label: overall,
      labelText: overall ? LABEL_TEXT[overall] : null,
      breakdown,
    },
    subjects: SUBJECTS.map((s) => ({ ...s })),
  };
}
