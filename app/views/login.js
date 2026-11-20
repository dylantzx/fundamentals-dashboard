// Login page: matches design/login.html (default and #error states).
// Differences from the mockup, both because the app ships no browser JavaScript:
// - no Caps Lock warning (it needs a key listener);
// - no Show/Hide password toggle (same reason).

import { html } from './html.js';
import { page, icon } from './layout.js';

const SYMBOLS = ['steady-shaky', 'steady-getting', 'steady-solid', 'i-arrow', 'i-alert', 'i-info', 'i-key', 'i-wifi-off'];

const NOTICES = {
  'logged-out': 'You’ve logged out. See you next time.',
  idle: 'You were logged out after 20 minutes with no activity. Log in again to carry on.',
};

/**
 * The Night panel on the left of the login and setup pages.
 * @param {unknown} pitch  the middle block (heading, text, list)
 */
export function authSide(pitch) {
  return html`<aside class="login-side">
    <img src="/public/assets/logo-dark.svg" alt="Steady" width="137" height="44" style="height:44px;width:auto;position:relative;z-index:1">

    ${pitch}

    <div style="position:relative;z-index:1;display:grid;gap:8px">
      <p class="tagline">From shaky to <em>steady</em>.</p>
      <p class="login-foot">${icon('i-wifi-off', { size: 16 })}Works without internet. Everything stays on this laptop.</p>
    </div>
  </aside>`;
}

/**
 * @param {{ error?: null | 'bad-credentials', username?: string, notice?: null | 'logged-out' | 'idle' }} [p]
 * @returns {string}
 */
export function renderLogin({ error = null, username = '', notice = null } = {}) {
  const bad = error === 'bad-credentials';
  const noticeText = !bad && notice ? NOTICES[notice] : null;
  const invalid = bad ? html` aria-invalid="true"` : '';

  const body = html`<div class="login-page">
  ${authSide(html`<div class="login-pitch">
      <h1>Stuck on a topic?<br>Get unstuck here.</h1>
      <p>Pick the topic, answer short questions, and get a hint or worked steps the moment you’re stuck. No hunting through videos.</p>
      <ul class="pitch-list">
        <li>${icon('steady-shaky', { cls: 'dot dot--a' })}See which topics are shaky</li>
        <li>${icon('steady-getting', { cls: 'dot dot--b' })}Short sets: 5 questions, about 10 min</li>
        <li>${icon('steady-solid', { cls: 'dot dot--c' })}Hints and worked steps on every question</li>
      </ul>
    </div>`)}

  <main class="login-main">
    <div class="login-card">
      <h2 class="t-h1">Log in</h2>
${bad ? html`
      <div class="alert alert--error" id="login-error" role="alert">
        ${icon('i-alert', { size: 20 })}
        <span>That username and password don’t match. Check both and try again.</span>
      </div>
` : ''}${noticeText ? html`
      <div class="alert alert--info" role="status">
        ${icon('i-info', { size: 20 })}
        <span>${noticeText}</span>
      </div>
` : ''}
      <form id="login-form" method="post" action="/login" novalidate>
        <div class="field">
          <label for="username">Username</label>
          <input class="input" id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${username || ''}"${invalid}${bad || username ? '' : html` autofocus`}>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input class="input" id="password" name="password" type="password" autocomplete="current-password" required${invalid}${bad || username ? html` autofocus` : ''}>
        </div>
        <button class="btn btn-primary btn-lg btn-block" type="submit">
          Log in
          ${icon('i-arrow', { cls: 'arrow', size: 22 })}
        </button>
      </form>

      <div class="login-help">
        <p>${icon('i-key', { size: 20, style: 'margin-top:2px' })}
          <span>Forgot your password? Your parent can reset it from their account.</span></p>
        <p class="t-small t-muted">Parents log in here with their own account.</p>
      </div>
    </div>
  </main>
</div>`;

  return page({ title: 'Log in · Steady', symbols: SYMBOLS, body });
}
