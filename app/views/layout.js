// Shared pieces for every page: the document shell, the inline icon sprite,
// the app header (wordmark, user chip, Log out form) and small helpers.
// No browser JavaScript anywhere.

import { html, raw } from './html.js';

// Icons and the Steady rating symbols. Same geometry as the approved mockups
// (design/assets/rating-icons.svg, recoloured with currentColor). Inline, so
// <use href="#..."> works without extra requests.
const SYMBOLS = {
  'steady-none': '<symbol id="steady-none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2.6 2.6" stroke-linecap="round"/></symbol>',
  'steady-shaky': '<symbol id="steady-shaky" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.75" fill="none" stroke="currentColor" stroke-width="3"/></symbol>',
  'steady-getting': '<symbol id="steady-getting" viewBox="0 0 24 24"><path d="M3.75 12A8.25 8.25 0 0 0 20.25 12Z" fill="currentColor"/><circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" stroke-width="2.5"/></symbol>',
  'steady-solid': '<symbol id="steady-solid" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="currentColor"/></symbol>',
  'i-flask': '<symbol id="i-flask" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7 15h10"/></symbol>',
  'i-lock': '<symbol id="i-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></symbol>',
  'i-arrow': '<symbol id="i-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>',
  'i-back': '<symbol id="i-back" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></symbol>',
  'i-logout': '<symbol id="i-logout" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></symbol>',
  'i-eye': '<symbol id="i-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>',
  'i-down': '<symbol id="i-down" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></symbol>',
  'i-alert': '<symbol id="i-alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.01"/></symbol>',
  'i-info': '<symbol id="i-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></symbol>',
  'i-key': '<symbol id="i-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></symbol>',
  'i-wifi-off': '<symbol id="i-wifi-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></symbol>',
  'i-tools': '<symbol id="i-tools" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/></symbol>',
};

/**
 * The inline SVG sprite with just the symbols a page uses.
 * @param {string[]} ids
 */
export function sprite(ids) {
  return raw(
    '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">\n  <defs>\n' +
    ids.map((id) => '    ' + SYMBOLS[id]).join('\n') +
    '\n  </defs>\n</svg>'
  );
}

/**
 * An icon from the sprite. `cls` and `size` are code constants, never user data.
 * @param {string} id @param {{ cls?: string, size?: number, style?: string }} [opts]
 */
export function icon(id, { cls = '', size = 0, style = '' } = {}) {
  return raw(
    `<svg${cls ? ` class="${cls}"` : ''}${size ? ` width="${size}" height="${size}"` : ''} aria-hidden="true"${style ? ` style="${style}"` : ''}><use href="#${id}"/></svg>`
  );
}

/**
 * Full HTML document.
 * @param {{ title: string, symbols: string[], body: unknown }} p
 * @returns {string}
 */
export function page({ title, symbols, body }) {
  return String(html`<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1280">
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="/public/assets/favicon.svg">
  <link rel="stylesheet" href="/public/styles.css">
</head>
<body>
${sprite(symbols)}
${body}
</body>
</html>
`);
}

/**
 * Two-letter avatar initials from a username: "jun_wei" -> "JW", "mum" -> "MU".
 * @param {string} username
 */
export function initials(username) {
  const parts = String(username || '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

/** The Log out button: a POST form so it can't be triggered by a link. */
export function logoutForm() {
  return html`<form class="logout-form" method="post" action="/logout"><button class="btn btn-ghost" type="submit">${icon('i-logout', { size: 20 })}Log out</button></form>`;
}

/**
 * App header. With a user it shows the user chip and Log out.
 * @param {{ username: string } | null} [user]
 */
export function appHeader(user) {
  return html`<header class="app-header">
  <div class="container">
    <a class="brand" href="/"><img src="/public/assets/logo-wordmark.svg" alt="Steady, home" width="106" height="34"></a>
    ${user ? html`<div class="header-right">
      <span class="user-chip"><span class="avatar" aria-hidden="true">${initials(user.username)}</span>${user.username}</span>
      ${logoutForm()}
    </div>` : ''}
  </div>
</header>`;
}

/** Common symbol set for pages with the app header. */
export const HEADER_SYMBOLS = ['i-logout'];

/**
 * Only same-site paths ("/x") and fragments ("#x") are allowed in links built
 * from data; anything else (javascript:, //evil, https://...) becomes "#".
 * The result still goes through html`` escaping.
 * @param {unknown} u
 */
export function safeHref(u) {
  const s = String(u ?? '');
  return /^(\/(?![\/\\])|#)/.test(s) ? s : '#';
}
