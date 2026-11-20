// Topic 6 drawing: a giant ionic lattice next to simple molecules, with what
// each structure means for melting point and electrical conductivity.
// Common content only: no diamond, graphite or metals.

import { svg, label, pointer, r1 } from './common.js';

const pos = (x, y) =>
  `<circle class="ill-ion-pos" cx="${r1(x)}" cy="${r1(y)}" r="12"/>` + label(x, y + 5.5, '+', { cls: 'ill-sign', anchor: 'middle' });
const neg = (x, y) =>
  `<circle class="ill-ion-neg" cx="${r1(x)}" cy="${r1(y)}" r="19"/>` + label(x, y + 6, '−', { cls: 'ill-sign', anchor: 'middle' });

/** A two-atom molecule (like I₂): two touching circles joined by a bond line. */
function molecule(x, y, deg) {
  const a = (deg * Math.PI) / 180, d = 15;
  const x1 = x - d * Math.cos(a), y1 = y - d * Math.sin(a), x2 = x + d * Math.cos(a), y2 = y + d * Math.sin(a);
  return `<circle class="ill-atom" cx="${r1(x1)}" cy="${r1(y1)}" r="15"/><circle class="ill-atom" cx="${r1(x2)}" cy="${r1(y2)}" r="15"/>` +
    `<line class="ill-bond" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`;
}
const weak = (x1, y1, x2, y2) => `<line class="ill-weak" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`;

export function latticeVsMolecules(id = 'ill-structures') {
  // Left: 5 x 4 lattice of alternating ions, with short solid lines for the strong attractions.
  const gx = 50, gy = 76, step = 56;
  let lattice = '';
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const x = gx + col * step, y = gy + row * step;
      if (col < 4) lattice += `<line class="ill-attract" x1="${x}" y1="${y}" x2="${x + step}" y2="${y}"/>`;
      if (row < 3) lattice += `<line class="ill-attract" x1="${x}" y1="${y}" x2="${x}" y2="${y + step}"/>`;
    }
  }
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const x = gx + col * step, y = gy + row * step;
      lattice += (row + col) % 2 === 0 ? pos(x, y) : neg(x, y);
    }
  }

  // Right: separate molecules, with dashed lines for the weak forces between them.
  const mols = [[470, 96, 20], [580, 82, -30], [690, 110, 60], [500, 196, -50], [620, 190, 10], [700, 232, -20], [540, 278, 30]];
  let molecules = '';
  const links = [[0, 1], [1, 2], [0, 3], [3, 4], [1, 4], [4, 5], [3, 6], [4, 6], [2, 5]];
  for (const [i, j] of links) {
    const [x1, y1] = mols[i], [x2, y2] = mols[j];
    molecules += weak(x1, y1, x2, y2);
  }
  for (const [x, y, d] of mols) molecules += molecule(x, y, d);

  const body =
    label(20, 30, 'Giant ionic lattice (e.g. sodium chloride)', { cls: 'ill-heading' }) +
    lattice +
    label(20, 296, 'Strong attractions between ions in every direction', { cls: 'ill-text' }) +
    label(20, 318, '→ high melting and boiling points', { cls: 'ill-strong' }) +
    label(20, 340, '→ conducts only when molten or dissolved', { cls: 'ill-text' }) +
    label(20, 362, '(then the ions are free to move)', { cls: 'ill-small' }) +
    `<line class="ill-divider" x1="400" y1="20" x2="400" y2="370"/>` +
    label(430, 30, 'Simple molecules (e.g. iodine, I₂)', { cls: 'ill-heading' }) +
    molecules +
    pointer(574, 88, 640, 52) + label(646, 50, 'strong covalent bond', { cls: 'ill-small' }) + label(646, 66, 'inside each molecule', { cls: 'ill-small' }) +
    pointer(700, 171, 730, 171) + label(736, 160, 'weak forces', { cls: 'ill-small' }) + label(736, 176, 'between', { cls: 'ill-small' }) + label(736, 192, 'molecules', { cls: 'ill-small' }) +
    label(430, 318, '→ low melting and boiling points', { cls: 'ill-strong' }) +
    label(430, 340, '→ does not conduct electricity', { cls: 'ill-text' }) +
    label(430, 362, '(no ions or free electrons that can move)', { cls: 'ill-small' });

  return svg(id, {
    w: 820, h: 380,
    title: 'Giant ionic lattice compared with simple molecules',
    desc: 'Left: a giant ionic lattice drawn as a grid of alternating small positive ions and larger negative ions, joined by short solid lines for the strong attractions in every direction. So ionic compounds have high melting and boiling points, and conduct electricity only when molten or dissolved, when the ions are free to move. Right: separate small molecules, each two atoms joined by a strong covalent bond, with dashed lines between molecules for the weak forces. So simple molecular substances have low melting and boiling points and do not conduct, because there are no ions or free electrons that can move.',
  }, body);
}
