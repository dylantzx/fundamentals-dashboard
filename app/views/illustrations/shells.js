// Topic 2 drawing: sodium 2.8.1 and chlorine 2.8.7, linking shells to the
// Period and outer electrons to the Group.

import { svg, label, shell, dot, onCircle } from './common.js';

const RADII = [30, 58, 86];

/**
 * One atom: nucleus with its symbol, then each shell's electrons spread evenly
 * (8 slots on the 2nd and 3rd shells; a part-filled shell uses the first slots).
 * @param {number} cx @param {number} cy @param {string} sym @param {number[]} config e.g. [2, 8, 1]
 */
function atom(cx, cy, sym, config) {
  let out = '';
  config.forEach((n, i) => {
    const r = RADII[i];
    out += shell(cx, cy, r, i === config.length - 1 ? 'ill-shell ill-shell--outer' : 'ill-shell');
    const slots = i === 0 ? 2 : 8;
    const start = i === 0 ? 180 : -90; // first shell: left and right; others from the top, clockwise
    for (let k = 0; k < n; k++) {
      const [x, y] = onCircle(cx, cy, r, start + (360 / slots) * k);
      out += dot(x, y, 5.5);
    }
  });
  out += `<circle class="ill-nucleus" cx="${cx}" cy="${cy}" r="16"/>` + label(cx, cy + 5.5, sym, { cls: 'ill-strong', anchor: 'middle' });
  return out;
}

export function shellsNaCl(id = 'ill-shells') {
  const body =
    atom(165, 120, 'Na', [2, 8, 1]) +
    atom(495, 120, 'Cl', [2, 8, 7]) +
    label(165, 236, 'Sodium: 11 electrons, 2.8.1', { cls: 'ill-strong', anchor: 'middle' }) +
    label(165, 260, '3 shells → Period 3', { cls: 'ill-text', anchor: 'middle' }) +
    label(165, 282, '1 outer electron → Group 1', { cls: 'ill-text', anchor: 'middle' }) +
    label(495, 236, 'Chlorine: 17 electrons, 2.8.7', { cls: 'ill-strong', anchor: 'middle' }) +
    label(495, 260, '3 shells → Period 3', { cls: 'ill-text', anchor: 'middle' }) +
    label(495, 282, '7 outer electrons → Group 17', { cls: 'ill-text', anchor: 'middle' }) +
    label(330, 312, 'Each dot is one electron. The outer shell has the thicker ring.', { cls: 'ill-small', anchor: 'middle' });

  return svg(id, {
    w: 660, h: 322,
    title: 'Electron shells of sodium and chlorine',
    desc: 'Sodium, on the left, has 2 electrons in the first shell, 8 in the second and 1 in the third: 2.8.1. Chlorine, on the right, has 2, then 8, then 7: 2.8.7. Both have 3 occupied shells, so both are in Period 3. Sodium has 1 outer electron, so it is in Group 1. Chlorine has 7 outer electrons, so it is in Group 17.',
  }, body);
}
