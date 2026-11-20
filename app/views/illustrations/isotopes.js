// Topic 3 drawing: chlorine-35 and chlorine-37 side by side, then the
// weighted average that gives chlorine's relative atomic mass of 35.5.

import { svg, label } from './common.js';

/** Nuclide notation drawn with real positions: nucleon number top left, proton number bottom left. */
function nuclide(x, y, top, bottom, sym) {
  return label(x, y - 16, top, { cls: 'ill-nuc-small', anchor: 'end' }) +
    label(x, y + 12, bottom, { cls: 'ill-nuc-small', anchor: 'end' }) +
    label(x + 3, y + 8, sym, { cls: 'ill-nuc-sym-sm' });
}

function isotope(cx, nucleon, neutrons, name) {
  return nuclide(cx - 6, 52, String(nucleon), '17', 'Cl') +
    label(cx, 84, name, { cls: 'ill-strong', anchor: 'middle' }) +
    `<circle class="ill-nucleus-big" cx="${cx}" cy="152" r="58"/>` +
    label(cx, 146, '17 protons', { cls: 'ill-text', anchor: 'middle' }) +
    label(cx, 168, `${neutrons} neutrons`, { cls: 'ill-strong', anchor: 'middle' }) +
    label(cx, 236, '17 electrons: 2.8.7', { cls: 'ill-text', anchor: 'middle' });
}

export function isotopesChlorine(id = 'ill-isotopes') {
  const boxes = [35, 35, 35, 37];
  let strip = '';
  boxes.forEach((m, i) => {
    const x = 150 + i * 58;
    strip += `<rect class="${m === 35 ? 'ill-box' : 'ill-box ill-box--alt'}" x="${x}" y="262" width="50" height="40" rx="8"/>` +
      label(x + 25, 288, String(m), { cls: 'ill-strong', anchor: 'middle' });
  });

  const body =
    isotope(170, 35, 18, 'Chlorine-35') +
    isotope(470, 37, 20, 'Chlorine-37') +
    label(320, 146, 'same', { cls: 'ill-small', anchor: 'middle' }) +
    label(320, 168, 'different', { cls: 'ill-strong', anchor: 'middle' }) +
    label(320, 236, 'same', { cls: 'ill-small', anchor: 'middle' }) +
    label(140, 288, 'In every 4 atoms:', { cls: 'ill-small', anchor: 'end' }) +
    strip +
    label(390, 280, 'average = (35 + 35 + 35 + 37) ÷ 4', { cls: 'ill-text' }) +
    label(390, 302, '= 142 ÷ 4 = 35.5', { cls: 'ill-strong' });

  return svg(id, {
    w: 680, h: 316,
    title: 'Two isotopes of chlorine',
    desc: 'Chlorine-35 and chlorine-37 side by side. Both have 17 protons and 17 electrons arranged 2.8.7. Chlorine-35 has 18 neutrons and chlorine-37 has 20 neutrons. Below, a row of 4 atoms, three of mass 35 and one of mass 37, shows the average: 35 plus 35 plus 35 plus 37 is 142, and 142 divided by 4 is 35.5, the relative atomic mass of chlorine.',
  }, body);
}
