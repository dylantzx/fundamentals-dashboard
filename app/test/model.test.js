import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardModel, overallLabel } from '../lib/dashboard-model.js';
import { DEMO_PROGRESS } from '../scripts/seed-demo.js';

const user = { id: 'abc', username: 'jun_wei', role: 'student', passwordHash: 'x' };
const build = (progress) => buildDashboardModel({ user, progress });
const summary = (m) => m.topics.map((t) => `${t.labelText}${t.label === 'unrated' ? '' : ` ${t.right}/${t.total}`}`);

test('eight subjects in order, only Chemistry active', () => {
  const m = build({ topics: {}, checksDone: 0 });
  assert.deepEqual(m.subjects.map((s) => s.name), [
    'English', 'Mother Tongue', 'E Math', 'A Math', 'Chemistry', 'Physics', 'Biology', 'Combined Humanities',
  ]);
  assert.deepEqual(m.subjects.filter((s) => s.active).map((s) => s.name), ['Chemistry']);
});

test('user exposes only the username', () => {
  assert.deepEqual(build({ topics: {}, checksDone: 0 }).user, { username: 'jun_wei' });
});

test('first-time seed matches landing-first-time.html', () => {
  const m = build(DEMO_PROGRESS['first-time']);
  assert.equal(m.state, 'first-time');
  assert.equal(m.checksDone, 0);
  assert.equal(m.checksTotal, 6);
  assert.equal(m.nextUp, null);
  assert.deepEqual(m.nextCheck, { n: 1, href: '/check/1', questions: 3, minutes: 3 });
  assert.ok(m.topics.every((t) => t.label === 'unrated' && t.labelText === 'Not rated yet' && t.needMore === 3));
  assert.deepEqual(m.topics.map((t) => t.href), ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => `/practise/${id}`));
  assert.deepEqual(m.chemistry, { label: null, labelText: null, breakdown: { shaky: 0, getting: 0, solid: 0, unrated: 6 } });
});

test('a missing progress object is treated as first-time', () => {
  assert.equal(buildDashboardModel({ user }).state, 'first-time');
});

test('part-way seed matches landing-part-way.html', () => {
  const m = build(DEMO_PROGRESS['part-way']);
  assert.equal(m.state, 'part-way');
  assert.equal(m.checksDone, 2);
  assert.deepEqual(summary(m), ['Solid 3/3', 'Shaky 1/3', 'Not rated yet', 'Not rated yet', 'Not rated yet', 'Not rated yet']);
  assert.deepEqual(m.topics.map((t) => t.needMore), [0, 0, 2, 3, 3, 3]);
  assert.equal(m.nextUp.name, 'Electron arrangement');
  assert.deepEqual(m.nextCheck, { n: 3, href: '/check/3', questions: 3, minutes: 3 });
  assert.deepEqual(m.chemistry, { label: null, labelText: null, breakdown: { shaky: 1, getting: 0, solid: 1, unrated: 4 } });
});

test('returning seed reproduces landing.html exactly', () => {
  const m = build(DEMO_PROGRESS.returning);
  assert.equal(m.state, 'returning');
  assert.equal(m.checksDone, 6);
  assert.deepEqual(summary(m), [
    'Solid 4/5', 'Getting there 3/5', 'Shaky 1/3', 'Shaky 2/5', 'Getting there 2/4', 'Getting there 2/3',
  ]);
  assert.deepEqual(m.nextUp, {
    id: 't3', name: 'Isotopes', label: 'shaky', labelText: 'Shaky', right: 1, total: 3, needMore: 0,
    href: '/practise/t3', minutes: 10, questions: 5,
  });
  assert.equal(m.nextCheck, null);
  assert.deepEqual(m.chemistry, {
    label: 'getting', labelText: 'Getting there', breakdown: { shaky: 2, getting: 3, solid: 1, unrated: 0 },
  });
});

test('part-way when practice rated a topic but no check is done', () => {
  const m = build({ topics: { t4: { right: 3, total: 3 } }, checksDone: 0 });
  assert.equal(m.state, 'part-way');
  // PRD 6.3: Not rated yet comes before Solid, so the first unrated topic is Next up.
  assert.equal(m.nextUp.id, 't1');
  assert.equal(m.nextUp.needMore, 3);
});

test('part-way when checks are done but nothing is rated yet', () => {
  const m = build({ topics: { t1: { right: 1, total: 2 } }, checksDone: 1 });
  assert.equal(m.state, 'part-way');
  assert.equal(m.nextUp, null);
  assert.equal(m.topics[0].needMore, 1);
});

test('next up (PRD 6.3): Shaky, then Not rated yet, then Getting there, then Solid', () => {
  const m = build({
    topics: { t1: { right: 3, total: 3 }, t2: { right: 2, total: 3 }, t3: { right: 0, total: 1 } },
    checksDone: 2,
  });
  assert.equal(m.nextUp.id, 't3'); // Not rated yet beats Getting there (t2) and Solid (t1)
  assert.equal(m.nextUp.needMore, 2);
  const s = build({
    topics: { t1: { right: 3, total: 3 }, t2: { right: 2, total: 3 }, t3: { right: 0, total: 1 }, t6: { right: 0, total: 3 } },
    checksDone: 2,
  });
  assert.equal(s.nextUp.id, 't6'); // Shaky beats everything
});

test('next up tie-break is list order, not score', () => {
  const m = build({
    topics: { t2: { right: 2, total: 5 }, t5: { right: 0, total: 5 }, t1: { right: 5, total: 5 } },
    checksDone: 3,
  });
  assert.equal(m.nextUp.id, 't2');
  // PRD 6.3: unrated t1 outranks the two Getting there topics.
  const g = build({ topics: { t6: { right: 2, total: 3 }, t4: { right: 3, total: 4 } }, checksDone: 3 });
  assert.equal(g.nextUp.id, 't1');
  // With every topic rated, the Getting there tie goes to the earlier topic.
  const solid = { right: 3, total: 3 };
  const all = build({
    topics: { t1: solid, t2: solid, t3: solid, t5: solid, t6: { right: 2, total: 3 }, t4: { right: 3, total: 4 } },
    checksDone: 6,
  });
  assert.equal(all.nextUp.id, 't4');
});

test('needMore counts down to 0 as answers come in', () => {
  const needs = [0, 1, 2, 3, 4].map((total) => build({ topics: { t1: { right: 0, total } }, checksDone: 1 }).topics[0].needMore);
  assert.deepEqual(needs, [3, 2, 1, 0, 0]);
});

test('nextCheck runs 1..6 then null', () => {
  const seq = [0, 1, 2, 3, 4, 5, 6].map((checksDone) => build({ topics: {}, checksDone }).nextCheck?.n ?? null);
  assert.deepEqual(seq, [1, 2, 3, 4, 5, 6, null]);
  assert.equal(build({ topics: {}, checksDone: 9 }).checksDone, 6);
});

test('overall label (PRD 6.5): shaky=1, getting=2, solid=3 added; 6-9 Shaky, 10-14 Getting there, 15-18 Solid', () => {
  const s = 'shaky', g = 'getting', o = 'solid';
  assert.equal(overallLabel([s, s, g, g, g, o]), 'getting'); // 11
  assert.equal(overallLabel([s, s, s, s, s, g]), 'shaky'); // 7
  assert.equal(overallLabel([s, s, s, g, g, g]), 'shaky'); // 9
  assert.equal(overallLabel([g, g, g, o, o, o]), 'solid'); // 15
  assert.equal(overallLabel([s, g, o, o, o, o]), 'getting'); // 15, but one Shaky
  assert.equal(overallLabel([s, s, s, s, g, g]), 'shaky'); // 8/6 = 1.33
  assert.equal(overallLabel([o, o, o, o, o, o]), 'solid');
  assert.equal(overallLabel([o, o, o, o, o, 'unrated']), null);
});

test('overall label stays null until all six are rated', () => {
  const topics = { ...DEMO_PROGRESS.returning.topics, t6: { right: 2, total: 2 } };
  const m = build({ topics, checksDone: 6 });
  assert.equal(m.state, 'part-way');
  assert.equal(m.chemistry.label, null);
});

test('bad numbers are cleaned up', () => {
  const m = build({ topics: { t1: { right: 9, total: 3 }, t2: { right: -1, total: 'x' } }, checksDone: -2 });
  assert.deepEqual([m.topics[0].right, m.topics[0].label], [3, 'solid']);
  assert.deepEqual([m.topics[1].right, m.topics[1].total, m.topics[1].needMore], [0, 0, 3]);
  assert.equal(m.checksDone, 0);
});

test('the model does not alias the seed data or shared constants', () => {
  const a = build(DEMO_PROGRESS.returning);
  a.subjects[0].name = 'changed';
  assert.equal(build(DEMO_PROGRESS.returning).subjects[0].name, 'English');
});

// ---- ratings from the answer log (PRD 6.2) ----------------------------------

let logId = 0;
const logged = (topicId, marks, level = 'exam') => [...marks].map((m) => {
  logId += 1;
  return { id: logId, userId: 'abc', topicId, questionId: `q${logId}`, correct: m === 'R', level, pool: 'practice', at: logId * 1000 };
});

test('with logged answers, labels and right/total come from the latest five in the log', () => {
  const answers = [...logged('t1', 'WWRRRR'), ...logged('t2', 'RRRR', 'core'), ...logged('t3', 'RW')];
  // The progress counts disagree on purpose: the log wins.
  const m = buildDashboardModel({ user, progress: { topics: { t1: { right: 0, total: 9 } }, checksDone: 1 }, answers });
  assert.deepEqual(summary(m), ['Solid 4/5', 'Getting there 4/4', 'Not rated yet', 'Not rated yet', 'Not rated yet', 'Not rated yet']);
  assert.deepEqual(m.topics.map((t) => t.needMore), [0, 0, 1, 3, 3, 3]);
  assert.equal(m.nextUp.id, 't3'); // PRD 6.3: Not rated yet before Getting there
  assert.equal(m.checksDone, 1); // checks done still come from progress
});

test('with logged answers, the Chemistry label follows PRD 6.5', () => {
  const answers = ['t1', 't2', 't3', 't4', 't5', 't6'].flatMap((t, i) => logged(t, i === 0 ? 'WWW' : 'RRR'));
  const m = buildDashboardModel({ user, progress: { topics: {}, checksDone: 6 }, answers });
  // 1 + 3*5 = 16 points, but one topic is Shaky: Getting there.
  assert.equal(m.state, 'returning');
  assert.deepEqual([m.chemistry.label, m.nextUp.id], ['getting', 't1']);
});

test('an empty answer log falls back to the progress counts', () => {
  assert.deepEqual(
    buildDashboardModel({ user, progress: DEMO_PROGRESS.returning, answers: [] }),
    build(DEMO_PROGRESS.returning),
  );
});
