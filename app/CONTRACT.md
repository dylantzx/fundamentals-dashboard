# Steady: landing site build contract (v1)

Three agents build this in parallel, in separate worktrees. Each one owns certain files and must not create or edit anyone else's. The coordinator merges the three by copying. **Never run git commit or git push.**

## Goal
A working local web app for **Steady** (tagline "From shaky to steady."), a study app for a Singapore Sec 3-4 student. This version covers only:
- first-run setup (create the parent and student accounts)
- login and logout
- the student landing dashboard, in three states (first-time, part-way, returning), looking exactly like the approved mockups
- a simple parent landing page

Practice, the quick check and the other pages are NOT built yet. Their links go to a "Coming next" placeholder page.

## Tech (fixed)
- Node 20 (already installed). **Zero npm dependencies.** Use only `node:` built-ins: `node:http`, `node:crypto` (scrypt), `node:fs`, `node:path`, `node:url`, `node:test`, `node:assert`.
- ES modules: `package.json` has `"type": "module"`. Plain JavaScript (.js) with JSDoc types where helpful.
- Server-rendered HTML, with no browser JavaScript except what the design mockups already contain (none should be needed).
- Listen on 127.0.0.1, port 4600 (env `PORT` overrides). Data lives in `app/data/` (env `STEADY_DATA_DIR` overrides). Works fully offline: no CDN fonts or scripts.
- Tests: `node --test` in `app/test/`.

## Approved design (read-only source)
`/Users/Dylan/Desktop/AI Workshop/fundamentals-dashboard/worktrees/uiux-designer/design/`: login.html, landing-first-time.html, landing-part-way.html, landing.html, styles.css, assets/, DESIGN-NOTES.md. The pages must match these visually. Remove the reviewer-only dark "Mockup" switcher bar.

## Folder layout (inside `repo/app/`) and ownership

| Path | Owner |
|---|---|
| `server.js`, `lib/store.js`, `lib/auth.js`, `lib/sessions.js`, `lib/routes.js`, `lib/http-utils.js`, `test/server.test.js`, `test/auth.test.js`, `test/store.test.js` | **SERVER agent** |
| `views/*.js`, `public/**` (styles.css, assets/*), `test/views.test.js` | **PAGES agent** |
| `lib/dashboard-model.js`, `lib/ratings.js`, `scripts/seed-demo.js`, `package.json`, `README.md`, `Start Steady.command`, `test/model.test.js`, `test/ratings.test.js`, `.gitignore` | **MODEL agent** |
| `CONTRACT.md` | coordinator (read-only for everyone) |

To run things before the merge, an agent may create *temporary* stand-ins for files it doesn't own, but they must sit in `app/.stubs/`, which is never merged. Code that imports another owner's module uses the real path below.

## Interfaces

### Store: `lib/store.js` (SERVER)
```js
export function createStore(dataDir) // returns store; creates dir; JSON file `${dataDir}/db.json`, written atomically (write tmp + rename)
store.hasUsers() -> boolean
store.findUserByUsername(username) -> User | null   // case-insensitive match
store.getUser(id) -> User | null
store.addUser({ username, role, passwordHash }) -> User   // role: 'parent' | 'student'; id = random hex
store.listUsers() -> User[]
store.getProgress(userId) -> Progress    // default for new student: { topics: {}, checksDone: 0 }
store.setProgress(userId, progress) -> void
// User = { id, username, role, passwordHash, createdAt }
// Progress = { topics: { [topicId]: { right: number, total: number } }, checksDone: number }  // checksDone 0..6
```

### Ratings: `lib/ratings.js` (MODEL), pure functions
```js
export const TOPICS = [ // fixed order, PRD sub-skills, student-facing names from the design
  { id: 't1', n: 1, name: '...' }, ... 6 items ]   // use the exact topic names shown in the mockups
export function labelFor({ right, total }) -> 'unrated' | 'shaky' | 'getting' | 'solid'
// rule from the design key: total < 3 -> unrated; right/total < 0.5 -> shaky; 0.5..0.75 inclusive -> getting; > 0.75 -> solid
export const LABEL_TEXT = { unrated: 'Not rated yet', shaky: 'Shaky', getting: 'Getting there', solid: 'Solid' }
```

### Dashboard model: `lib/dashboard-model.js` (MODEL), pure
```js
export function buildDashboardModel({ user, progress }) -> DashboardModel
// DashboardModel = {
//   user: { username },
//   state: 'first-time' | 'part-way' | 'returning',   // first-time: checksDone===0 and no topic rated; returning: all 6 rated; else part-way
//   checksDone: number, checksTotal: 6,
//   topics: [{ id, n, name, label, labelText, right, total, needMore /* answers still needed to rate, 0 if rated */, href: '/practise/t1' }],
//   nextUp: null | { id, name, label, labelText, right, total, href, minutes: 10, questions: 5 },   // weakest rated topic: shaky before getting before solid, tie by list order; null if nothing rated
//   nextCheck: null | { n, href: '/check/n', questions: 3, minutes: 3 },   // the next unfinished check when checksDone < 6
//   chemistry: { label /* overall, null until all 6 rated */, labelText, breakdown: { shaky, getting, solid, unrated } },
//   subjects: [{ id, name, active: boolean }]   // 8 subjects; only Chemistry is active; use the names/order from the mockup (E Math, A Math etc.)
// }
// Overall Chemistry label = average of (shaky=1, getting=2, solid=3) over the 6 topics, rounded the way the mockups show ("Getting there" for the returning sample). Document the rule in a comment.
```

### Views: `views/*.js` (PAGES); each exports pure functions returning a full HTML string
```js
// views/html.js
export function escapeHtml(s) ; export function html`...` // tagged template that escapes interpolations; export function raw(s)
// views/login.js
export function renderLogin({ error /* null | 'bad-credentials' */, username /* prefill */, notice /* null | 'logged-out' | 'idle' */ })
// views/setup.js
export function renderSetup({ errors /* {field: message} */, values /* {parentUsername, studentUsername} */ })
// fields: parentUsername, parentPassword, studentUsername, studentPassword (min 8 chars each)
// views/dashboard.js
export function renderDashboard(model /* DashboardModel */)   // one template covering all 3 states, matching the 3 mockups
// views/parent.js
export function renderParentHome({ user: { username }, student: { username } | null })   // simple, on-brand: "Hi <name>"; the student's account; "Session summaries coming soon"; log out
// views/placeholder.js
export function renderComingNext({ title, backHref })   // "This part of Steady is being built. Back to your dashboard."
export function renderNotFound()
```
Every page links `/public/styles.css` and the favicon `/public/assets/favicon.svg`, with logos from `/public/assets/`. Log out is a `<form method="post" action="/logout">` button. Forms post to `/login` and `/setup`, with field names as above.

### Routes: `lib/routes.js` + `server.js` (SERVER)
- `GET /` → no users ? `/setup` : not logged in ? `/login` : student ? `/dashboard` : `/parent`
- `GET|POST /setup` (only while there are no users; afterwards it redirects to `/login`). POST creates both accounts and redirects to `/login`.
- `GET|POST /login`: on failure re-render with `error: 'bad-credentials'` and the username kept. On success set the session cookie and redirect to `/`.
- `POST /logout` → clear the session and redirect to `/login?notice=logged-out`
- `GET /dashboard` (student only) → `renderDashboard(buildDashboardModel({ user, progress: store.getProgress(user.id) }))`
- `GET /parent` (parent only)
- `GET /practise/:topicId`, `GET /check/:n`, and any other in-app link from the dashboard → `renderComingNext`
- `GET /public/*` → static files from `public/` (path-traversal safe, with correct content types: css, svg, png, ico)
- Anything else → 404 with `renderNotFound()`
- Sessions: random 32-byte id in an HttpOnly, SameSite=Lax cookie `steady_sid`, kept in memory. 20-minute idle timeout → redirect to `/login?notice=idle`.
- Passwords: scrypt with a 16-byte random salt, stored as `scrypt$N$r$p$saltHex$hashHex`, compared with timingSafeEqual. For an unknown username still run one hash. Use N=16384 by default (env `STEADY_SCRYPT_N` overrides; tests use a small N).
- Security headers: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. POST bodies are capped at 10 KB and parsed as urlencoded. Never log passwords or request bodies.

### Scripts (MODEL)
- `package.json` scripts: `"start": "node server.js"`, `"test": "node --test test/"`, `"seed-demo": "node scripts/seed-demo.js"`
- `scripts/seed-demo.js [first-time|part-way|returning]` sets the student's progress so each landing state can be demoed. `returning` matches the mockup's numbers (Isotopes Shaky 1/3 next up, the breakdown 2 Shaky · 3 Getting there · 1 Solid). It uses `createStore` from `lib/store.js`.
- `Start Steady.command`: a double-clickable macOS script that cds into its own folder's `app/`, runs `node server.js` and opens `http://localhost:4600`.
- `README.md`: how to start, set up, seed the demo states, and stop.
