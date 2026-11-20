// Rendering real exam questions from the question bank: text (with Markdown
// tables and lists), figures cropped from the scans, MCQ options and mark schemes.
// Every value from the bank goes through html`` and is escaped.

import { html } from './html.js';

/** Where bank images are served from (see lib/routes.js). */
export const ASSET_BASE = '/bank/assets/';

/** Bank asset paths look like "ab/abcdef….png": anything else is dropped. */
const ASSET_RE = /^[0-9a-f]{2}\/[0-9a-f]{64}\.(png|jpe?g)$/;
export const assetUrl = (p) => (ASSET_RE.test(String(p)) ? ASSET_BASE + p : '');

/** A4 text width at 300 dpi is about 2000 px: scale crops to match the printed size. */
const PRINT_WIDTH = 2000;
const widthPct = (w) => Math.max(30, Math.min(100, Math.round((Number(w) || PRINT_WIDTH) / PRINT_WIDTH * 100)));

/**
 * Stem text to HTML: blank lines split blocks; "| a | b |" blocks become tables,
 * "- x" blocks become lists, anything else a paragraph with line breaks kept.
 * @param {string} text
 */
export function richText(text) {
  const blocks = String(text || '').split(/\n\s*\n/).map((b) => b.replace(/^\n+|\n+$/g, '')).filter((b) => b.trim());
  return blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) return table(lines);
    if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
      return html`<ul class="q-list">${lines.map((l) => html`<li>${l.replace(/^\s*[-•]\s+/, '')}</li>`)}</ul>`;
    }
    return html`<p>${lines.map((l, i) => (i ? html`<br>${l}` : l))}</p>`;
  });
}

function table(lines) {
  const rows = lines
    .filter((l) => !/^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const [head, ...body] = rows;
  return html`<div class="q-table-wrap"><table class="q-table">
    <thead><tr>${head.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
    <tbody>${body.map((r) => html`<tr>${r.map((c, i) => (i === 0 ? html`<th scope="row">${c}</th>` : html`<td>${c}</td>`))}</tr>`)}</tbody>
  </table></div>`;
}

/** One cropped image with its alt text. */
export function scan(img, { alt = '', caption = '', cls = 'q-fig' } = {}) {
  const src = assetUrl(img.path ?? img);
  if (!src) return '';
  return html`<figure class="${cls}"><img src="${src}" alt="${alt || img.description || ''}" loading="lazy" style="width:${widthPct(img.width)}%">${caption ? html`<figcaption>${caption}</figcaption>` : ''}</figure>`;
}

/** Figures the student needs, each with its description as alt text. */
export function figures(list) {
  // The caption ("Fig. 1.1") is printed inside the crop, so it goes in the alt text only.
  return (list || []).map((f) => scan(f, { alt: [f.caption, f.description].filter(Boolean).join(': ') }));
}

/** "[2]" style marks, as printed. */
export const marksTag = (m) => (m ? html`<span class="q-marks" aria-label="${m} ${m === 1 ? 'mark' : 'marks'}">[${m}]</span>` : '');

/** Where the question comes from: "Paper 2 (6092/02) · Question 1(a)(iii)". */
export function sourceTag(item) {
  return html`<p class="q-source">${item.source ? html`${item.source} · ` : ''}${item.paperName} · Question ${item.label}</p>`;
}

/** Topic codes as small tags. */
export function topicTags(topics) {
  const seen = new Set();
  const own = (topics || []).filter((t) => !seen.has(t.code) && seen.add(t.code));
  if (!own.length) return '';
  return html`<ul class="q-tags" aria-label="Syllabus topics">${own.map((t) => html`<li title="${t.name}">${t.code} ${shortName(t.name)}</li>`)}</ul>`;
}
const shortName = (n) => String(n).replace(/\s*\(.*\)\s*$/, '');

/** The mark scheme: transcribed text, with the scanned row behind a disclosure. */
export function markScheme(item) {
  return html`<div class="q-scheme">${item.markScheme.map((a) => html`
      <div class="q-scheme-row">${a.text ? richText(a.text) : ''}</div>`)}
      ${item.markScheme.some((a) => a.crops.length) ? html`<details class="q-printed">
        <summary>See the school’s mark scheme as printed</summary>
        ${item.markScheme.flatMap((a) => a.crops.map((c) => scan(c, { alt: 'Mark scheme as printed', cls: 'q-crop' })))}
      </details>` : ''}
    </div>`;
}

/** The question as printed on the paper (all pages), behind a disclosure. */
export function printed(item, summary = 'See it as printed in the paper') {
  const pages = item.regions?.length ? item.regions : item.fullQuestion;
  if (!pages?.length) return '';
  return html`<details class="q-printed">
      <summary>${summary}</summary>
      ${pages.map((p) => scan(p, { alt: `Question ${item.label} as printed`, cls: 'q-crop' }))}
      ${item.hasHandwriting ? html`<p class="t-small t-muted">This scan has some handwritten marks from the original paper.</p>` : ''}
    </details>`;
}

/** Context stems (from parent parts) and the part's own stem. */
export function questionBody(item) {
  return html`<div class="q-body">
      ${item.context.map((c) => html`<div class="q-context">${richText(c)}</div>`)}
      ${figures(item.parentFigures)}
      <div class="q-stem">${richText(item.stem)} ${marksTag(item.marks)}</div>
      ${figures(item.ownFigures)}
    </div>`;
}
