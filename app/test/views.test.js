// Views: render each page with sample data and check the key content.
// The dashboard samples reproduce the three approved mockups' numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, html, raw } from '../views/html.js';
import { renderLogin } from '../views/login.js';
import { renderSetup } from '../views/setup.js';
import { renderDashboard } from '../views/dashboard.js';
import { renderParentHome } from '../views/parent.js';
import { renderComingNext, renderNotFound } from '../views/placeholder.js';

const EVIL = '<img src=x onerror=1>';
const EVIL_ESCAPED = '&lt;img src=x onerror=1&gt;';

// ---- Sample DashboardModels (same shape as lib/dashboard-model.js output) ----
const NAMES = ['Subatomic particles and nuclide notation', 'Electron arrangement', 'Isotopes',
  'Ions and ionic bonding', 'Covalent bonding', 'Structure and properties'];
const TEXT = { unrated: 'Not rated yet', shaky: 'Shaky', getting: 'Getting there', solid: 'Solid' };
const SUBJECTS = ['Chemistry', 'English', 'Mother Tongue', 'E Math', 'A Math', 'Physics', 'Biology', 'Combined Humanities']
  .map((name, i) => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name, active: i === 0 }));

function topic(i, label, right, total) {
  return { id: `t${i + 1}`, n: i + 1, name: NAMES[i], label, labelText: TEXT[label], right, total,
    needMore: label === 'unrated' ? 3 - total : 0, href: `/practise/t${i + 1}` };
}
const nextUpOf = (t) => ({ id: t.id, name: t.name, label: t.label, labelText: t.labelText,
  right: t.right, total: t.total, href: t.href, minutes: 10, questions: 5 });
const base = (username) => ({ user: { username }, checksTotal: 6, subjects: SUBJECTS });

function firstTime(username = 'jun_wei') {
  return { ...base(username), state: 'first-time', checksDone: 0,
    topics: NAMES.map((_, i) => topic(i, 'unrated', 0, 0)),
    nextUp: null,
    nextCheck: { n: 1, href: '/check/1', questions: 3, minutes: 3 },
    chemistry: { label: null, labelText: null, breakdown: { shaky: 0, getting: 0, solid: 0, unrated: 6 } } };
}
function partWay(username = 'jun_wei') {
  const topics = [topic(0, 'solid', 3, 3), topic(1, 'shaky', 1, 3), topic(2, 'unrated', 0, 1),
    topic(3, 'unrated', 0, 0), topic(4, 'unrated', 0, 0), topic(5, 'unrated', 0, 0)];
  return { ...base(username), state: 'part-way', checksDone: 2, topics,
    nextUp: nextUpOf(topics[1]),
    nextCheck: { n: 3, href: '/check/3', questions: 3, minutes: 3 },
    chemistry: { label: null, labelText: null, breakdown: { shaky: 1, getting: 0, solid: 1, unrated: 4 } } };
}
function returning(username = 'jun_wei') {
  const topics = [topic(0, 'solid', 4, 5), topic(1, 'getting', 3, 5), topic(2, 'shaky', 1, 3),
    topic(3, 'shaky', 2, 5), topic(4, 'getting', 2, 4), topic(5, 'getting', 2, 3)];
  return { ...base(username), state: 'returning', checksDone: 6, topics,
    nextUp: nextUpOf(topics[2]),
    nextCheck: null,
    chemistry: { label: 'getting', labelText: 'Getting there', breakdown: { shaky: 2, getting: 3, solid: 1, unrated: 0 } } };
}

/** Text content with tags removed and whitespace collapsed, for phrase checks. */
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const count = (s, needle) => s.split(needle).length - 1;

function assertCommon(out) {
  assert.match(out, /^<!doctype html>/);
  assert.ok(out.includes('<link rel="stylesheet" href="/public/styles.css">'));
  assert.ok(out.includes('href="/public/assets/favicon.svg"'));
  assert.ok(!/<script/i.test(out), 'no <script>');
  assert.ok(!/\son[a-z]+=/i.test(out.replaceAll(EVIL_ESCAPED, '')), 'no inline event handlers');
  assert.ok(!out.includes('proto-nav'), 'no mockup switcher');
  assert.ok(!/https?:\/\//.test(out.replace('http://www.w3.org', '')), 'no external URLs');
}
function assertLogoutForm(out) {
  assert.match(out, /<form class="logout-form" method="post" action="\/logout"><button class="btn btn-ghost" type="submit">[\s\S]*?Log out<\/button><\/form>/);
}

// ---- html.js ----
test('escapeHtml escapes the five HTML characters (and backtick)', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&\``), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(5), '5');
});

test('html escapes interpolations, joins arrays, passes raw() and nested html through', () => {
  const items = ['<b>', html`<i>${'&'}</i>`, raw('<hr>')];
  const out = String(html`<p title="${'"q"'}">${EVIL}</p><ul>${items}</ul>${null}${undefined}${false}${0}`);
  assert.equal(out, `<p title="&quot;q&quot;">${EVIL_ESCAPED}</p><ul>&lt;b&gt;<i>&amp;</i><hr></ul>0`);
});

// ---- Login ----
test('login: default state', () => {
  const out = renderLogin({ error: null, username: '', notice: null });
  assertCommon(out);
  assert.match(out, /<form id="login-form" method="post" action="\/login"/);
  assert.ok(out.includes('name="username"') && out.includes('name="password"'));
  assert.ok(text(out).includes('Stuck on a topic? Get unstuck here.'));
  assert.ok(out.includes('From shaky to <em>steady</em>.'));
  assert.ok(out.includes('/public/assets/logo-dark.svg'));
  assert.ok(!out.includes('role="alert"'));
  assert.ok(!out.includes('Caps Lock'), 'no Caps Lock hint (needs browser JS)');
});

test('login: bad credentials keeps the username (escaped), never the password', () => {
  const out = renderLogin({ error: 'bad-credentials', username: EVIL, notice: null });
  assertCommon(out);
  assert.ok(out.includes('role="alert"'));
  assert.ok(text(out).includes('That username and password don’t match. Check both and try again.'));
  assert.ok(out.includes(`value="${EVIL_ESCAPED}"`));
  assert.ok(!out.includes(EVIL));
  assert.equal(count(out, 'aria-invalid="true"'), 2);
  assert.doesNotMatch(out, /name="password"[^>]*value=/);
});

test('login: logged-out and idle notices', () => {
  assert.ok(text(renderLogin({ notice: 'logged-out' })).includes('You’ve logged out.'));
  assert.ok(text(renderLogin({ notice: 'idle' })).includes('20 minutes'));
  assert.ok(!renderLogin({ notice: 'bogus' }).includes('role="status"'));
});

// ---- Setup ----
test('setup: four fields, min 8 characters, nickname hint', () => {
  const out = renderSetup({ errors: {}, values: {} });
  assertCommon(out);
  assert.match(out, /<form method="post" action="\/setup"/);
  for (const name of ['parentUsername', 'parentPassword', 'studentUsername', 'studentPassword']) {
    assert.ok(out.includes(`name="${name}"`), name);
  }
  assert.equal(count(out, 'minlength="8"'), 2);
  assert.ok(text(out).includes('A nickname will do.'));
  assert.ok(text(out).includes('At least 8 characters.'));
  assert.ok(!out.includes('role="alert"'));
});

test('setup: field-level errors, usernames kept (escaped), passwords never re-filled', () => {
  const out = renderSetup({
    errors: { parentPassword: 'Use at least 8 characters.', studentUsername: 'That name is taken <b>' },
    values: { parentUsername: EVIL, studentUsername: 'jun_wei' },
  });
  assertCommon(out);
  assert.ok(out.includes('role="alert"'));
  assert.ok(text(out).includes('2 details need fixing.'));
  assert.ok(out.includes('Use at least 8 characters.'));
  assert.ok(out.includes('That name is taken &lt;b&gt;'));
  assert.ok(out.includes(`value="${EVIL_ESCAPED}"`));
  assert.ok(!out.includes(EVIL));
  assert.ok(out.includes('value="jun_wei"'));
  assert.doesNotMatch(out, /type="password"[^>]*value=/);
  assert.equal(count(out, 'aria-invalid="true"'), 2);
});

// ---- Dashboard ----
const STATES = { 'first-time': firstTime, 'part-way': partWay, returning };

for (const [state, make] of Object.entries(STATES)) {
  test(`dashboard (${state}): shell, header, 8 subjects, 6 tiles, key`, () => {
    const out = renderDashboard(make());
    assertCommon(out);
    assertLogoutForm(out);
    assert.ok(out.includes('<img src="/public/assets/logo-wordmark.svg" alt="Steady, home" width="106" height="34">'));
    assert.ok(out.includes('<span class="avatar" aria-hidden="true">JW</span>jun_wei</span>'));
    // 8 subjects: Chemistry as the card, 7 in coming soon
    assert.ok(out.includes('<h2 class="subject-name" id="chem-title">Chemistry</h2>'));
    const soon = out.match(/<ul class="soon-list">([\s\S]*?)<\/ul>/)[1];
    assert.deepEqual([...soon.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]),
      ['English', 'Mother Tongue', 'E Math', 'A Math', 'Physics', 'Biology', 'Combined Humanities']);
    // 6 topic tiles, each a link with Practise →
    assert.equal(count(out, '<a class="topic'), 6);
    assert.equal(count(out, '<span class="topic-go">Practise'), 6);
    for (let i = 1; i <= 6; i++) assert.ok(out.includes(`href="/practise/t${i}"`));
    assert.ok(text(out).includes('Stuck on something specific? Pick the topic'));
    // the ratings key
    for (const k of ['Shaky under half right', 'Getting there half to ¾ right', 'Solid over ¾ right', 'Not rated yet fewer than 3 answers']) {
      assert.ok(text(out).includes(k), k);
    }
    assert.ok(text(out).includes('Counts your last 5 answers per topic, right without a hint. Solid needs 2 exam-style ones.'));
  });
}

test('dashboard (first-time): checks card, parent line, nothing rated', () => {
  const out = renderDashboard(firstTime());
  const t = text(out);
  assert.ok(t.includes('Welcome to Steady · Chemistry'));
  assert.ok(t.includes('See what to work on'));
  assert.ok(out.includes('<a class="btn btn-primary btn-lg" href="/check/1">Start check 1 of 6'));
  assert.ok(t.includes('Skip for now'));
  assert.ok(out.includes('href="#topics"'));
  assert.ok(t.includes('3 questions · about 3 min'));
  assert.ok(t.includes('0 of 6 done'));
  assert.equal(count(out, '<i></i>'), 6);
  assert.ok(t.includes('Your parent sees topics, scores and time spent, not your actual answers.'));
  assert.ok(t.includes('0 of 6 topics rated'));
  assert.equal(count(out, 'class="chip chip--unrated"'), 7); // 6 tiles + overall
  assert.ok(t.includes("warm-up questions until it's rated") || out.includes('warm-up questions until it&#39;s rated'));
  assert.ok(!out.includes('topic--next'));
  assert.ok(!out.includes('settle'));
});

test('dashboard (part-way): next up, needs-more chip, checks left, no overall yet', () => {
  const out = renderDashboard(partWay());
  const t = text(out);
  assert.ok(t.includes('Next up in Chemistry'));
  assert.ok(out.includes('<h1 class="next-title" id="next-title">Electron arrangement</h1>'));
  assert.ok(out.includes('<span class="chip chip--shaky chip-lg">'));
  assert.ok(t.includes('Shaky · 1/3'));
  assert.ok(t.includes('Your lowest score so far'));
  assert.ok(out.includes('<a class="btn btn-primary btn-lg" href="/practise/t2">Start'));
  assert.ok(out.includes('<a class="link-action" href="/check/3">Finish the checks</a>'));
  assert.ok(t.includes('5 questions · about 10 min · checks left: 4 topics, about 3 min each'));
  assert.ok(t.includes('2 of 6 checks done'));
  assert.equal(count(out, '<i class="done"></i>'), 2);
  assert.equal(count(out, '<i class="part"></i>'), 1);
  assert.ok(t.includes('Needs 2 more answers'));
  assert.ok(t.includes('Solid · 3/3'));
  assert.ok(t.includes('Overall: once all 6 are rated'));
  assert.ok(t.includes('1 Shaky 1 Solid 4 not rated yet'));
  assert.equal(count(out, 'topic--next'), 1);
  assert.match(out, /<a class="topic topic--next" href="\/practise\/t2">[\s\S]*?Electron arrangement<span class="next-tag">Next up<\/span>/);
  assert.ok(!out.includes('parent sees'), 'parent line only on the first visit');
  assert.ok(!out.includes('settle play'));
});

test('dashboard (returning): Isotopes next up, breakdown, overall, settle on Solid', () => {
  const out = renderDashboard(returning());
  const t = text(out);
  assert.ok(out.includes('<h1 class="next-title" id="next-title">Isotopes</h1>'));
  assert.ok(t.includes('Shaky · 1/3'));
  assert.ok(t.includes('Your lowest score right now'));
  assert.ok(out.includes('href="/practise/t3">Start'));
  assert.ok(t.includes('5 questions · about 10 min · a hint and worked steps if you get stuck'));
  assert.ok(!t.includes('Finish the checks'));
  assert.ok(!out.includes('class="progress"'));
  assert.match(out, /<span class="overall-label">Overall <span class="chip chip--getting">.*?Getting there<\/span><\/span>/);
  assert.ok(t.includes('2 Shaky 3 Getting there 1 Solid'));
  for (const s of ['Solid · 4/5', 'Getting there · 3/5', 'Shaky · 1/3', 'Shaky · 2/5', 'Getting there · 2/4', 'Getting there · 2/3']) {
    assert.ok(t.includes(s), s);
  }
  assert.equal(count(out, '<span class="sr-only"> right without a hint</span>'), 7); // 6 tiles + next up
  assert.ok(out.includes('<span class="chip chip--solid settle play" title="Just levelled up to Solid">'));
  assert.equal(count(out, 'settle play'), 1);
  assert.match(out, /<a class="topic topic--next" href="\/practise\/t3">/);
  assert.ok(!out.includes('parent sees'));
});

test('dashboard: a justLevelledUp flag from the model controls the settle animation', () => {
  const m = returning();
  m.topics[0].justLevelledUp = false;
  assert.ok(!renderDashboard(m).includes('settle'));
  const p = partWay();
  p.topics[0].justLevelledUp = true;
  assert.ok(renderDashboard(p).includes('chip--solid settle play'));
});

test('dashboard: malicious username and topic data are escaped; bad hrefs neutralised', () => {
  const m = returning(EVIL);
  m.topics[1].name = EVIL;
  m.topics[1].href = 'javascript:alert(1)';
  m.nextUp.href = '//evil.example/x';
  const out = renderDashboard(m);
  assertCommon(out);
  assert.ok(!out.includes(EVIL));
  assert.ok(out.includes(`</span>${EVIL_ESCAPED}</span>`), 'username in the header chip');
  assert.ok(out.includes(`<span class="topic-num">2</span>${EVIL_ESCAPED}`));
  assert.ok(!out.includes('javascript:'));
  assert.ok(!out.includes('evil.example'));
});

test('dashboard: unrated chip with 1 answer says "Needs 2 more answers", with 2 answers "Needs 1 more answer"', () => {
  const m = partWay();
  m.topics[3] = { ...m.topics[3], total: 2, needMore: 1 };
  const t = text(renderDashboard(m));
  assert.ok(t.includes('Needs 2 more answers'));
  assert.ok(t.includes('Needs 1 more answer '));
});

// ---- Parent and placeholders ----
test('parent home: greeting, student account, sessions, log out', () => {
  const out = renderParentHome({ user: { username: 'mum' }, student: { username: EVIL } });
  assertCommon(out);
  assertLogoutForm(out);
  assert.ok(text(out).includes('Hi mum'));
  assert.ok(text(out).includes('Student account'));
  assert.ok(out.includes(EVIL_ESCAPED) && !out.includes(EVIL));
  assert.ok(text(out).includes('No sessions yet'));
  assert.ok(text(out).includes('not the actual answers'));
  const none = renderParentHome({ user: { username: 'mum' }, student: null });
  assert.ok(text(none).includes('No student account yet'));
});

test('coming next and not found', () => {
  const out = renderComingNext({ title: `Practice ${EVIL}`, backHref: '/dashboard' });
  assertCommon(out);
  assert.ok(text(out).includes('This part of Steady is being built.'));
  assert.ok(out.includes('href="/dashboard"'));
  assert.ok(text(out).includes('Back to your dashboard'));
  assert.ok(!out.includes(EVIL));
  assert.ok(renderComingNext({ title: 'x', backHref: 'javascript:alert(1)' }).includes('href="#"'));
  const nf = renderNotFound();
  assertCommon(nf);
  assert.ok(text(nf).includes('This page doesn’t exist'));
  assert.ok(nf.includes('href="/"'));
});
