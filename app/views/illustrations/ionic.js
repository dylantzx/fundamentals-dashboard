// Topic 4 drawing: a sodium atom gives its one outer electron to a chlorine
// atom, forming Na⁺ and Cl⁻ (dot-and-cross, outer shells only).
// Crosses are sodium's electrons, dots are chlorine's.

import { svg, label, shell, dot, cross, pairAt, onCircle, ionBrackets, arrowRight } from './common.js';

const R = 46;

export function ionicNaCl(id = 'ill-ionic') {
  const cy = 120;
  const na = 90, cl = 250, naIon = 455, clIon = 625;

  // Sodium atom: outer (3rd) shell holds 1 electron (×), on the side facing chlorine.
  const [nx, ny] = onCircle(na, cy, R, 0);
  // Chlorine atom: outer (3rd) shell holds 7 electrons (•): pairs at top, right, bottom and one on the left.
  let clDots = '';
  for (const deg of [-90, 0, 90]) for (const [x, y] of pairAt(cl, cy, R, deg)) clDots += dot(x, y, 4.5);
  const [lx, ly] = onCircle(cl, cy, R, 180);
  clDots += dot(lx, ly - 9, 4.5); // the single, unpaired electron (left, top of the gap)

  // Na⁺: the 3rd shell is now empty, so its outer shell is the full 2nd shell: 8 sodium electrons (×).
  let naIonX = '';
  for (const deg of [-90, 0, 90, 180]) for (const [x, y] of pairAt(naIon, cy, R, deg)) naIonX += cross(x, y, 4.5);

  // Cl⁻: its 7 dots plus the 1 cross it gained = 8.
  let clIonE = '';
  for (const deg of [-90, 0, 90]) for (const [x, y] of pairAt(clIon, cy, R, deg)) clIonE += dot(x, y, 4.5);
  const [px, py] = pairAt(clIon, cy, R, 180);
  clIonE += dot(px[0], px[1], 4.5) + cross(py[0], py[1], 4.5);

  const body =
    // before
    shell(na, cy, R) + label(na, cy + 7, 'Na', { cls: 'ill-sym', anchor: 'middle' }) + cross(nx, ny, 5) +
    shell(cl, cy, R) + label(cl, cy + 7, 'Cl', { cls: 'ill-sym', anchor: 'middle' }) + clDots +
    `<path class="ill-arrow ill-arrow--curve" d="M${nx + 4} ${ny - 12}C${nx + 30} ${ny - 62} ${lx - 40} ${ly - 62} ${lx - 6} ${ly - 20}"/>` +
    `<path class="ill-arrow" d="M${lx - 16} ${ly - 24}L${lx - 6} ${ly - 20}L${lx - 6} ${ly - 31}"/>` +
    label((nx + lx) / 2, cy - 74, '1 electron moves', { cls: 'ill-small', anchor: 'middle' }) +
    label(na, cy + 84, 'Sodium atom', { cls: 'ill-strong', anchor: 'middle' }) + label(na, cy + 104, '2.8.1', { cls: 'ill-text', anchor: 'middle' }) +
    label(cl, cy + 84, 'Chlorine atom', { cls: 'ill-strong', anchor: 'middle' }) + label(cl, cy + 104, '2.8.7', { cls: 'ill-text', anchor: 'middle' }) +
    arrowRight(320, cy, 368) +
    // after
    shell(naIon, cy, R) + label(naIon, cy + 7, 'Na', { cls: 'ill-sym', anchor: 'middle' }) + naIonX + ionBrackets(naIon, cy, R, '+') +
    shell(clIon, cy, R) + label(clIon, cy + 7, 'Cl', { cls: 'ill-sym', anchor: 'middle' }) + clIonE + ionBrackets(clIon, cy, R, '−') +
    label(naIon, cy + 84, 'Sodium ion, Na⁺', { cls: 'ill-strong', anchor: 'middle' }) + label(naIon, cy + 104, '2.8 (full 2nd shell now outer)', { cls: 'ill-text', anchor: 'middle' }) +
    label(clIon, cy + 84, 'Chloride ion, Cl⁻', { cls: 'ill-strong', anchor: 'middle' }) + label(clIon, cy + 104, '2.8.8', { cls: 'ill-text', anchor: 'middle' }) +
    // key
    cross(150, 262, 5) + label(162, 267, 'electron from sodium', { cls: 'ill-small' }) +
    dot(340, 262, 4.5) + label(352, 267, 'electron from chlorine', { cls: 'ill-small' }) +
    label(530, 267, 'Outer shells only', { cls: 'ill-small' });

  return svg(id, {
    w: 720, h: 285,
    title: 'Sodium and chlorine forming sodium chloride',
    desc: 'Dot-and-cross diagram, outer shells only. A sodium atom (2.8.1) has 1 outer electron, drawn as a cross. A chlorine atom (2.8.7) has 7 outer electrons, drawn as dots. The sodium electron moves to chlorine. The sodium ion, Na⁺, is drawn in square brackets with a plus charge: its third shell is now empty, so its outer shell is the full second shell of 8 crosses (2.8). The chloride ion, Cl⁻, is drawn in square brackets with a minus charge: 7 dots and 1 cross make 8 outer electrons (2.8.8).',
  }, body);
}
