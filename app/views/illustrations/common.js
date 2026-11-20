// Shared drawing helpers for the topic illustrations. Every drawing is
// hand-written inline SVG: no images, no scripts, no outside references.
// Colours come from the Steady palette through the .ill-* classes in
// public/styles.css, and every meaning also has a shape or a label, so
// nothing relies on colour alone.

import { escapeHtml } from '../html.js';

/** Rounds to one decimal place for tidy SVG numbers. */
export const r1 = (n) => Math.round(n * 10) / 10;

/**
 * The outer <svg> with an accessible name and description.
 * @param {string} id unique on the page, used for the title/desc ids
 * @param {{ w: number, h: number, title: string, desc: string }} o
 * @param {string} body SVG markup written in this codebase
 */
export function svg(id, { w, h, title, desc }, body) {
  return `<svg class="ill" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}-t ${id}-d" xmlns="http://www.w3.org/2000/svg">` +
    `<title id="${id}-t">${escapeHtml(title)}</title><desc id="${id}-d">${escapeHtml(desc)}</desc>${body}</svg>`;
}

/** Text. `cls` picks the style; anchor is start, middle or end. */
export function label(x, y, s, { cls = 'ill-text', anchor = 'start', size = 0 } = {}) {
  return `<text class="${cls}" x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}"${size ? ` font-size="${size}"` : ''}>${escapeHtml(s)}</text>`;
}

/** A thin pointer line from a label to the thing it names. */
export const pointer = (x1, y1, x2, y2) => `<line class="ill-pointer" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`;

/** An electron shell (a ring). */
export const shell = (cx, cy, r, cls = 'ill-shell') => `<circle class="${cls}" cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}"/>`;

/** An electron as a small filled dot (also the "dot" in dot-and-cross). */
export const dot = (x, y, r = 5) => `<circle class="ill-dot" cx="${r1(x)}" cy="${r1(y)}" r="${r}"/>`;

/** The "cross" in dot-and-cross: an × made of two short strokes. */
export function cross(x, y, s = 5.5) {
  return `<path class="ill-cross" d="M${r1(x - s)} ${r1(y - s)}L${r1(x + s)} ${r1(y + s)}M${r1(x + s)} ${r1(y - s)}L${r1(x - s)} ${r1(y + s)}"/>`;
}

/** A point on a circle; angles in degrees, 0 = right, 90 = down. */
export function onCircle(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/**
 * A pair of electron positions on a circle at `deg`, side by side along the ring.
 * @returns {[[number, number], [number, number]]}
 */
export function pairAt(cx, cy, r, deg, gap = 9) {
  const [x, y] = onCircle(cx, cy, r, deg);
  const a = (deg * Math.PI) / 180;
  const tx = -Math.sin(a) * gap, ty = Math.cos(a) * gap;
  return [[x - tx, y - ty], [x + tx, y + ty]];
}

/** Square brackets round an ion, with its charge at the top right. */
export function ionBrackets(cx, cy, r, charge) {
  const t = cy - r - 8, b = cy + r + 8, L = cx - r - 14, R = cx + r + 14;
  return `<path class="ill-bracket" d="M${r1(L + 8)} ${r1(t)}H${r1(L)}V${r1(b)}H${r1(L + 8)}M${r1(R - 8)} ${r1(t)}H${r1(R)}V${r1(b)}H${r1(R - 8)}"/>` +
    label(R + 4, t + 10, charge, { cls: 'ill-charge' });
}

/** An arrow pointing right (for "becomes"). */
export function arrowRight(x1, y, x2) {
  return `<path class="ill-arrow" d="M${r1(x1)} ${r1(y)}H${r1(x2)}M${r1(x2 - 10)} ${r1(y - 8)}L${r1(x2)} ${r1(y)}L${r1(x2 - 10)} ${r1(y + 8)}"/>`;
}
