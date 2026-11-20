import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS, LABEL_TEXT, labelFor } from '../lib/ratings.js';

test('six topics in mockup order with ids t1..t6', () => {
  assert.deepEqual(
    TOPICS.map((t) => [t.id, t.n, t.name]),
    [
      ['t1', 1, 'Subatomic particles and nuclide notation'],
      ['t2', 2, 'Electron arrangement'],
      ['t3', 3, 'Isotopes'],
      ['t4', 4, 'Ions and ionic bonding'],
      ['t5', 5, 'Covalent bonding'],
      ['t6', 6, 'Structure and properties'],
    ],
  );
});

test('label text matches the key', () => {
  assert.deepEqual(LABEL_TEXT, {
    unrated: 'Not rated yet', shaky: 'Shaky', getting: 'Getting there', solid: 'Solid',
  });
});

test('fewer than 3 answers is unrated, even if all right', () => {
  assert.equal(labelFor({ right: 0, total: 0 }), 'unrated');
  assert.equal(labelFor({ right: 1, total: 1 }), 'unrated');
  assert.equal(labelFor({ right: 2, total: 2 }), 'unrated');
});

test('boundaries: under 0.5 shaky, 0.5 and 0.75 getting, just over 0.75 solid', () => {
  assert.equal(labelFor({ right: 1, total: 3 }), 'shaky');
  assert.equal(labelFor({ right: 2, total: 5 }), 'shaky'); // 0.4
  assert.equal(labelFor({ right: 2, total: 4 }), 'getting'); // 0.5 exactly
  assert.equal(labelFor({ right: 3, total: 4 }), 'getting'); // 0.75 exactly
  assert.equal(labelFor({ right: 4, total: 5 }), 'solid'); // 0.8, just over
  assert.equal(labelFor({ right: 3, total: 3 }), 'solid');
});

test('every row of the PRD 6.2 table', () => {
  const table = {
    5: ['shaky', 'shaky', 'shaky', 'getting', 'solid', 'solid'],
    4: ['shaky', 'shaky', 'getting', 'getting', 'solid'],
    3: ['shaky', 'shaky', 'getting', 'solid'],
  };
  for (const [total, labels] of Object.entries(table)) {
    labels.forEach((want, right) => assert.equal(labelFor({ right, total: Number(total) }), want, `${right}/${total}`));
  }
});
