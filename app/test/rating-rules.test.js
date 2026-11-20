// PRD 6.2, 6.3 (rules 1 and 2) and 6.5. Each test title starts with its rule id (IMPL 5.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { labelOf, weakest, chemistryLabel } from '../lib/rating-rules.js';

let nextId = 1;
/** One finished answer. `at` defaults to 1000 * id so rows are in order. */
function answer(correct, { level = 'exam', pool = 'practice', at, id } = {}) {
  const i = id ?? nextId++;
  return { id: i, userId: 'u', topicId: 't1', questionId: `q${i}`, correct, level, pool, at: at ?? i * 1000 };
}
/** n looked at, `right` of them right first time (the right ones last), all Exam. */
const history = (n, right) => Array.from({ length: n }, (_, k) => answer(k >= n - right));

test('R6.2-5 five looked at: 0, 1, 2 right Shaky; 3 Getting there; 4, 5 Solid', () => {
  const want = ['shaky', 'shaky', 'shaky', 'getting', 'solid', 'solid'];
  want.forEach((label, right) => {
    const r = labelOf(history(5, right));
    assert.deepEqual([r.label, r.lookedAt, r.right], [label, 5, right], `${right} right of 5`);
  });
});

test('R6.2-4 four looked at: 0, 1 Shaky; 2, 3 Getting there; 4 Solid', () => {
  const want = ['shaky', 'shaky', 'getting', 'getting', 'solid'];
  want.forEach((label, right) => {
    const r = labelOf(history(4, right));
    assert.deepEqual([r.label, r.lookedAt, r.right], [label, 4, right], `${right} right of 4`);
  });
});

test('R6.2-3 three looked at: 0, 1 Shaky; 2 Getting there; 3 Solid', () => {
  const want = ['shaky', 'shaky', 'getting', 'solid'];
  want.forEach((label, right) => {
    const r = labelOf(history(3, right));
    assert.deepEqual([r.label, r.lookedAt, r.right], [label, 3, right], `${right} right of 3`);
  });
});

test('R6.2-lt3 0, 1 or 2 finished: Not rated yet, even all right', () => {
  for (const n of [0, 1, 2]) {
    const r = labelOf(history(n, n));
    assert.deepEqual([r.label, r.lookedAt], ['unrated', n], `${n} finished`);
  }
  assert.equal(labelOf(undefined).label, 'unrated');
});

test('R6.2-exam 4 or 5 right with fewer than two Exam among them is Getting there (at 5, 4 and 3 looked at)', () => {
  const five = [
    answer(false, { level: 'exam' }),
    answer(true, { level: 'exam' }),
    answer(true, { level: 'core' }),
    answer(true, { level: 'core' }),
    answer(true, { level: 'core' }),
  ];
  let r = labelOf(five); // 5 looked at, 4 right, 1 Exam
  assert.deepEqual([r.label, r.right, r.examRight, r.heldBack], ['getting', 4, 1, true]);
  r = labelOf([answer(true, { level: 'core', at: 0 }), ...five.slice(1)]); // 5 right, 1 Exam
  assert.deepEqual([r.label, r.right, r.examRight, r.heldBack], ['getting', 5, 1, true]);
  r = labelOf(five.slice(1)); // 4 looked at, 4 right, 1 Exam
  assert.deepEqual([r.label, r.lookedAt, r.heldBack], ['getting', 4, true]);
  r = labelOf(five.slice(2)); // 3 looked at, 3 right, 0 Exam
  assert.deepEqual([r.label, r.lookedAt, r.examRight, r.heldBack], ['getting', 3, 0, true]);
  // Two Exam among the right ones: Solid. A wrong Exam answer does not count towards it.
  r = labelOf([...five.slice(0, 4), answer(true, { level: 'exam' })]);
  assert.deepEqual([r.label, r.examRight, r.heldBack], ['solid', 2, false]);
});

test('R6.2-latest a sixth finished question pushes out the oldest', () => {
  const five = [answer(false), answer(true), answer(true), answer(true), answer(false)];
  assert.equal(labelOf(five).label, 'getting');
  const r = labelOf([...five, answer(true)]);
  assert.deepEqual([r.lookedAt, r.right, r.label], [5, 4, 'solid']); // the oldest wrong one dropped out
});

test('R6.2-mix quick-check and practice answers count together', () => {
  const mixed = [answer(true, { pool: 'check' }), answer(true, { pool: 'check' }), answer(true, { pool: 'practice' })];
  assert.deepEqual([labelOf(mixed).lookedAt, labelOf(mixed).label], [3, 'solid']);
  assert.equal(labelOf(mixed.slice(0, 2)).label, 'unrated'); // two check answers alone do not rate it
  assert.equal(labelOf([answer(false, { pool: 'check' }), answer(false, { pool: 'check' }), mixed[2]]).label, 'shaky');
});

test('R6.2-order equal finish times are ordered by id, as numbers, whatever the input order', () => {
  const rows = [
    answer(false, { id: 9, at: 1000 }),
    answer(true, { id: 10, at: 1000 }),
    answer(true, { id: 11, at: 2000 }),
    answer(true, { id: 12, at: 3000 }),
    answer(false, { id: 13, at: 4000 }),
    answer(false, { id: 14, at: 5000 }),
  ];
  // id 9 is older than id 10 at the same time, so 9 (wrong) drops out: 3 right of 5.
  assert.deepEqual([labelOf(rows).label, labelOf(rows).right], ['getting', 3]);
  assert.deepEqual(labelOf([...rows].reverse()), labelOf(rows));
  // Rows passed out of time order are put in time order first.
  const shuffled = [rows[3], rows[0], rows[5], rows[1], rows[4], rows[2]];
  assert.deepEqual(labelOf(shuffled), labelOf(rows));
});

test('R6.2-nofade the same history gives the same label however much later it is asked', () => {
  const rows = [answer(true), answer(true), answer(true), answer(false), answer(true)];
  const before = labelOf(rows);
  // labelOf takes no clock; adding a year to every time changes nothing either.
  const later = labelOf(rows.map((a) => ({ ...a, at: a.at + 365 * 24 * 3600 * 1000 })));
  assert.deepEqual(later, before);
  assert.equal(before.label, 'solid');
  assert.equal(labelOf.length, 1);
});

test('R6.3-1 each pair of labels in the order Shaky, Not rated yet, Getting there, Solid', () => {
  const order = ['shaky', 'unrated', 'getting', 'solid'];
  for (let lo = 0; lo < order.length; lo++) {
    for (let hi = lo + 1; hi < order.length; hi++) {
      assert.equal(weakest([order[hi], order[lo]]), 1, `${order[lo]} before ${order[hi]}`);
      assert.equal(weakest([order[lo], order[hi]]), 0, `${order[lo]} before ${order[hi]}`);
    }
  }
  assert.equal(weakest(['solid', 'getting', 'unrated', 'shaky', 'getting', 'solid']), 3);
  assert.equal(weakest([{ label: 'solid' }, { label: 'unrated' }]), 1); // labelOf results work too
  assert.equal(weakest([]), null);
});

test('R6.3-2 a tie goes to the earlier topic', () => {
  assert.equal(weakest(['solid', 'getting', 'getting', 'solid', 'getting', 'solid']), 1);
  assert.equal(weakest(['solid', 'solid', 'shaky', 'solid', 'shaky', 'solid']), 2);
  assert.equal(weakest(['unrated', 'unrated', 'unrated', 'unrated', 'unrated', 'unrated']), 0);
});

const S = 'shaky', G = 'getting', D = 'solid', U = 'unrated';

test('R6.5-a totals 6, 9, 10, 14, 15, 18 give Shaky, Shaky, Getting there, Getting there, Solid, Solid', () => {
  const cases = [
    [[S, S, S, S, S, S], 6, 'shaky'],
    [[S, S, S, G, G, G], 9, 'shaky'],
    [[S, S, G, G, G, G], 10, 'getting'],
    [[G, G, G, G, D, D], 14, 'getting'],
    [[G, G, G, D, D, D], 15, 'solid'],
    [[D, D, D, D, D, D], 18, 'solid'],
  ];
  for (const [labels, total, want] of cases) {
    const r = chemistryLabel(labels);
    assert.deepEqual([r.label, r.total, r.rated], [want, total, 6], `total ${total}`);
  }
});

test('R6.5-b fewer than six rated: no label, and the count', () => {
  assert.deepEqual([chemistryLabel([D, D, D, D, D, U]).label, chemistryLabel([D, D, D, D, D, U]).rated], [null, 5]);
  assert.deepEqual([chemistryLabel([U, U, U, U, U, U]).label, chemistryLabel([U, U, U, U, U, U]).rated], [null, 0]);
  assert.equal(chemistryLabel([S, U, G, U, D, U]).rated, 3);
  assert.equal(chemistryLabel([D, D, D, D, D]).label, null); // not six labels
});

test('R6.5-c 15 or 16 with one Shaky is Getting there', () => {
  assert.equal(chemistryLabel([S, G, D, D, D, D]).total, 15);
  assert.equal(chemistryLabel([S, G, D, D, D, D]).label, 'getting');
  assert.equal(chemistryLabel([D, D, S, D, D, D]).total, 16);
  assert.equal(chemistryLabel([D, D, S, D, D, D]).label, 'getting');
});

test('R6.5-d the weakest topic is named, rated or not', () => {
  assert.equal(chemistryLabel([D, G, S, D, S, D]).weakest, 2);
  assert.equal(chemistryLabel([G, U, G, D, D, D]).weakest, 1);
  assert.equal(chemistryLabel([D, D, D, D, D, D]).weakest, 0);
  assert.equal(chemistryLabel([D, D, D, D, G, D].map((label) => ({ label }))).weakest, 4);
});

test('purity: rating-rules imports nothing and uses no clock or randomness', () => {
  const text = readFileSync(fileURLToPath(new URL('../lib/rating-rules.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(text, /\bimport\b/);
  assert.doesNotMatch(text, /\brequire\s*\(/);
  assert.doesNotMatch(text, /\bprocess\./);
  assert.doesNotMatch(text, /\bDate\s*\.\s*now\b|\bnew\s+Date\b|\bMath\s*\.\s*random\b|\bperformance\s*\.\s*now\b/);
});
