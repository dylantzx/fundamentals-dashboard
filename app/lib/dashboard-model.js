// Builds everything the student dashboard shows from a user and their progress.
// Pure: no I/O, no clock, no randomness.
//
// Ratings come from the per-answer log (lib/answer-log.js) when the user has
// logged answers: PRD 6.2 labels over the latest five, PRD 6.3 Next up and
// PRD 6.5 Chemistry label (lib/rating-rules.js). With an empty log they come
// from the older `progress` right/total counts (seed-demo and the demo site),
// labelled by lib/ratings.js; Next up and the Chemistry label follow the same
// PRD 6.3 / 6.5 rules either way.
import { TOPICS, LABEL_TEXT, MIN_ANSWERS, labelFor } from './ratings.js';
import { labelOf, weakest, chemistryLabel } from './rating-rules.js';

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

/** Whole number >= 0, or 0 for anything else. */
function count(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Overall Chemistry label (PRD 6.5, see chemistryLabel in lib/rating-rules.js):
 * null until all six topics are rated. Shaky 1, Getting there 2, Solid 3,
 * added up: 6-9 Shaky, 10-14 Getting there, 15-18 Solid, and never Solid
 * while any topic is Shaky. The returning sample is 1+1 + 2+2+2 + 3 = 11:
 * "Getting there".
 * @param {string[]} labels one label per topic
 * @returns {'shaky' | 'getting' | 'solid' | null}
 */
export function overallLabel(labels) {
  return chemistryLabel(labels).label;
}

/**
 * One topic's label and right/total. From the log: the latest five (right
 * first time / looked at). Otherwise from the progress counts.
 * @returns {{ label: string, right: number, total: number }}
 */
function scoreOf(topicId, logged, scores) {
  if (logged) {
    const r = labelOf(logged.filter((a) => a && a.topicId === topicId));
    return { label: r.label, right: r.right, total: r.lookedAt };
  }
  const s = scores[topicId] || {};
  const total = count(s.total);
  const right = Math.min(count(s.right), total);
  return { label: labelFor({ right, total }), right, total };
}

/**
 * @param {{
 *   user: { username: string },
 *   progress?: { topics?: Record<string, { right: number, total: number }>, checksDone?: number },
 *   answers?: Array<{ id: any, topicId: string, correct: boolean, level: string, pool: string, at: number }>,
 * }} input  answers: this user's answer log (lib/answer-log.js list(userId)); empty or missing = use progress
 */
export function buildDashboardModel({ user, progress, answers }) {
  const scores = (progress && progress.topics) || {};
  const checksDone = Math.min(count(progress && progress.checksDone), CHECKS_TOTAL);
  const logged = Array.isArray(answers) && answers.length > 0 ? answers : null;

  const topics = TOPICS.map((t) => {
    const { label, right, total } = scoreOf(t.id, logged, scores);
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

  // PRD 6.3 rules 1 and 2: the lowest label from Shaky, Not rated yet, Getting
  // there, Solid; a tie goes to the earlier topic. While nothing is rated at
  // all the checks are the main action, so there is no Next up.
  const next = rated.length ? topics[weakest(topics.map((t) => t.label))] : null;
  const nextUp = next && {
    id: next.id,
    name: next.name,
    label: next.label,
    labelText: next.labelText,
    right: next.right,
    total: next.total,
    needMore: next.needMore,
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
