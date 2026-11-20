// Tiny HTML templating with escaping by default.
//
//   html`<p>${name}</p>`      -> every interpolation is escaped
//   html`<ul>${items}</ul>`   -> arrays are joined (each item escaped unless it is safe HTML)
//   html`${raw('<b>ok</b>')}` -> raw() marks trusted markup that passes through unchanged
//
// html`` returns a SafeHtml value, so templates nest without double escaping.
// Call String(value) (or `${value}`) to get the final string.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/**
 * Escape text for use in HTML element content and quoted attribute values.
 * null and undefined become ''.
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

/** Markup that is already safe. Only html`` and raw() create it. */
class SafeHtml {
  /** @param {string} value */
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

/**
 * Mark a string as trusted HTML. Use only for markup written in this codebase,
 * never for user data.
 * @param {unknown} s
 * @returns {SafeHtml}
 */
export function raw(s) {
  return s instanceof SafeHtml ? s : new SafeHtml(s === null || s === undefined ? '' : String(s));
}

/** @param {unknown} v @returns {string} */
function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(v);
}

/**
 * Tagged template: escapes every interpolated value.
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {SafeHtml}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
