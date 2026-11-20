// Student dashboard: ONE template for the three approved mockups
//   design/landing-first-time.html  (state 'first-time')
//   design/landing-part-way.html    (state 'part-way')
//   design/landing.html             (state 'returning')
// The markup and classes copy the mockups exactly; only the data changes.
// Input is a DashboardModel from lib/dashboard-model.js (see CONTRACT.md).
// Every value from the model goes through html`` and is escaped.

import { html } from './html.js';
import { page, icon, appHeader, safeHref, HEADER_SYMBOLS } from './layout.js';

const SYMBOLS = [
  'steady-none', 'steady-shaky', 'steady-getting', 'steady-solid',
  'i-flask', 'i-lock', 'i-arrow', ...HEADER_SYMBOLS, 'i-eye', 'i-down',
];

/** Rating label -> sprite symbol */
const ICON_FOR = { unrated: 'steady-none', shaky: 'steady-shaky', getting: 'steady-getting', solid: 'steady-solid' };
const TEXT_FOR = { unrated: 'Not rated yet', shaky: 'Shaky', getting: 'Getting there', solid: 'Solid' };

/** @param {string} label */
const safeLabel = (label) => (Object.hasOwn(ICON_FOR, label) ? label : 'unrated');

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * A rating chip: "Shaky · 1/3" with its icon, or "Not rated yet" / "Needs 2 more answers".
 * @param {{ label: string, labelText?: string, right?: number, total?: number, needMore?: number }} r
 * @param {{ lg?: boolean, settle?: boolean, settleTitle?: string }} [opts]
 */
function chip(r, { lg = false, settle = false, settleTitle = '' } = {}) {
  const label = safeLabel(r.label);
  const text = r.labelText || TEXT_FOR[label];
  const cls = `chip chip--${label}${lg ? ' chip-lg' : ''}${settle ? ' settle play' : ''}`;
  if (label === 'unrated') {
    const words = r.total > 0 && r.needMore > 0
      ? `Needs ${r.needMore} more ${plural(r.needMore, 'answer', 'answers')}`
      : text;
    return html`<span class="${cls}">${icon(ICON_FOR[label], { cls: 'dot' })}${words}</span>`;
  }
  return html`<span class="${cls}"${settleTitle ? html` title="${settleTitle}"` : ''}>${icon(ICON_FOR[label], { cls: 'dot' })}${text}<span class="sep" aria-hidden="true">·</span><span class="score">${r.right}/${r.total}</span><span class="sr-only"> right without a hint</span></span>`;
}

/**
 * Six-segment check progress. Check n covers topic n, so the next check counts
 * as started (a part-filled segment, as in landing-part-way.html) when its
 * topic already has some answers.
 * @param {any} m @param {string} caption
 */
function progress(m, caption) {
  const total = m.checksTotal || 6;
  const done = m.checksDone || 0;
  const c = m.nextCheck;
  const started = c && m.topics.some((t) => t.n === c.n && t.total > 0) ? c.n : 0;
  const segs = [];
  for (let i = 1; i <= total; i++) {
    segs.push(i <= done ? html`<i class="done"></i>` : i === started ? html`<i class="part"></i>` : html`<i></i>`);
  }
  return html`<div class="progress" aria-label="Checks done: ${done} of ${total}${started ? `, check ${started} started` : ''}">${segs}<span>${caption}</span></div>`;
}

/** Left column, top: the one primary action. */
function nextCard(m) {
  const total = m.checksTotal || 6;
  const done = m.checksDone || 0;

  // Nothing rated yet: the checks are the main action (first visit, or checks started but no topic rated).
  if (!m.nextUp) {
    const first = m.state === 'first-time';
    const c = m.nextCheck;
    return html`<section class="next" aria-labelledby="next-title">
      <p class="t-eyebrow">${first ? 'Welcome to Steady · Chemistry' : 'Chemistry checks'}</p>
      <h1 class="next-title" id="next-title">See what to work on</h1>
      <p class="t-lead">${first
        ? `${total} short checks, one per topic. Do one now, the rest whenever you like.`
        : `${done} of ${total} checks done. Do the next one now, the rest whenever you like.`}</p>
      ${progress(m, `${done} of ${total} done`)}
      <div class="next-cta">
        ${c ? html`<a class="btn btn-primary btn-lg" href="${safeHref(c.href)}">Start check ${c.n} of ${total}${icon('i-arrow', { cls: 'arrow', size: 22 })}</a>` : ''}
        <a class="link-action" href="#topics">Skip for now${icon('i-down', { size: 16 })}</a>
      </div>
      ${c ? html`<p class="next-note"><strong>${c.questions} questions · about ${c.minutes} min</strong> · no marks shown · stop any time, your progress saves</p>` : ''}
      ${first ? html`<p class="next-aside">${icon('i-eye', { size: 18 })}Your parent sees topics, scores and time spent, not your actual answers.</p>` : ''}
    </section>`;
  }

  const n = m.nextUp;
  const c = m.state === 'returning' ? null : m.nextCheck; // the checks link only while the checks are unfinished
  const checksLeft = total - done;
  return html`<section class="next" aria-labelledby="next-title">
      <p class="t-eyebrow">Next up in Chemistry</p>
      <h1 class="next-title" id="next-title">${n.name}</h1>
      <div class="next-why">${chip(n, { lg: true })}<span>${m.state === 'returning' ? 'Your lowest score right now' : 'Your lowest score so far'}</span></div>
      <div class="next-cta">
        <a class="btn btn-primary btn-lg" href="${safeHref(n.href)}">Start${icon('i-arrow', { cls: 'arrow', size: 22 })}</a>${c ? html`
        <a class="link-action" href="${safeHref(c.href)}">Finish the checks</a>` : ''}
      </div>
      <p class="next-note"><strong>${n.questions} questions · about ${n.minutes} min</strong> · ${c
        ? `checks left: ${checksLeft} ${plural(checksLeft, 'topic', 'topics')}, about ${c.minutes} min each`
        : 'a hint and worked steps if you get stuck'}</p>${c ? html`
      ${progress(m, `${done} of ${total} checks done`)}` : ''}
    </section>`;
}

/** Left column, bottom: the seven subjects that aren't live yet. */
function soonBlock(subjects) {
  const soon = (subjects || []).filter((s) => !s.active);
  return html`<section class="soon" aria-labelledby="soon-title">
      <h2 class="soon-head" id="soon-title">${icon('i-lock', { size: 18 })}More subjects coming soon</h2>
      <ul class="soon-list">
        ${soon.map((s) => html`<li>${s.name}</li>`)}
      </ul>
    </section>`;
}

/** Chemistry card header: overall label and breakdown. */
function overall(m) {
  const b = m.chemistry?.breakdown || { shaky: 0, getting: 0, solid: 0, unrated: 0 };
  const rated = (b.shaky || 0) + (b.getting || 0) + (b.solid || 0);
  const totalTopics = m.topics.length;
  let label;
  if (m.chemistry?.label && m.chemistry.label !== 'unrated') {
    label = html`<span class="overall-label">Overall ${overallChip(m.chemistry)}</span>`;
  } else if (rated === 0) {
    label = html`<span class="overall-label">Overall ${overallChip({ label: 'unrated' })}</span>`;
  } else {
    label = html`<span class="overall-label">Overall: once all ${totalTopics} are rated</span>`;
  }

  let parts;
  if (rated === 0) {
    parts = html`<span>0 of ${totalTopics} topics rated</span>`;
  } else {
    const items = [
      ['shaky', b.shaky, 'Shaky'],
      ['getting', b.getting, 'Getting there'],
      ['solid', b.solid, 'Solid'],
      ['unrated', b.unrated, 'not rated yet'],
    ].filter(([, count]) => count > 0);
    parts = items.map(([k, count, words]) => html`<span>${icon(ICON_FOR[k], { cls: `dot dot--${k}` })}${count} ${words}</span>`);
  }
  return html`<div class="overall">
        ${label}
        <div class="breakdown">${parts}</div>
      </div>`;
}

/** The overall chip has no score: just icon and words. */
function overallChip(c) {
  const label = safeLabel(c.label);
  return html`<span class="chip chip--${label}">${icon(ICON_FOR[label], { cls: 'dot' })}${c.labelText || TEXT_FOR[label]}</span>`;
}

/** One topic tile: a link with its rating chip and a visible "Practise →". */
function topicTile(t, isNext, state) {
  const label = safeLabel(t.label);
  // The brand's settle moment: plays once on a Solid chip (design/landing.html, topic 1).
  // If the model says which topic has just levelled up (optional t.justLevelledUp), that wins.
  // Without the flag it plays on Solid chips in the returning state only, as in the mockups
  // (the part-way mockup's Solid chip is still).
  const settle = label === 'solid' && (typeof t.justLevelledUp === 'boolean' ? t.justLevelledUp : state === 'returning');
  return html`<li><a class="topic${isNext ? ' topic--next' : ''}" href="${safeHref(t.href)}">
          <span class="topic-body"><span class="topic-name"><span class="topic-num">${t.n}</span>${t.name}${isNext ? html`<span class="next-tag">Next up</span>` : ''}</span>
            <span style="display:flex;align-items:center;gap:8px">${chip(t, { settle, settleTitle: settle ? 'Just levelled up to Solid' : '' })}</span></span>
          <span class="topic-go">Practise${icon('i-arrow', { size: 16 })}</span>
        </a></li>`;
}

/**
 * @param {import('../lib/dashboard-model.js').DashboardModel | any} model
 * @returns {string}
 */
export function renderDashboard(model) {
  const m = model;
  const topics = m.topics || [];
  const nextId = m.nextUp ? m.nextUp.id : null;
  const chem = (m.subjects || []).find((s) => s.active) || { name: 'Chemistry' };

  const body = html`${appHeader(m.user)}

<main class="container dash">
  <div class="dash-left">
    ${nextCard({ ...m, topics })}
    ${soonBlock(m.subjects)}
  </div>

  <section class="card subject-card" aria-labelledby="chem-title">
    <div class="subject-head">
      <div class="subject-id">
        <span class="subject-icon">${icon('i-flask', { size: 22 })}</span>
        <div><h2 class="subject-name" id="chem-title">${chem.name}</h2><p class="subject-topic">Atomic Structure and Chemical Bonding</p></div>
      </div>
      ${overall({ ...m, topics })}
    </div>

    <div class="pick-head">
      <h2 id="pick-title">Stuck on something specific? Pick the topic</h2>
      <span class="t-muted t-small">${m.nextUp ? 'or follow Next up' : "warm-up questions until it's rated"}</span>
    </div>
    <ul class="topics" id="topics" aria-labelledby="pick-title" tabindex="-1">
        ${topics.map((t) => topicTile(t, t.id === nextId, m.state))}
    </ul>
      <div class="key" aria-label="What the ratings mean">
        <p class="key-item">${icon('steady-shaky', { cls: 'dot dot--shaky' })}<span><strong>Shaky</strong>under half right</span></p>
        <p class="key-item">${icon('steady-getting', { cls: 'dot dot--getting' })}<span><strong>Getting there</strong>half to ¾ right</span></p>
        <p class="key-item">${icon('steady-solid', { cls: 'dot dot--solid' })}<span><strong>Solid</strong>over ¾ right</span></p>
        <p class="key-item">${icon('steady-none', { cls: 'dot dot--unrated' })}<span><strong>Not rated yet</strong>fewer than 3 answers</span></p>
        <p class="key-note">Counts your last 5 answers per topic, right without a hint. Solid needs 2 exam-style ones.</p>
      </div>
  </section>
</main>`;

  return page({ title: `${chem.name} · Steady`, symbols: SYMBOLS, body });
}
