// Topic 5 drawings: the shared pair in H₂, and water (H₂O) with its 2 bonding
// pairs and 2 lone pairs (dot-and-cross, outer shells only).

import { svg, label, pointer, shell, dot, cross } from './common.js';

export function covalentH2(id = 'ill-h2') {
  const cy = 110, a = 150, b = 236, r = 56; // overlap between x = b - r = 180 and a + r = 206
  const mid = (a + b) / 2;
  const body =
    shell(a, cy, r) + shell(b, cy, r) +
    label(a - 14, cy + 7, 'H', { cls: 'ill-sym', anchor: 'middle' }) +
    label(b + 14, cy + 7, 'H', { cls: 'ill-sym', anchor: 'middle' }) +
    dot(mid, cy - 10, 5) + cross(mid, cy + 10, 5.5) +
    pointer(mid + 8, cy - 14, 330, 40) + label(334, 36, 'Shared pair', { cls: 'ill-strong' }) + label(334, 56, '= one covalent bond', { cls: 'ill-small' }) +
    label(193, 200, 'H₂: each H atom now has 2 electrons, a full first shell', { cls: 'ill-text', anchor: 'middle' }) +
    dot(70, 230, 4.5) + label(82, 235, 'electron from one H atom', { cls: 'ill-small' }) +
    cross(270, 230, 5) + label(282, 235, 'electron from the other', { cls: 'ill-small' });

  return svg(id, {
    w: 540, h: 250,
    title: 'Covalent bond in a hydrogen molecule, H₂',
    desc: 'Two hydrogen atoms drawn as overlapping circles. Where they overlap is one shared pair: one dot from the first atom and one cross from the second. This shared pair is a single covalent bond, and each hydrogen atom now has 2 electrons, a full first shell.',
  }, body);
}

export function covalentH2O(id = 'ill-h2o') {
  const ox = 280, oy = 130, ro = 62, rh = 40;
  const h1x = ox - 88, h1y = oy;      // hydrogen on the left
  const h2x = ox, h2y = oy + 88;      // hydrogen below
  // Left bonding pair sits in the overlap (x from ox - ro to h1x + rh).
  const bL = ox - ro + 7;
  // Lower bonding pair sits in the overlap (y from h2y - rh to oy + ro).
  const bB = oy + ro - 7;

  const body =
    shell(ox, oy, ro) + shell(h1x, h1y, rh) + shell(h2x, h2y, rh) +
    label(ox + 4, oy + 8, 'O', { cls: 'ill-sym', anchor: 'middle' }) +
    label(h1x - 8, h1y + 7, 'H', { cls: 'ill-sym', anchor: 'middle' }) +
    label(h2x, h2y + 16, 'H', { cls: 'ill-sym', anchor: 'middle' }) +
    // bonding pairs: one dot (oxygen) + one cross (hydrogen) each
    dot(bL, oy - 9, 4.5) + cross(bL, oy + 9, 4.5) +
    dot(ox - 9, bB, 4.5) + cross(ox + 9, bB, 4.5) +
    // lone pairs on oxygen: top and right, dots only
    dot(ox - 9, oy - ro + 12, 4.5) + dot(ox + 9, oy - ro + 12, 4.5) +
    dot(ox + ro - 12, oy - 9, 4.5) + dot(ox + ro - 12, oy + 9, 4.5) +
    // call-outs
    pointer(ox + 14, oy - ro + 10, 410, 44) + pointer(ox + ro - 6, oy - 14, 410, 58) +
    label(416, 50, 'Lone pairs (2)', { cls: 'ill-strong' }) +
    pointer(bL - 4, oy + 16, 130, 262) + pointer(ox - 16, bB + 4, 130, 262) +
    label(14, 282, 'Bonding pairs (2)', { cls: 'ill-strong' }) +
    label(416, 150, 'Oxygen: 2 bonding pairs', { cls: 'ill-text' }) +
    label(416, 172, '+ 2 lone pairs = 8 electrons', { cls: 'ill-text' }) +
    label(416, 200, 'Each hydrogen: 2 electrons', { cls: 'ill-text' }) +
    dot(422, 248, 4.5) + label(434, 253, 'electron from oxygen', { cls: 'ill-small' }) +
    cross(422, 274, 5) + label(434, 279, 'electron from hydrogen', { cls: 'ill-small' });

  return svg(id, {
    w: 660, h: 300,
    title: 'Dot-and-cross diagram of water, H₂O',
    desc: 'An oxygen atom overlaps with two hydrogen atoms, one on the left and one below. Each overlap holds a bonding pair of one dot from oxygen and one cross from hydrogen. Oxygen also has 2 lone pairs of dots, at the top and on the right. So oxygen has 2 bonding pairs and 2 lone pairs, 8 outer electrons in all, and each hydrogen has 2.',
  }, body);
}
