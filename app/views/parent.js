// Parent home: simple and on-brand. The parent's dashboard isn't designed yet,
// so this page says hello, shows the student's account and says what's coming.

import { html } from './html.js';
import { page, icon, appHeader, initials, HEADER_SYMBOLS } from './layout.js';

const SYMBOLS = [...HEADER_SYMBOLS, 'i-lock'];

/**
 * @param {{ user: { username: string }, student: { username: string } | null }} p
 * @returns {string}
 */
export function renderParentHome({ user, student }) {
  const body = html`${appHeader(user)}

<main class="container page-simple">
  <section class="card simple-card" aria-labelledby="parent-title">
    <p class="t-eyebrow">Parent account</p>
    <h1 class="t-h1" id="parent-title">Hi ${user.username}</h1>
    <p class="t-lead">Steady is set up on this laptop. Your student logs in with their own account.</p>

    ${student
      ? html`<div class="account-line">
      <span class="avatar" aria-hidden="true">${initials(student.username)}</span>
      <div><p>Student account</p><strong>${student.username}</strong></div>
    </div>`
      : html`<div class="account-line">
      <div><p>Student account</p><strong>No student account yet</strong></div>
    </div>`}

    <section class="soon" aria-labelledby="summaries-title">
      <h2 class="soon-head" id="summaries-title">${icon('i-lock', { size: 18 })}Session summaries coming soon</h2>
      <p>You’ll see which topics are shaky, getting there or solid, scores and time spent. Not their actual answers.</p>
    </section>
  </section>
</main>`;

  return page({ title: 'Parent · Steady', symbols: SYMBOLS, body });
}
