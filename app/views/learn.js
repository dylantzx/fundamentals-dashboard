// "Understand: <topic>" (GET /learn/:topicId), students only.
// First Steady's own explanation of the topic (big idea, drawings, key points,
// a worked example, a common mistake), so he can get it without leaving the app.
// Then a few checked, free outside pages, and always a way back to practising.
// Outside links are plain links that open in a new tab: nothing is embedded.

import { html, raw } from './html.js';
import { page, icon, appHeader, safeHref, HEADER_SYMBOLS } from './layout.js';
import { renderIllustration } from './illustrations/index.js';
import { isSafeUrl } from '../lib/sources.js';

const SYMBOLS = ['i-back', 'i-arrow', 'i-alert', 'i-wifi-off', ...HEADER_SYMBOLS];

/** Groups in the order shown: notes first, then syllabus and interactive pages. */
const GROUPS = [
  { title: 'Notes', types: ['notes'] },
  { title: 'Syllabus and interactive', types: ['syllabus', 'interactive'] },
];

const TYPE_TEXT = { notes: 'Notes', syllabus: 'Syllabus', interactive: 'Interactive' };

/** Outside links must be https; anything else becomes a dead "#". */
const externalHref = (u) => (isSafeUrl(u) ? u : '#');

function sourceItem(s) {
  return html`<li class="source">
          <a class="source-title" href="${externalHref(s.url)}" target="_blank" rel="noopener noreferrer">${s.title}<span class="sr-only"> (opens another website)</span></a>
          <p class="source-meta"><span class="source-type">${TYPE_TEXT[s.type] || s.type}</span>${s.publisher}</p>
          <p class="source-why">${s.why}</p>${s.caution ? html`
          <p class="source-caution">${icon('i-alert', { size: 16 })}<span>${s.caution}</span></p>` : ''}
        </li>`;
}

function summaryBlock(summary) {
  if (!summary) return '';
  const pictures = summary.illustrations.map((name) => renderIllustration(name)).filter(Boolean);
  return html`<section class="card learn-card" aria-labelledby="idea-title">
    <div class="learn-idea">
      <h2 class="t-eyebrow" id="idea-title">The big idea</h2>
      <p class="learn-bigidea">${summary.bigIdea}</p>
    </div>
    ${pictures.map((svg) => html`<figure class="learn-figure">${raw(svg)}</figure>`)}
    <div>
      <h2 class="learn-h2">Key points</h2>
      <ul class="learn-points">
        ${summary.keyPoints.map((p) => html`<li>${p}</li>`)}
      </ul>
    </div>
    <div class="learn-pair">
      <section class="learn-example" aria-labelledby="ex-title">
        <h2 class="learn-h2" id="ex-title">Worked example</h2>
        <p class="learn-q">${summary.example.question}</p>
        <ol class="learn-steps">
          ${summary.example.steps.map((s) => html`<li>${s}</li>`)}
        </ol>
        <p class="learn-answer"><strong>Answer:</strong> ${summary.example.answer}</p>
      </section>
      <section class="learn-mistake" aria-labelledby="mistake-title">
        <h2 class="learn-h2" id="mistake-title">${icon('i-alert', { size: 20 })}Common mistake</h2>
        <p><strong>Not this:</strong> ${summary.mistake.wrong}</p>
        <p><strong>Instead:</strong> ${summary.mistake.right}</p>
      </section>
    </div>
  </section>`;
}

/**
 * @param {{
 *   user: { username: string },
 *   topic: { id: string, n: number, name: string },
 *   summary: import('../lib/summaries.js').Summary | null,
 *   sources: import('../lib/sources.js').Source[],
 *   practiseHref: string,
 * }} m
 * @returns {string}
 */
export function renderLearn(m) {
  const sources = m.sources || [];
  const groups = GROUPS
    .map((g) => ({ ...g, items: sources.filter((s) => g.types.includes(s.type)) }))
    .filter((g) => g.items.length);

  const body = html`${appHeader(m.user)}

<main class="container learn">
  <div class="practice-top">
    <a class="link-action" href="/dashboard">${icon('i-back', { size: 16 })}Dashboard</a>
    <div class="practice-title">
      <p class="t-eyebrow">Chemistry · Topic ${m.topic.n}</p>
      <h1 class="t-h1">Understand: ${m.topic.name}</h1>
    </div>
  </div>

  ${summaryBlock(m.summary)}

  <section class="card learn-more" aria-labelledby="more-title">
    <h2 class="t-h2" id="more-title">Want to read more?</h2>
    <p class="t-muted">Prefer to read it explained another way? These are free and match what your syllabus asks.</p>
    ${groups.map((g) => html`<div class="source-group">
      <h3 class="source-group-title">${g.title}</h3>
      <ul class="sources">
        ${g.items.map(sourceItem)}
      </ul>
    </div>`)}
    <p class="learn-offline">${icon('i-wifi-off', { size: 18 })}Steady works offline; these links need the internet.</p>
  </section>

  <div class="learn-actions">
    <a class="btn btn-primary btn-lg" href="${safeHref(m.practiseHref)}">Back to practising${icon('i-arrow', { cls: 'arrow', size: 22 })}</a>
  </div>
</main>`;

  return page({ title: `Understand: ${m.topic.name} · Steady`, symbols: SYMBOLS, body });
}
