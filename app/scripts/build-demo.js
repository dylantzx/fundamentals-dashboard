// Builds a static, clickable demo of Steady for GitHub Pages into ../docs/.
// The real app needs its Node server (accounts, saved answers). This demo is
// read-only: it renders the real views with sample data and rewrites links so
// they work as plain files. Run: node scripts/build-demo.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLogin } from '../views/login.js';
import { renderDashboard } from '../views/dashboard.js';
import { renderComingNext, renderNotFound } from '../views/placeholder.js';
import { buildDashboardModel } from '../lib/dashboard-model.js';
import { DEMO_PROGRESS } from './seed-demo.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(appDir, '..', 'docs');

const STATES = [
  { key: 'first-time', file: 'first-visit.html', label: 'First visit' },
  { key: 'part-way', file: 'part-way.html', label: 'Checks part-way' },
  { key: 'returning', file: 'returning.html', label: 'Returning student' },
];

const BANNER_CSS = `
.demo-banner{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:center;
  padding:8px 16px;background:#12263A;color:#F4F0E6;font:500 14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
.demo-banner strong{color:#8BD3A5}
.demo-banner a{color:#F4F0E6;text-decoration:underline;text-underline-offset:3px}
.demo-banner a[aria-current="page"]{color:#8BD3A5;text-decoration:none;font-weight:700}
.demo-choices{display:grid;gap:12px;margin-top:8px}
.demo-choices .btn{justify-content:space-between}
.demo-note{margin-top:16px;color:var(--slate,#5B6B78);font-size:14px}
`;

function banner(current) {
  const links = STATES.map((s) =>
    `<a href="${s.file}"${s.file === current ? ' aria-current="page"' : ''}>${s.label}</a>`).join(' · ');
  return `<div class="demo-banner" role="note"><span><strong>Demo only</strong>: nothing is saved and there are no real accounts.</span><span>See: ${links} · <a href="index.html">Log in page</a></span></div>`;
}

function staticise(html, current) {
  return html
    .replace(/(href|src)="\/public\//g, '$1="public/')
    .replace(/<link rel="stylesheet" href="public\/styles.css">/, (m) => `${m}\n<style>${BANNER_CSS}</style>`)
    // Log out (a POST form) becomes a link back to the log-in page.
    .replace(/<form class="logout-form" method="post" action="\/logout">([\s\S]*?)<button class="btn btn-ghost" type="submit">([\s\S]*?)<\/button><\/form>/,
      '<a class="btn btn-ghost logout-form" href="index.html">$2</a>')
    .replace(/href="\/(practise|check|chemistry|subject|subjects)[^"]*"/g, 'href="coming-next.html"')
    .replace(/href="\/(dashboard)?"/g, `href="${current === 'coming-next.html' ? 'returning.html' : current}"`)
    .replace(/<body([^>]*)>/, (m) => `${m}\n${banner(current)}`);
}

function loginDemo() {
  const page = renderLogin({ error: null, username: '', notice: null });
  const choices = `<div id="login-form">
        <p>This is a demo. Pick what a student would see after logging in:</p>
        <div class="demo-choices">
          ${STATES.map((s, i) => `<a class="btn ${i === 2 ? 'btn-primary' : 'btn-secondary'} btn-lg btn-block" href="${s.file}">${s.label} →</a>`).join('\n          ')}
        </div>
        <p class="demo-note">The real Steady runs on the family laptop, with its own accounts and saved progress.</p>
      </div>`;
  const out = page.replace(/<form id="login-form"[\s\S]*?<\/form>/, choices);
  if (out === page) throw new Error('Login form not found; the view changed.');
  return staticise(out, 'index.html');
}

function write(name, html) {
  fs.writeFileSync(path.join(outDir, name), html);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(path.join(appDir, 'public'), path.join(outDir, 'public'), { recursive: true });
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

write('index.html', loginDemo());
for (const s of STATES) {
  const model = buildDashboardModel({ user: { username: 'student' }, progress: DEMO_PROGRESS[s.key] });
  write(s.file, staticise(renderDashboard(model), s.file));
}
const comingNext = staticise(renderComingNext({ title: 'Practice and the quick check', backHref: '/dashboard' }), 'coming-next.html')
  .replace('Your progress so far is saved.', 'In this demo, nothing is saved.');
write('coming-next.html', comingNext);
write('404.html', staticise(renderNotFound(), '404.html'));

const leftovers = fs.readdirSync(outDir).filter((f) => f.endsWith('.html'))
  .flatMap((f) => [...fs.readFileSync(path.join(outDir, f), 'utf8').matchAll(/(?:href|src|action)="(\/[^"]*)"/g)].map((m) => `${f}: ${m[1]}`));
if (leftovers.length) {
  console.error('Absolute links left that will break on GitHub Pages:\n' + leftovers.join('\n'));
  process.exit(1);
}
console.log(`Demo written to ${outDir}`);
