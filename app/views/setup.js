// First-run setup: create the parent and the student account.
// New page (not in the mockups), built from the login page's parts: the same
// Night panel on the left, the same fields, buttons and crimson error style.
// Passwords are never re-filled after an error; usernames are.

import { html } from './html.js';
import { page, icon } from './layout.js';
import { authSide } from './login.js';

const SYMBOLS = ['steady-shaky', 'steady-getting', 'steady-solid', 'i-arrow', 'i-alert', 'i-wifi-off'];

/**
 * One labelled input with an optional hint and a field-level error.
 * @param {{ name: string, label: string, note?: string, type: string, autocomplete: string,
 *           hint: string, value?: string, error?: string }} f
 */
function field({ name, label, note, type, autocomplete, hint, value, error }) {
  const hintId = `${name}-hint`;
  const errId = `${name}-error`;
  // An error replaces the hint, so the page keeps its height and fits one laptop screen.
  const describedBy = error ? errId : hintId;
  const isPassword = type === 'password';
  return html`<div class="field">
            <label for="${name}">${label}${note ? html` <span class="label-note">${note}</span>` : ''}</label>
            <input class="input" id="${name}" name="${name}" type="${type}" autocomplete="${autocomplete}"${isPassword ? html` minlength="8"` : html` autocapitalize="none" spellcheck="false" maxlength="32"`} required${isPassword ? '' : html` value="${value || ''}"`} aria-describedby="${describedBy}"${error ? html` aria-invalid="true"` : ''}>
            ${error
              ? html`<p class="field-error" id="${errId}">${icon('i-alert', { size: 16 })}<span>${error}</span></p>`
              : html`<p class="field-hint" id="${hintId}">${hint}</p>`}
          </div>`;
}

/**
 * @param {{ errors?: Record<string, string>, values?: { parentUsername?: string, studentUsername?: string } }} [p]
 * @returns {string}
 */
export function renderSetup({ errors = {}, values = {} } = {}) {
  errors = errors || {};
  values = values || {};
  const fieldNames = ['parentUsername', 'parentPassword', 'studentUsername', 'studentPassword'];
  const errorCount = fieldNames.filter((k) => errors[k]).length;
  // A form-wide message may come as errors.form. Otherwise a short summary
  // (announced by screen readers) points at the field-level messages.
  const formError = errors.form || (errorCount
    ? `${errorCount === 1 ? 'One detail needs' : `${errorCount} details need`} fixing. See the ${errorCount === 1 ? 'field' : 'fields'} marked below.`
    : null);

  const body = html`<div class="login-page">
  ${authSide(html`<div class="login-pitch">
      <h1>Set up Steady<br>on this laptop.</h1>
      <p>Two accounts, about a minute. One for the parent, one for the student. Everything stays on this laptop.</p>
      <ul class="pitch-list">
        <li>${icon('steady-shaky', { cls: 'dot dot--a' })}The student sees which topics are shaky</li>
        <li>${icon('steady-getting', { cls: 'dot dot--b' })}Short sets with hints and worked steps</li>
        <li>${icon('steady-solid', { cls: 'dot dot--c' })}The parent sees topics, scores and time spent</li>
      </ul>
    </div>`)}

  <main class="login-main login-main--setup">
    <div class="login-card setup-card">
      <h2 class="t-h1">Set up two accounts</h2>
      <p class="t-lead">One for the parent, one for the student. You’ll use them to log in.</p>
${formError ? html`
      <div class="alert alert--error" role="alert">
        ${icon('i-alert', { size: 20 })}
        <span>${formError}</span>
      </div>
` : ''}
      <form method="post" action="/setup" novalidate>
        <fieldset class="account-group">
          <legend>Parent account</legend>
          <div class="field-row">
          ${field({ name: 'parentUsername', label: 'Username', type: 'text', autocomplete: 'off', hint: 'Letters and numbers are fine.', value: values.parentUsername, error: errors.parentUsername })}
          ${field({ name: 'parentPassword', label: 'Password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters.', error: errors.parentPassword })}
          </div>
        </fieldset>

        <fieldset class="account-group">
          <legend>Student account</legend>
          <div class="field-row">
          ${field({ name: 'studentUsername', label: 'Username', type: 'text', autocomplete: 'off', hint: 'A nickname will do.', value: values.studentUsername, error: errors.studentUsername })}
          ${field({ name: 'studentPassword', label: 'Password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters.', error: errors.studentPassword })}
          </div>
        </fieldset>

        <button class="btn btn-primary btn-lg btn-block" type="submit">
          Create both accounts
          ${icon('i-arrow', { cls: 'arrow', size: 22 })}
        </button>
      </form>
    </div>
  </main>
</div>`;

  return page({ title: 'Set up · Steady', symbols: SYMBOLS, body });
}
