// The topic illustrations by id, as named in content/summaries.json.
// Each function returns a self-contained inline SVG string (code constants only).

import { atomLithium, nuclideSodium } from './atom.js';
import { shellsNaCl } from './shells.js';
import { isotopesChlorine } from './isotopes.js';
import { ionicNaCl } from './ionic.js';
import { covalentH2, covalentH2O } from './covalent.js';
import { latticeVsMolecules } from './structures.js';

/** @type {Readonly<Record<string, (id?: string) => string>>} */
export const ILLUSTRATIONS = Object.freeze({
  'atom-lithium': atomLithium,
  'nuclide-sodium': nuclideSodium,
  'shells-na-cl': shellsNaCl,
  'isotopes-chlorine': isotopesChlorine,
  'ionic-nacl': ionicNaCl,
  'covalent-h2': covalentH2,
  'covalent-h2o': covalentH2O,
  'lattice-vs-molecules': latticeVsMolecules,
});

export const ILLUSTRATION_IDS = Object.freeze(Object.keys(ILLUSTRATIONS));

/** The SVG string for an illustration id, or '' if there is none. */
export function renderIllustration(name) {
  const fn = Object.hasOwn(ILLUSTRATIONS, name) ? ILLUSTRATIONS[name] : null;
  return fn ? fn(`ill-${name}`) : '';
}
