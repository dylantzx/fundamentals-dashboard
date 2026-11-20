// Practice and quick-check pages built from real exam questions, plus the
// question-bank browser. Server-rendered, no browser JavaScript: MCQs are a
// form, the mark scheme sits in a <details> element.

import { html } from './html.js';
import { showFigure } from '../lib/question-bank.js';
import { page, icon, appHeader, safeHref, HEADER_SYMBOLS } from './layout.js';
import { questionBody, markScheme, printed, sourceTag, topicTags, richText, figures, marksTag, scan } from './question.js';

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

function feedbackBanner(m) {
  const fb = m.feedback;
  if (!fb) return '';
  const right = fb.picked === m.item.correctOption;
  return html`<div class="result ${right ? 'result--right' : 'result--wrong'}" role="status">
      <p class="result-title">${right ? 'Right.' : `Not this time. The answer is ${m.item.correctOption}.`}</p>
      ${m.item.markScheme.some((a) => a.crops.length) ? html`<details class="q-printed"><summary>See the school’s answer key</summary>${m.item.markScheme.flatMap((a) => a.crops.map((c) => scan(c, { alt: 'Answer key as printed', cls: 'q-crop' })))}</details>` : ''}
      <a class="btn btn-primary btn-lg" href="${safeHref(m.nextHref)}">${m.isLast ? 'Finish' : 'Next question'}${icon('i-arrow', { cls: 'arrow', size: 22 })}</a>
    </div>`;
}

/**
 * @param {{
 *   user: { username: string }, mode: 'practise' | 'check', checkN?: number,
 *   topic: { id: string, n: number, name: string }, rating: any,
 *   base: string, index: number, count: number, item: any | null,
 *   feedback: null | { picked: string }, nextHref: string, isLast: boolean,
 *   done: boolean, source: string,
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
      ${questionBody(it)}
      ${it.type === 'mcq' ? mcq(m) : structured(m)}
      ${feedbackBanner(m)}
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
export function renderBankIndex({ user, papers, groups, source, backHref }) {
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
export function renderBankQuestion({ user, root, paperName, source }) {
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
      ${topicTags(collectTopics(root))}
    </div>
  </div>
  <section class="card practice-card">
    ${node(root, 0)}
    ${printed({ label: root.label, fullQuestion: root.assets?.full_question, hasHandwriting: root.has_handwriting })}
  </section>
</main>`;
  return page({ title: `Question ${root.label} · Steady`, symbols: SYMBOLS, body });
}

function collectTopics(n, out = []) {
  out.push(...(n.topics || []).filter((t) => !t.inherited));
  for (const c of n.children || []) collectTopics(c, out);
  return out;
}
