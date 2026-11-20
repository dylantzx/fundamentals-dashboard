// Parent page (PRD story 8): the test summary, the student's study sessions
// newest first, and the student account with a password reset.
//
// Calm and plain: one card per session, each with its facts and one form
// (Stayed / Went to video / Not recorded, and a note) whose Save is the main action.
// It shows topics, scores and time spent, never the student's actual answers:
// the model it is given has none.

import { html } from './html.js';
import { page, icon, appHeader, initials } from './layout.js';

const SYMBOLS = ['i-logout', 'steady-none', 'steady-shaky', 'steady-getting', 'steady-solid', 'i-lock', 'i-alert', 'i-info', 'i-key', 'i-arrow'];

const ICON_FOR = { unrated: 'steady-none', shaky: 'steady-shaky', getting: 'steady-getting', solid: 'steady-solid' };
const TEXT_FOR = { unrated: 'Not rated yet', shaky: 'Shaky', getting: 'Getting there', solid: 'Solid' };
const STATUS_TEXT = { stayed: 'Stayed', went_to_video: 'Went to video', not_recorded: 'Not recorded' };
const END_TEXT = { logout: 'Ended with Log out', idle: 'Ended after 20 minutes with nothing done', replaced: 'Ended by a new login' };

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * "45 sec", "12 min", "1 h 05 min".
 * @param {number} ms
 */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** @param {number} ms @param {string} [timeZone] */
function formatDay(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(ms);
}
/** @param {number} ms @param {string} [timeZone] */
function formatTime(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(ms);
}

/** A rating chip with its icon and word (no score). @param {{ label: string, labelText?: string }} r */
function chip(r) {
  const label = Object.hasOwn(ICON_FOR, r.label) ? r.label : 'unrated';
  return html`<span class="chip chip--${label}">${icon(ICON_FOR[label], { cls: 'dot' })}${r.labelText || TEXT_FOR[label]}</span>`;
}

function summaryCard(m) {
  const s = m.summary;
  const name = m.student ? m.student.username : 'your student';
  const status = s.state === 'met'
    ? html`<p class="summary-status summary-status--met">Target met: Stayed in ${s.stayed} sessions.</p>`
    : s.state === 'missed'
      ? html`<p class="summary-status">Target not met: ${plural(s.wentToVideo, 'session was', 'sessions were')} marked Went to video.</p>`
      : html`<p class="summary-status">${s.recorded === 0 ? 'Nothing recorded yet.' : `${plural(s.stayedNeeded, 'more Stayed session', 'more Stayed sessions')} needed.`}</p>`;
  return html`<section class="card parent-summary" aria-labelledby="summary-title">
    <div>
      <h2 class="t-eyebrow" id="summary-title">The test</h2>
      <p class="summary-figure"><strong>${s.stayed} of ${s.recorded}</strong> recorded ${s.recorded === 1 ? 'session' : 'sessions'} marked Stayed</p>
      ${status}
    </div>
    <p class="summary-target">Target: ${name} stays in Steady in at least ${s.target.stayed} of ${s.target.of} sessions. Stayed means no video or other outside help with this topic during the session.</p>
  </section>`;
}

function topicRows(sess) {
  if (!sess.topics.length) return html`<p class="t-muted">No questions answered in this session.</p>`;
  return html`<table class="session-topics">
        <caption class="sr-only">Topics practised</caption>
        <thead><tr><th scope="col">Topic practised</th><th scope="col">Answered</th><th scope="col">At the start</th><th scope="col">At the end</th></tr></thead>
        <tbody>
${sess.topics.map((t) => html`          <tr>
            <th scope="row">${t.name}</th>
            <td>${t.answered} <span class="t-muted">(${t.rightFirstTime} right first time)</span></td>
            <td>${chip(t.start)}</td>
            <td><span class="label-change">${icon('i-arrow', { size: 16, cls: 'label-arrow' })}${chip(t.end)}</span></td>
          </tr>
`)}        </tbody>
      </table>`;
}

function recordForm(sess, m) {
  const id = sess.id;
  const name = m.student ? m.student.username : 'he';
  const opt = (value) => html`<label class="status-opt"><input type="radio" name="status" value="${value}"${sess.record.status === value ? ' checked' : ''}>${STATUS_TEXT[value]}</label>`;
  return html`<form class="record-form" method="post" action="/parent/sessions/${id}/record">
        <input type="hidden" name="v" value="${sess.record.version}">
        <fieldset class="status-choice">
          <legend>Did ${name} stay in Steady?</legend>
          <div class="status-opts">${opt('stayed')}${opt('went_to_video')}${opt('not_recorded')}</div>
        </fieldset>
        <div class="field">
          <label for="note-${id}">Your note <span class="label-note">(optional)</span></label>
          <textarea class="input input--area" id="note-${id}" name="note" rows="3" maxlength="1000" aria-describedby="note-${id}-hint">
${sess.record.note}</textarea>
          <p class="field-hint" id="note-${id}-hint">What you saw: where ${name} got stuck, what was said, what was opened. Up to 1,000 characters.</p>
        </div>
        <div class="record-actions">
          <button class="btn btn-primary" type="submit">Save</button>
          ${m.savedId === id ? html`<p class="saved" role="status">Saved.</p>` : ''}
        </div>
      </form>`;
}

function sessionCard(sess, m) {
  const tz = m.timeZone;
  const recorded = sess.record.status !== 'not_recorded';
  return html`<article class="card session" id="s-${sess.id}" aria-labelledby="s-${sess.id}-title">
      <header class="session-head">
        <h3 class="t-h3" id="s-${sess.id}-title">${formatDay(sess.startedAt, tz)}, started ${formatTime(sess.startedAt, tz)}</h3>
        <span class="session-tag${recorded ? ' session-tag--done' : ''}">${sess.inProgress ? 'Still logged in' : STATUS_TEXT[sess.record.status]}</span>
      </header>
      <dl class="facts">
        <div><dt>Time spent</dt><dd>${formatDuration(sess.timeSpentMs)}</dd></div>
        <div><dt>Longest pause</dt><dd>${sess.longestPauseMs > 0 ? formatDuration(sess.longestPauseMs) : 'None'}</dd></div>
        <div><dt>Questions answered</dt><dd>${sess.answered}</dd></div>
        <div><dt>Right first time</dt><dd>${sess.rightFirstTime}${sess.answered ? html` <span class="t-muted">of ${sess.answered}</span>` : ''}</dd></div>
      </dl>
      ${topicRows(sess)}
      ${!sess.inProgress && sess.endReason ? html`<p class="t-small t-muted">${END_TEXT[sess.endReason] || ''}</p>` : ''}
      ${recordForm(sess, m)}
    </article>`;
}

function studentCard(m) {
  const errors = m.passwordErrors || {};
  const hasErrors = Boolean(errors.password || errors.confirm);
  const pwField = (name, label, hint) => {
    const err = errors[name];
    return html`<div class="field">
            <label for="pw-${name}">${label}</label>
            <input class="input" id="pw-${name}" name="${name}" type="password" autocomplete="new-password" minlength="8" maxlength="200" required aria-describedby="pw-${name}-${err ? 'error' : 'hint'}"${err ? html` aria-invalid="true"` : ''}>
            ${err
              ? html`<p class="field-error" id="pw-${name}-error">${icon('i-alert', { size: 16 })}<span>${err}</span></p>`
              : html`<p class="field-hint" id="pw-${name}-hint">${hint}</p>`}
          </div>`;
  };
  if (!m.student) {
    return html`<section class="card parent-account" id="student" aria-labelledby="student-title">
    <h2 class="t-h2" id="student-title">Student account</h2>
    <div class="account-line"><div><p>Student account</p><strong>No student account yet</strong></div></div>
  </section>`;
  }
  return html`<section class="card parent-account" id="student" aria-labelledby="student-title">
    <h2 class="t-h2" id="student-title">Student account</h2>
    <div class="account-line">
      <span class="avatar" aria-hidden="true">${initials(m.student.username)}</span>
      <div><p>Student account</p><strong>${m.student.username}</strong></div>
    </div>
    <details class="pw-reset"${hasErrors ? ' open' : ''}>
      <summary>${icon('i-key', { size: 18 })}Reset ${m.student.username}’s password</summary>
      <form method="post" action="/parent/student/password" novalidate>
        ${hasErrors ? html`<div class="alert alert--error" role="alert">${icon('i-alert', { size: 20 })}<span>The password was not changed. See the field marked below.</span></div>` : ''}
        <div class="field-row">
          ${pwField('password', 'New password', 'At least 8 characters.')}
          ${pwField('confirm', 'Type it again', 'So we know it’s right.')}
        </div>
        <button class="btn btn-secondary" type="submit">Change password</button>
      </form>
    </details>
  </section>`;
}

const NOTICE_TEXT = {
  stale: 'That change was not saved, because this session was changed in another window. Here is the latest. Make your change again if you still need it.',
  invalid: 'That change could not be saved. Please try again.',
  'password-changed': 'Password changed. Your student uses the new one next time they log in.',
};

/**
 * @param {{
 *   user: { username: string },
 *   student: { username: string } | null,
 *   summary?: ReturnType<typeof import('../lib/parent-model.js').buildParentModel>['summary'],
 *   sessions?: any[],
 *   notice?: null | 'stale' | 'invalid' | 'password-changed',
 *   savedId?: string | null,
 *   passwordErrors?: Record<string, string>,
 *   timeZone?: string,
 * }} m
 * @returns {string}
 */
export function renderParentHome(m) {
  m = {
    sessions: [],
    summary: { stayed: 0, recorded: 0, wentToVideo: 0, target: { stayed: 2, of: 3 }, state: 'open', stayedNeeded: 2 },
    ...m,
  };
  const name = m.student ? m.student.username : null;
  const notice = m.notice && NOTICE_TEXT[m.notice];
  const noticeIsError = m.notice === 'stale' || m.notice === 'invalid';

  const body = html`${appHeader(m.user)}

<main class="container parent">
  <div class="parent-intro">
    <p class="t-eyebrow">Parent account</p>
    <h1 class="t-h1" id="parent-title">Hi ${m.user.username}</h1>
    <p class="t-lead">${name
      ? html`After each session, choose Stayed or Went to video and add a note. You can change both later.`
      : 'Steady is set up on this laptop.'}</p>
  </div>
${notice ? html`
  <div class="alert ${noticeIsError ? 'alert--error' : 'alert--info'}" role="${noticeIsError ? 'alert' : 'status'}">
    ${icon(noticeIsError ? 'i-alert' : 'i-info', { size: 20 })}<span>${notice}</span>
  </div>
` : ''}
  ${summaryCard(m)}

  <section class="sessions" aria-labelledby="sessions-title">
    <h2 class="t-h2" id="sessions-title">Sessions${name ? html` <span class="t-muted">· ${name}, newest first</span>` : ''}</h2>
    ${m.sessions.length
      ? m.sessions.map((s) => sessionCard(s, m))
      : html`<p class="card sessions-empty">No sessions yet. Each time ${name || 'your student'} logs in, a session appears here.</p>`}
  </section>

  ${studentCard(m)}

  <p class="parent-privacy">${icon('i-lock', { size: 16 })}You see topics, scores and time spent, not the actual answers. ${name || 'Your student'} never sees this page or your notes.</p>
</main>`;

  return page({ title: 'Parent · Steady', symbols: SYMBOLS, body });
}
