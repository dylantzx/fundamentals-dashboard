// Ratings: the six Chemistry topics and the label rule. Pure, no I/O.

/**
 * The six topics (PRD sub-skills) in their fixed list order, with the
 * student-facing names used in the approved mockups.
 * @type {ReadonlyArray<{ id: string, n: number, name: string }>}
 */
export const TOPICS = Object.freeze([
  Object.freeze({ id: 't1', n: 1, name: 'Subatomic particles and nuclide notation' }),
  Object.freeze({ id: 't2', n: 2, name: 'Electron arrangement' }),
  Object.freeze({ id: 't3', n: 3, name: 'Isotopes' }),
  Object.freeze({ id: 't4', n: 4, name: 'Ions and ionic bonding' }),
  Object.freeze({ id: 't5', n: 5, name: 'Covalent bonding' }),
  Object.freeze({ id: 't6', n: 6, name: 'Structure and properties' }),
]);

/** Answers needed before a topic gets a rating. */
export const MIN_ANSWERS = 3;

/** @typedef {'unrated' | 'shaky' | 'getting' | 'solid'} Label */

export const LABEL_TEXT = Object.freeze({
  unrated: 'Not rated yet',
  shaky: 'Shaky',
  getting: 'Getting there',
  solid: 'Solid',
});

/**
 * The rating key from the design, as proportions (matches every row of PRD 6.2):
 *   fewer than 3 answers -> unrated
 *   under half right     -> shaky
 *   half to 3/4 right    -> getting   (both ends inclusive)
 *   over 3/4 right       -> solid
 * The PRD's "Solid needs 2 exam-style answers" is not modelled in this version.
 * @param {{ right: number, total: number }} score
 * @returns {Label}
 */
export function labelFor({ right, total }) {
  const t = Number(total) || 0;
  const r = Number(right) || 0;
  if (t < MIN_ANSWERS) return 'unrated';
  const p = r / t;
  if (p < 0.5) return 'shaky';
  if (p <= 0.75) return 'getting';
  return 'solid';
}
