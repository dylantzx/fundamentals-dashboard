// The parent page's model: pure, no I/O.
//
// For each study session: time spent (login to last action), the longest pause,
// the questions answered in it and how many were right first time, the topics
// practised, and each topic's label at the start and at the end of the session.
// Answers belong to a session when their `at` falls between its start and its
// end (or its last action while it is still open). Labels come from the rating
// rules' labelOf(answers), run over every answer on that topic up to that moment.
//
// The answers' own content (which option he picked, what he wrote) is never read
// or passed on: only topic, right first time and time.

import { TOPICS, LABEL_TEXT } from './ratings.js';
import { toMs } from './study-sessions.js';

/** The test's pass mark (PRD 3 and 4): Stayed in at least 2 of 3 sessions. */
export const TARGET = Object.freeze({ stayed: 2, of: 3 });

const LABELS = new Set(['unrated', 'shaky', 'getting', 'solid']);

/**
 * @param {(answers: any[]) => { label: string }} labelOf
 * @param {any[]} answers
 */
function labelFrom(labelOf, answers) {
  let label = 'unrated';
  try {
    const out = labelOf(answers);
    if (out && LABELS.has(out.label)) label = out.label;
  } catch {
    /* a broken rating rule shows Not rated yet rather than breaking the page */
  }
  return { label, labelText: LABEL_TEXT[label] };
}

/**
 * @param {{
 *   user: { username: string },
 *   student: { id: string, username: string } | null,
 *   sessions: import('./study-sessions.js').StudySession[],      // the student's, any order
 *   records: Record<string, import('./study-sessions.js').ParentRecord>,
 *   answers: Array<{ topicId: string, correct: boolean, at: string | number }>,
 *   labelOf: (answers: any[]) => { label: string },
 * }} input
 */
export function buildParentModel({ user, student, sessions = [], records = {}, answers = [], labelOf }) {
  // Only what the page needs from each answer; never the answer itself.
  const log = answers
    .map((a) => ({ topicId: String(a.topicId ?? ''), correct: a.correct === true, atMs: toMs(a.at), src: a }))
    .filter((a) => Number.isFinite(a.atMs))
    .sort((a, b) => a.atMs - b.atMs);

  const topicOrder = new Map(TOPICS.map((t, i) => [t.id, i]));
  const topicName = (id) => TOPICS.find((t) => t.id === id)?.name ?? id;

  const rows = [...sessions]
    .sort((a, b) => toMs(b.startedAt) - toMs(a.startedAt))
    .map((s) => {
      const startMs = toMs(s.startedAt);
      const lastMs = toMs(s.lastActionAt);
      const endMs = s.endedAt ? toMs(s.endedAt) : lastMs;
      const inSession = log.filter((a) => a.atMs >= startMs && a.atMs <= endMs);
      const ids = [...new Set(inSession.map((a) => a.topicId))]
        .sort((a, b) => (topicOrder.get(a) ?? 99) - (topicOrder.get(b) ?? 99));
      const topics = ids.map((id) => {
        const mine = inSession.filter((a) => a.topicId === id);
        const before = log.filter((a) => a.topicId === id && a.atMs < startMs).map((a) => a.src);
        const after = log.filter((a) => a.topicId === id && a.atMs <= endMs).map((a) => a.src);
        return {
          id,
          name: topicName(id),
          answered: mine.length,
          rightFirstTime: mine.filter((a) => a.correct).length,
          start: labelFrom(labelOf, before),
          end: labelFrom(labelOf, after),
        };
      });
      const record = records[s.id] ?? { status: 'not_recorded', note: '', updatedAt: '' };
      return {
        id: s.id,
        startedAt: startMs,
        inProgress: !s.endedAt,
        endReason: s.endReason ?? null,
        timeSpentMs: Math.max(0, lastMs - startMs),
        longestPauseMs: Math.max(0, Number(s.longestPauseMs) || 0),
        answered: inSession.length,
        rightFirstTime: inSession.filter((a) => a.correct).length,
        topics,
        record: { status: record.status, note: record.note ?? '', version: record.updatedAt || '0' },
      };
    });

  const recorded = rows.filter((r) => r.record.status !== 'not_recorded').length;
  const stayed = rows.filter((r) => r.record.status === 'stayed').length;
  const wentToVideo = rows.filter((r) => r.record.status === 'went_to_video').length;
  const maxWent = TARGET.of - TARGET.stayed; // more than this and the target can't be met
  const summary = {
    stayed,
    recorded,
    wentToVideo,
    target: TARGET,
    state: stayed >= TARGET.stayed ? 'met' : wentToVideo > maxWent ? 'missed' : 'open',
    stayedNeeded: Math.max(0, TARGET.stayed - stayed),
  };

  return {
    user: { username: user.username },
    student: student ? { username: student.username } : null,
    summary,
    sessions: rows,
  };
}
