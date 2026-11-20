// Topic 1 drawings: the parts of an atom, and how to read nuclide notation.

import { svg, label, pointer, shell, onCircle, r1 } from './common.js';

const proton = (x, y) =>
  `<circle class="ill-p" cx="${r1(x)}" cy="${r1(y)}" r="11"/>` + label(x, y + 5, '+', { cls: 'ill-sign', anchor: 'middle' });
const neutron = (x, y) => `<circle class="ill-n" cx="${r1(x)}" cy="${r1(y)}" r="11"/>`;
const electron = (x, y) =>
  `<circle class="ill-e" cx="${r1(x)}" cy="${r1(y)}" r="8"/>` + label(x, y + 4.5, '−', { cls: 'ill-sign-e', anchor: 'middle' });

/** Lithium-7: 3 protons and 4 neutrons in the nucleus, electrons 2.1 in two shells. */
export function atomLithium(id = 'ill-atom') {
  const cx = 150, cy = 150;
  // Nucleus: one neutron in the middle, then proton/neutron alternating round it (3 p + 3 n).
  let nucleus = neutron(cx, cy);
  for (let i = 0; i < 6; i++) {
    const [x, y] = onCircle(cx, cy, 23, i * 60 - 90);
    nucleus += i % 2 === 0 ? proton(x, y) : neutron(x, y);
  }
  const [e1x, e1y] = onCircle(cx, cy, 62, 180);
  const [e2x, e2y] = onCircle(cx, cy, 62, 0);
  const [e3x, e3y] = onCircle(cx, cy, 104, -50);

  const legendX = 330;
  const body =
    shell(cx, cy, 62) + shell(cx, cy, 104) + nucleus +
    electron(e1x, e1y) + electron(e2x, e2y) + electron(e3x, e3y) +
    // call-outs
    pointer(cx - 30, cy + 26, 40, 276) + label(40, 292, 'Nucleus: 3 protons + 4 neutrons', { cls: 'ill-small' }) +
    pointer(e3x + 8, e3y - 6, 300, 28) + label(300, 22, 'Electrons in shells', { cls: 'ill-small', anchor: 'end' }) +
    // legend: shape + sign + words, so colour is never the only clue
    proton(legendX, 92) + label(legendX + 22, 88, 'Proton', { cls: 'ill-strong' }) + label(legendX + 22, 108, 'charge +1, mass 1', { cls: 'ill-small' }) +
    neutron(legendX, 152) + label(legendX + 22, 148, 'Neutron', { cls: 'ill-strong' }) + label(legendX + 22, 168, 'charge 0, mass 1', { cls: 'ill-small' }) +
    electron(legendX, 212) + label(legendX + 22, 208, 'Electron', { cls: 'ill-strong' }) + label(legendX + 22, 228, 'charge −1, mass about 1/1840', { cls: 'ill-small' }) +
    label(legendX - 12, 52, 'Lithium-7 (⁷₃Li)', { cls: 'ill-heading' });

  return svg(id, {
    w: 580, h: 305,
    title: 'Inside a lithium-7 atom',
    desc: 'A nucleus of 3 protons, each marked with a plus sign, and 4 neutrons, with no sign. Around it, 2 electrons sit in the first shell and 1 electron in the second shell, so the electronic configuration is 2.1. A key gives each particle\'s charge and mass: proton +1 and 1, neutron 0 and 1, electron −1 and about 1/1840.',
  }, body);
}

/** Nuclide notation for sodium-23 with both numbers labelled and the particle counts worked out. */
export function nuclideSodium(id = 'ill-nuclide') {
  const nx = 268; // right edge of the two numbers
  const body =
    label(nx, 92, '23', { cls: 'ill-nuc-num', anchor: 'end' }) +
    label(nx, 166, '11', { cls: 'ill-nuc-num', anchor: 'end' }) +
    label(nx + 6, 152, 'Na', { cls: 'ill-nuc-sym' }) +
    pointer(nx - 46, 82, 196, 62) + label(20, 50, 'Nucleon (mass) number', { cls: 'ill-strong' }) + label(20, 70, 'protons + neutrons', { cls: 'ill-small' }) +
    pointer(nx - 46, 158, 196, 186) + label(20, 186, 'Proton (atomic) number', { cls: 'ill-strong' }) + label(20, 206, 'number of protons', { cls: 'ill-small' }) +
    `<rect class="ill-box" x="390" y="56" width="226" height="128" rx="12"/>` +
    label(406, 86, 'Protons: 11', { cls: 'ill-text' }) +
    label(406, 118, 'Neutrons: 23 − 11 = 12', { cls: 'ill-text' }) +
    label(406, 150, 'Electrons: 11', { cls: 'ill-text' }) +
    label(406, 172, '(neutral atom: same as protons)', { cls: 'ill-small' });

  return svg(id, {
    w: 640, h: 230,
    title: 'Reading the nuclide notation for sodium-23',
    desc: 'The symbol Na with 23 written at the top left and 11 at the bottom left. The top number, 23, is the nucleon (mass) number: protons plus neutrons. The bottom number, 11, is the proton (atomic) number. So sodium-23 has 11 protons, 23 minus 11 equals 12 neutrons, and 11 electrons in the neutral atom.',
  }, body);
}
