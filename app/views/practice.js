// Practice and quick-check pages built from real exam questions, plus the
// question-bank browser. Server-rendered, no browser JavaScript: MCQs are a
// form, the mark scheme sits in a <details> element.

import { html } from './html.js';
import { showFigure } from '../lib/question-bank.js';
import { page, icon, appHeader, safeHref, HEADER_SYMBOLS } from './layout.js';
import { shortTopicName } from '../lib/syllabus.js';
import {
  questionBody, markScheme, printed, sourceTag, richText, figures, marksTag, scan,
  syllabusPanel, aboutItem, similarList, tryHref, topicHref, itemPreview, shortLabel,
} from './question.js';

const SYMBOLS = ['i-arrow', 'i-back', 'i-info', ...HEADER_SYMBOLS, 'steady-none', 'steady-shaky', 'steady-getting', 'steady-solid'];
const ICON_FOR = { unrated: 'steady-none', shaky: 'steady-shaky', getting: 'steady-getting', solid: 'steady-solid' };

/** Rating chip for the topic (same look as the dashboard). */
function chip(r) {
  const label = Object.hasOwn(ICON_FOR, r.label) ? r.label : 'unrated';
  return html`<span class="chip chip--${label}">${icon(ICON_FOR[label], { cls: 'dot' })}${r.labelText}${label !== 'unrated' ? html`<span class="sep" aria-hidden="true">·</span><span class="score">${r.right}/${r.total}</span>` : r.total ? html`<span class="sep" aria-hidden="true">·</span><span class="score">${r.right}/${r.total}</span>` : ''}</span>`;
}

/** Steps along the top: one dot per question in the set. */
function steps(count, index, done) {
  const items = [];
  for (let i = 0; i < count; i++) items.push(html`<i class="${done || i < index ? 'done' : i === index ? 'part' : ''}"></i>`);
  return html`<div class="progress" aria-label="Question ${Math.min(index + 1, count)} of ${count}">${items}<span>${done ? `${count} of ${count} done` : `Question ${index + 1} of ${count}`}</span></div>`;
}

/** MCQ: a form of radio options, or after answering, the options marked right and wrong. */
function mcq(m) {
  const it = m.item;
  const fb = m.feedback;
  if (fb) {
    return html`<ol class="opts opts--result" type="A">
      ${it.options.map((o) => {
        const cls = o.label === it.correctOption ? 'opt opt--correct' : o.label === fb.picked ? 'opt opt--wrong' : 'opt';
        const note = o.label === it.correctOption ? 'Correct answer' : o.label === fb.picked ? 'Your answer' : '';
        return html`<li class="${cls}"><span class="opt-letter">${o.label}</span><span class="opt-text">${richText(o.text)}</span>${note ? html`<span class="opt-note">${note}</span>` : ''}</li>`;
      })}
    </ol>`;
  }
  return html`<form method="post" action="${safeHref(m.base + '/answer')}" class="opts-form">
      <input type="hidden" name="i" value="${m.index}">
      <fieldset class="opts">
        <legend class="sr-only">Choose one answer</legend>
        ${it.options.map((o) => html`<label class="opt opt--pick"><input type="radio" name="choice" value="${o.label}" required><span class="opt-letter">${o.label}</span><span class="opt-text">${richText(o.text)}</span></label>`)}
      </fieldset>
      <div class="q-actions"><button class="btn btn-primary btn-lg" type="submit">Check my answer${icon('i-arrow', { cls: 'arrow', size: 22 })}</button></div>
    </form>`;
}

/** Structured part: answer on paper, open the mark scheme, then mark yourself. */
function structured(m) {
  const it = m.item;
  // Once self-marked, the mark scheme stays open next to the explanation.
  if (m.feedback) return markScheme(it);
  const onPaper = it.answerSpace === 'drawing' ? 'Draw your answer on paper' : 'Write your answer on paper or in your head';
  return html`<p class="q-hint">${icon('i-info', { size: 18 })}${onPaper}, then check it against the mark scheme.</p>
    <details class="q-reveal">
      <summary class="btn btn-secondary btn-lg">Show the mark scheme</summary>
      ${markScheme(it)}
      <form method="post" action="${safeHref(m.base + '/answer')}" class="self-mark">
        <input type="hidden" name="i" value="${m.index}">
        <p class="self-mark-q">Did you get ${it.marks > 1 ? 'all the marks' : 'the mark'}?</p>
        <button class="btn btn-primary" type="submit" name="self" value="right">Yes, I got it</button>
        <button class="btn btn-secondary" type="submit" name="self" value="wrong">Not quite</button>
      </form>
    </details>`;
}

/** One titled paragraph of explanation inside the result box. */
const whyBlock = (title, text, cls = '') => html`<section class="why${cls}"><h3 class="why-h">${title}</h3>${richText(text)}</section>`;

/** MCQ: why the right answer is right, why the student's pick is wrong, and the other options behind a disclosure. */
function mcqWhy(it, picked) {
  const ex = it.explanation;
  if (!ex) return '';
  const right = picked === it.correctOption;
  const others = it.options.filter((o) => o.label !== it.correctOption && o.label !== picked && ex.wrongNotes[o.label]);
  return html`${!right && ex.wrongNotes[picked] ? whyBlock(`Why ${picked} is wrong`, ex.wrongNotes[picked], ' why--wrong') : ''}
      ${ex.why ? whyBlock(`Why ${it.correctOption} is right`, ex.why) : ''}
      ${others.length ? html`<details class="q-printed why-more"><summary>Why the other ${others.length === 1 ? 'option is' : 'options are'} wrong</summary>
        <ul class="why-list">${others.map((o) => html`<li><span class="opt-letter">${o.label}</span><div>${richText(ex.wrongNotes[o.label])}</div></li>`)}</ul>
      </details>` : ''}`;
}

/** Written part: why the mark scheme's answer is right, and where marks are usually lost. */
function structuredWhy(it, gotIt) {
  const ex = it.explanation;
  if (!ex) return '';
  const slips = ex.slips.length ? html`<ul class="why-slips">${ex.slips.map((t) => html`<li>${t}</li>`)}</ul>` : '';
  return html`${ex.why ? whyBlock('Why this is the answer', ex.why) : ''}
      ${slips ? (gotIt
        ? html`<details class="q-printed why-more"><summary>Where marks are often lost</summary>${slips}</details>`
        : html`<section class="why why--wrong"><h3 class="why-h">Where marks are often lost</h3>${slips}</section>`) : ''}`;
}

function feedbackBanner(m) {
  const fb = m.feedback;
  if (!fb) return '';
  const it = m.item;
  const label = m.nextLabel ?? (m.isLast ? 'Finish' : 'Next question');
  const next = m.nextHref ? html`<a class="btn btn-primary btn-lg" href="${safeHref(m.nextHref)}">${label}${icon('i-arrow', { cls: 'arrow', size: 22 })}</a>` : '';
  if (it.type !== 'mcq') {
    const gotIt = fb.self === 'right';
    const marks = it.marks > 1 ? 'the marks' : 'the mark';
    return html`<div class="result ${gotIt ? 'result--right' : 'result--wrong'}" role="status">
      <p class="result-title">${gotIt ? `Nice. You got ${marks}.` : `Here is how to get ${marks}.`}</p>
      ${structuredWhy(it, gotIt)}
      ${next}
    </div>`;
  }
  const right = fb.picked === it.correctOption;
  return html`<div class="result ${right ? 'result--right' : 'result--wrong'}" role="status">
      <p class="result-title">${right ? 'Right.' : `Not this time. The answer is ${it.correctOption}.`}</p>
      ${mcqWhy(it, fb.picked)}
      ${it.markScheme.some((a) => a.crops.length) ? html`<details class="q-printed"><summary>See the school’s answer key</summary>${it.markScheme.flatMap((a) => a.crops.map((c) => scan(c, { alt: 'Answer key as printed', cls: 'q-crop' })))}</details>` : ''}
      ${next}
    </div>`;
}

/**
 * @param {{
 *   user: { username: string }, mode: 'practise' | 'check', checkN?: number,
 *   topic: { id: string, n: number, name: string }, rating: any,
 *   base: string, index: number, count: number, item: any | null,
 *   feedback: null | { picked: string } | { self: 'right' | 'wrong' }, nextHref: string, isLast: boolean,
 *   done: boolean, source: string, similar?: any[],
 * }} m
 */
export function renderPractice(m) {
  const eyebrow = m.mode === 'check' ? `Quick check ${m.checkN} of 6 · Chemistry` : `Practise · Topic ${m.topic.n}`;
  const title = m.topic.name;
  let main;

  if (!m.count) {
    main = html`<section class="card practice-card">
      <p class="t-lead">There are no reviewed questions on this topic in the bank yet.</p>
      <div class="q-actions"><a class="btn btn-primary btn-lg" href="/bank">Browse the question bank</a></div>
    </section>`;
  } else if (m.done) {
    main = html`<section class="card practice-card done-card">
      <h2 class="t-h2">${m.mode === 'check' ? `Check ${m.checkN} done` : 'Set done'}</h2>
      <p class="t-lead">You worked through ${m.count} real exam ${m.count === 1 ? 'question' : 'questions'} on ${m.topic.name}.</p>
      <div class="done-rating"><span>${m.topic.name} now:</span>${chip(m.rating)}</div>
      <div class="q-actions">
        <a class="btn btn-primary btn-lg" href="/dashboard">Back to your dashboard${icon('i-arrow', { cls: 'arrow', size: 22 })}</a>
        <a class="link-action" href="${safeHref(m.base)}">Go through them again</a>
        <a class="link-action" href="/bank">Browse the whole paper</a>
      </div>
    </section>`;
  } else {
    const it = m.item;
    main = html`<section class="card practice-card" aria-labelledby="q-title">
      <div class="q-head">
        <h2 class="t-h3" id="q-title">Question ${m.index + 1}</h2>
        ${sourceTag(it)}
      </div>
      ${syllabusPanel(aboutItem(it), it.syllabusTitle)}
      ${questionBody(it)}
      ${it.type === 'mcq' ? mcq(m) : structured(m)}
      ${feedbackBanner(m)}
      ${m.feedback ? similarList(m.similar, { note: 'Try one of these to practise the same idea. Your set is still here when you come back.' }) : ''}
      ${printed(it)}
    </section>`;
  }

  const body = html`${appHeader(m.user)}

<main class="container practice">
  <div class="practice-top">
    <a class="link-action" href="/dashboard">${icon('i-back', { size: 16 })}Dashboard</a>
    <div class="practice-title">
      <p class="t-eyebrow">${eyebrow}</p>
      <h1 class="t-h1">${title}</h1>
      <div class="practice-meta">${chip(m.rating)}${m.count ? steps(m.count, m.index, m.done) : ''}</div>
    </div>
    <p class="practice-source t-small t-muted">Real questions from ${m.source}</p>
  </div>
  ${main}
</main>`;

  return page({ title: `${title} · Steady`, symbols: SYMBOLS, body });
}

/** The question-bank index: every reviewed top-level question, by paper. */
export function renderBankIndex({ user, groups, source, backHref, syllabusIndex = [], syllabusTitle = '' }) {
  const body = html`${appHeader(user)}

<main class="container practice">
  <div class="practice-top">
    <a class="link-action" href="${safeHref(backHref)}">${icon('i-back', { size: 16 })}Back</a>
    <div class="practice-title">
      <p class="t-eyebrow">Question bank · Chemistry</p>
      <h1 class="t-h1">${source}</h1>
      <p class="t-lead">Every question that has passed review, transcribed from the scanned papers.</p>
    </div>
  </div>
  ${syllabusIndex.length ? html`<section class="card bank-group" aria-labelledby="g-syllabus">
    <h2 class="t-h2" id="g-syllabus">By MOE syllabus topic</h2>
    <p class="t-small t-muted">${syllabusTitle}. Pick a topic to see every question on it.</p>
    <ol class="bank-list">
      ${syllabusIndex.map((t) => html`<li class="syl-row">
        <a class="syl-topic" href="${topicHref(t.code)}"><span class="bank-label">${t.code}</span><span>${t.name || `Topic ${t.code}`}</span><span class="bank-meta">${t.count} ${t.count === 1 ? 'question' : 'questions'}</span></a>
        <ul class="q-tags">${t.subtopics.map((st) => html`<li><a href="${topicHref(st.code)}" title="${st.name}">${st.code} ${shortTopicName(st.name)} <span class="t-muted">(${st.count})</span></a></li>`)}</ul>
      </li>`)}
    </ol>
  </section>` : ''}
  ${groups.map((g) => html`<section class="card bank-group" aria-labelledby="g-${g.paper}">
    <h2 class="t-h2" id="g-${g.paper}">${g.title}</h2>
    <ol class="bank-list">
      ${g.questions.map((q) => html`<li><a class="bank-row" href="/bank/q/${q.id}">
        <span class="bank-label">${q.label}</span>
        <span class="bank-stem">${q.preview}</span>
        <span class="bank-meta">${q.type === 'mcq' ? 'MCQ' : `${q.parts} parts`} · ${q.marks} ${q.marks === 1 ? 'mark' : 'marks'}</span>
      </a></li>`)}
    </ol>
  </section>`)}
</main>`;
  return page({ title: 'Question bank · Steady', symbols: SYMBOLS, body });
}

/** A whole top-level question: every part, with its mark scheme behind a disclosure. */
export function renderBankQuestion({ user, root, paperName, source, about = {}, syllabusTitle = '', similar = [] }) {
  const node = (n, depth) => html`<div class="bank-node bank-node--d${Math.min(depth, 3)}">
      ${depth ? html`<p class="bank-part">${n.label}</p>` : ''}
      ${n.stem ? html`<div class="q-stem">${richText(n.stem)} ${marksTag(n.type !== 'context' ? n.marks : 0)}</div>` : ''}
      ${figures((n.assets?.figures || []).filter((f) => showFigure(f, n)))}
      ${n.options?.length ? html`<ol class="opts opts--result" type="A">${n.options.map((o) => html`<li class="opt${o.label === correct(n) ? ' opt--correct' : ''}"><span class="opt-letter">${o.label}</span><span class="opt-text">${richText(o.text)}</span></li>`)}</ol>` : ''}
      ${n.type === 'structured' && n.answers?.length ? html`<details class="q-reveal q-reveal--inline"><summary class="link-action">Mark scheme</summary>${markScheme({ markScheme: n.answers.map((a) => ({ text: a.answer_text, marks: a.marks, crops: a.crops || [] })) })}</details>` : ''}
      ${(n.children || []).map((c) => node(c, depth + 1))}
    </div>`;
  const correct = (n) => n.answers?.find((a) => a.correct_option)?.correct_option;

  const body = html`${appHeader(user)}

<main class="container practice">
  <div class="practice-top">
    <a class="link-action" href="/bank">${icon('i-back', { size: 16 })}All questions</a>
    <div class="practice-title">
      <p class="t-eyebrow">${source} · ${paperName}</p>
      <h1 class="t-h1">Question ${root.label}</h1>
    </div>
  </div>
  <section class="card practice-card">
    ${syllabusPanel(about, syllabusTitle)}
    ${node(root, 0)}
    ${printed({ label: root.label, fullQuestion: root.assets?.full_question, hasHandwriting: root.has_handwriting })}
  </section>
  ${similar.length ? html`<section class="card bank-group">${similarList(similar, { heading: 'Similar questions elsewhere in the bank' })}</section>` : ''}
</main>`;
  return page({ title: `Question ${root.label} · Steady`, symbols: SYMBOLS, body });
}

/**
 * Every question on one syllabus topic ("10") or subtopic ("10.2").
 * @param {{ user: any, code: string, title: string, parent: null | { code: string, name: string },
 *   syllabusTitle: string, subtopics: Array<{ code: string, name: string, count: number }>, items: any[], backHref: string }} m
 */
export function renderBankTopic(m) {
  const body = html`${appHeader(m.user)}

<main class="container practice">
  <div class="practice-top">
    <a class="link-action" href="${safeHref(m.backHref)}">${icon('i-back', { size: 16 })}${m.parent ? `Topic ${m.parent.code}` : 'Question bank'}</a>
    <div class="practice-title">
      <p class="t-eyebrow">MOE syllabus · ${m.syllabusTitle}${m.parent ? ` · Topic ${m.parent.code} ${m.parent.name}` : ''}</p>
      <h1 class="t-h1">${m.title}</h1>
      <p class="t-lead">${m.items.length} ${m.items.length === 1 ? 'question' : 'questions'} in the bank on this ${m.parent ? 'subtopic' : 'topic'}.</p>
    </div>
  </div>
  ${m.subtopics.length ? html`<section class="card bank-group" aria-labelledby="g-subs">
    <h2 class="t-h2" id="g-subs">Subtopics</h2>
    <ul class="q-tags">${m.subtopics.map((st) => html`<li><a href="${topicHref(st.code)}" title="${st.name}">${st.code} ${shortTopicName(st.name)} <span class="t-muted">(${st.count})</span></a></li>`)}</ul>
  </section>` : ''}
  <section class="card bank-group" aria-labelledby="g-items">
    <h2 class="t-h2" id="g-items">Questions</h2>
    ${m.items.length ? html`<ol class="bank-list">${m.items.map((it) => html`<li><a class="bank-row similar-row" href="${tryHref(it)}">
      <span class="bank-label">${shortLabel(it)}</span>
      <span class="bank-stem">${itemPreview(it)}</span>
      <span class="bank-meta">${it.type === 'mcq' ? 'MCQ' : 'Written'} · ${it.marks} ${it.marks === 1 ? 'mark' : 'marks'}</span>
    </a></li>`)}</ol>` : html`<p class="t-lead">No reviewed questions on this yet.</p>`}
  </section>
</main>`;
  return page({ title: `${m.title} · Steady`, symbols: SYMBOLS, body });
}

/**
 * One bank question to answer on its own (reached from "similar questions" or a topic page).
 * @param {{ user: any, item: any, feedback: any, similar: any[], source: string }} m
 */
export function renderTry(m) {
  const it = m.item;
  const base = tryHref(it);
  const first = it.syllabus?.[0];
  const nextHref = m.similar.length ? tryHref(m.similar[0].item) : first ? topicHref(first.subtopic.code) : '/bank';
  const pm = { ...m, base, index: 0, nextHref, nextLabel: m.similar.length ? 'Next similar question' : 'More on this topic', isLast: false };
  const body = html`${appHeader(m.user)}

<main class="container practice">
  <div class="practice-top">
    <a class="link-action" href="${first ? topicHref(first.subtopic.code) : '/bank'}">${icon('i-back', { size: 16 })}${first ? `All ${first.subtopic.code} questions` : 'Question bank'}</a>
    <div class="practice-title">
      <p class="t-eyebrow">Question bank · Chemistry</p>
      <h1 class="t-h1">${first ? shortTopicName(first.subtopic.name) : `Question ${it.label}`}</h1>
    </div>
    <p class="practice-source t-small t-muted">Real questions from ${m.source}</p>
  </div>
  <section class="card practice-card" aria-labelledby="q-title">
    <div class="q-head">
      <h2 class="t-h3" id="q-title">Question ${it.label}</h2>
      ${sourceTag(it)}
    </div>
    ${syllabusPanel(aboutItem(it), it.syllabusTitle)}
    ${questionBody(it)}
    ${it.type === 'mcq' ? mcq(pm) : structured(pm)}
    ${feedbackBanner(pm)}
    ${m.feedback ? similarList(m.similar) : ''}
    ${printed(it)}
  </section>
</main>`;
  return page({ title: `Question ${it.label} · Steady`, symbols: SYMBOLS, body });
}
