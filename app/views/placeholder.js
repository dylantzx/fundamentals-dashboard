// "Coming next" placeholder for the parts of Steady that aren't built yet
// (practice sets, the quick checks), and the 404 page.

import { html } from './html.js';
import { page, icon, appHeader, safeHref } from './layout.js';

const SYMBOLS = ['i-back'];

/**
 * @param {{ title?: string, backHref?: string }} [p]
 * @returns {string}
 */
export function renderComingNext({ title = 'Coming next', backHref = '/' } = {}) {
  const body = html`${appHeader(null)}

<main class="container page-simple">
  <section class="card simple-card" aria-labelledby="page-title">
    <p class="t-eyebrow">Coming next</p>
    <h1 class="t-h1" id="page-title">${title}</h1>
    <p class="t-lead">This part of Steady is being built. Your progress so far is saved.</p>
    <div class="simple-actions">
      <a class="btn btn-primary btn-lg" href="${safeHref(backHref)}">${icon('i-back', { size: 22 })}Back to your dashboard</a>
    </div>
  </section>
</main>`;

  return page({ title: `${title || 'Coming next'} · Steady`, symbols: SYMBOLS, body });
}

/** @returns {string} */
export function renderNotFound() {
  const body = html`${appHeader(null)}

<main class="container page-simple">
  <section class="card simple-card" aria-labelledby="page-title">
    <p class="t-eyebrow">Not found</p>
    <h1 class="t-h1" id="page-title">This page doesn’t exist</h1>
    <p class="t-lead">The link may be old or mistyped.</p>
    <div class="simple-actions">
      <a class="btn btn-primary btn-lg" href="/">${icon('i-back', { size: 22 })}Back to Steady</a>
    </div>
  </section>
</main>`;

  return page({ title: 'Not found · Steady', symbols: SYMBOLS, body });
}
