// Rendering real exam questions from the question bank: text (with Markdown
// tables and lists), figures cropped from the scans, MCQ options and mark schemes.
// Every value from the bank goes through html`` and is escaped.

import { html } from './html.js';
import { shortTopicName } from '../lib/syllabus.js';

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

/** Link to a syllabus topic or subtopic page. */
export const topicHref = (code) => `/bank/topic/${encodeURIComponent(code)}`;

/** Link to answer one bank question on its own. */
export const tryHref = (item) => `/bank/try/${encodeURIComponent(item.id)}`;

/** A topic link: "Rate of Reactions" with its syllabus number. */
const topicLink = (t) => (t.code
  ? html`<a href="${topicHref(t.code)}">${t.name}</a> <span class="q-syllabus-code">${t.code.includes('.') ? '' : 'Topic '}${t.code}</span>`
  : html`<span>${t.name}</span>`);

/**
 * Where a practice item sits in the MOE syllabus, for syllabusPanel().
 * @param {any} it a practice item from the bank
 */
export const aboutItem = (it) => ({
  main: it.mainTopic, also: it.alsoTopics, places: it.syllabus, partOf: it.id !== it.rootId ? it.rootLabel : null,
});

/**
 * Where the question sits in the MOE syllabus: the printed question's main topic and
 * the others it also tests (topic tags CSV), and the subtopics this part is tagged with
 * (bank tags). Every topic links to all the questions on it.
 * @param {{ main?: { code: string, name: string } | null, also?: Array<{ code: string, name: string }>,
 *   places?: Array<{ topic: { code: string, name: string }, subtopic: { code: string, name: string } }>,
 *   partOf?: string | null, summary?: string }} about
 * @param {string} title e.g. "O-Level Chemistry (6092)"
 */
export function syllabusPanel(about, title) {
  const seen = new Set();
  const places = (about.places || []).filter((p) => !seen.has(p.subtopic.code) && seen.add(p.subtopic.code));
  const also = about.also || [];
  if (!about.main && !places.length) return '';
  const whole = about.partOf ? ` (all of Question ${about.partOf})` : '';
  return html`<section class="q-syllabus" aria-label="Where this is in the syllabus">
      <p class="q-syllabus-h">MOE syllabus · ${title || 'O-Level Chemistry'}</p>
      <dl class="q-syllabus-list">
        ${about.main ? html`<div><dt>Main topic${whole}</dt><dd>${topicLink(about.main)}</dd></div>` : ''}
        ${also.length ? html`<div><dt>Also tests</dt><dd>${also.map((t, i) => html`${i ? ', ' : ''}${topicLink(t)}`)}</dd></div>` : ''}
        ${places.length ? html`<div><dt>${about.partOf ? 'This part' : 'Subtopics'}</dt><dd>${places.map((p, i) => html`${i ? html`<br>` : ''}<a href="${topicHref(p.subtopic.code)}" title="${p.subtopic.name}">${p.subtopic.code} ${shortTopicName(p.subtopic.name)}</a>`)}</dd></div>` : ''}
        ${about.summary ? html`<div><dt>About</dt><dd>${about.summary}</dd></div>` : ''}
      </dl>
    </section>`;
}

/** First line of a practice item's text, for lists. */
export function itemPreview(it) {
  // A whole question (an MCQ) reads best as its summary; a part, as its own words.
  if (it.summary && it.id === it.rootId) return it.summary.charAt(0).toUpperCase() + it.summary.slice(1);
  const pick = (t) => String(t || '').split('\n').find((l) => l.trim() && !l.trim().startsWith('|')) || '';
  const text = pick(it.stem) || pick(it.context?.[it.context.length - 1]);
  return text.length > 140 ? text.slice(0, 137).trimEnd() + '…' : text;
}

/** "P1 Q19", "P2 Q3(a)(i)" */
export const shortLabel = (it) => `${it.paper} Q${it.label}`;

/** Why a question was picked as similar, in words a student can use. */
function similarReason(s) {
  const place = (code) => s.item.syllabus?.find((p) => p.subtopic.code === code);
  if (s.shared.length) {
    const p = place(s.shared[0]);
    return `Same subtopic: ${s.shared[0]} ${shortTopicName(p?.subtopic.name)}`.trim();
  }
  if (s.sameMain) return `Same main topic: ${s.item.mainTopic.name}`;
  if (s.sharedTopics.length) {
    const p = s.item.syllabus?.find((x) => x.topic.code === s.sharedTopics[0]);
    return `Same topic: ${s.sharedTopics[0]}${p?.topic.name ? ` ${p.topic.name}` : ''}`;
  }
  return 'Similar wording';
}

/**
 * Questions like this one, each linking to a page where it can be answered.
 * @param {Array<{ item: any, shared: string[], sharedTopics: string[] }>} list from bank.similar()
 */
export function similarList(list, { heading = 'Similar questions in the bank', note = '' } = {}) {
  if (!list?.length) return '';
  return html`<section class="similar" aria-labelledby="similar-h">
      <h2 class="similar-h" id="similar-h">${heading}</h2>
      ${note ? html`<p class="t-small t-muted">${note}</p>` : ''}
      <ol class="bank-list">${list.map((s) => html`<li><a class="bank-row similar-row" href="${tryHref(s.item)}">
        <span class="bank-label">${shortLabel(s.item)}</span>
        <span class="similar-main"><span class="bank-stem">${itemPreview(s.item)}</span><span class="similar-why">${similarReason(s)}</span></span>
        <span class="bank-meta">${s.item.type === 'mcq' ? 'MCQ' : 'Written'} · ${s.item.marks} ${s.item.marks === 1 ? 'mark' : 'marks'}</span>
      </a></li>`)}</ol>
    </section>`;
}
