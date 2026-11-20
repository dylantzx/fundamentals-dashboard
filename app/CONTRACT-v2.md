# Steady wave 2: practice, quick check and the question bank

This builds on the landing site in `app/`, which is on `main`. Read `app/CONTRACT.md` for the stack. It is unchanged: Node 20, **zero npm dependencies**, ES modules, server-rendered HTML, **no browser JavaScript**, and node:test.

**The rules come from the plan, the stack does not.** `../IMPL.md` (in the project folder, one level above `repo/`) and `../PRD.md` define *what* to build. Follow their rules, ids and wording: IMPL sections 3.2, 4.2–4.8, 5, 6, 7.1–7.4 and appendices A and B, and PRD sections 5, 6 and 8 to 10. Ignore IMPL's stack choices (TypeScript, Express, Vitest, journal file, folder layout). Wherever IMPL names a `src/...ts` file, use the matching `app/lib/...js` path below.

**Git:** each agent works in its own worktree on its own branch. Commit locally on your branch as often as you like. **Never push. Never merge.** The coordinator merges.

**Design:** match the approved Steady mockups and the existing `public/styles.css`. Rating icons, Shaky / Getting there / Solid wording, Forest/Coral/Chalk tokens. Student-facing copy says "topic" where the PRD says "sub-skill".

## Ownership (each agent creates or edits ONLY its own paths)

| Agent | Owns |
|---|---|
| **ENGINE** | `lib/engine/**`, `test/engine/**` |
| **BANK** | `lib/chem/**`, `lib/answers/**`, `lib/bank/**`, `content/subskills.json`, `content/fundamentals.json`, `content/periodic-table.json`, `content/bank/manifest.json`, `scripts/validate-bank.js`, `scripts/blind-export.js`, `scripts/blind-compare.js`, `views/periodic-table.js`, `test/bank/**`, `test/chem/**`, `test/answers/**` |
| **CONTENT-1** | `content/bank/s1.json`, `content/bank/s2.json` |
| **CONTENT-2** | `content/bank/s3.json`, `content/bank/s4.json`, `content/diagrams/s4.json` |
| **CONTENT-3** | `content/bank/s5.json`, `content/bank/s6.json`, `content/diagrams/s5.json` |
| **WEB** | `lib/store.js`, `lib/routes.js`, `lib/dashboard-model.js`, `lib/ratings.js`, `lib/practice-service.js`, `lib/quick-check-service.js`, `views/practice.js`, `views/quick-check.js`, `views/chemistry.js`, `views/dashboard.js`, `public/styles.css`, `test/flows/**`, and updates to existing tests it breaks |

Stand-ins for modules you don't own go in `app/.stubs/`, which is never merged. Import other modules by their real paths.

## Shared data shapes

**Question** (from `content/bank/sN.json`, an array): exactly the fields of IMPL 4.3. `id` (IMPL 4.2 form, e.g. `F1.3-C-a`, `D4-1`), `subSkill` (1–6), `fundamental` (e.g. `"F1.3"`), `level` (`"core"` | `"exam"`), `pool` (`"practice"` | `"check"`), `format` (`"mcq"` | `"typed"`), `stem`, `table?` `{caption, headers[], rows[][]}`, `options?` `{A,B,C,D}`, `correct?` (`"A"`–`"D"`), `wrongNotes?` `{letter: text}`, `answerKind?` (`integer|decimal|configuration|symbol|formula|ion|charge|word`), `accepted?` (string[]), `tolerance?`, `hint?`, `solution?` `{steps: string[], diagram?: id}`, `twin?`, `check` `{writer:"agent", solver: null|{by,answer,on}, solutionRead: null|{by,on}, commonContent: true, human: null}`.
Text fields may use the IMPL 7.1 notation markup (`[[H2O]]`, `[[Al^3+]]`, `[[nuclide:40,18,Ar]]`).

**Diagram** (`content/diagrams/sN.json`, an array): IMPL 7.4 ionic or covalent description.

**Attempt** (a store row; fields as IMPL 3.2 `attempts`, camelCase): `{ id, accountId, sessionId, setId?, runId?, questionId, subSkill, fundamental, level, pool, format, shownAt, firstAnswer?, firstAnswerCorrect?, firstAnswerAt?, notSure?, hintShown, hintTrigger?, hintShownAt?, secondAnswer?, secondAnswerCorrect?, secondAnswerAt?, solutionOpened, solutionTrigger?, solutionOpenedAt?, finishedAt?, outcome?, parkedNotice? }`. `outcome` is `"right_first_time"` | `"needed_help"`.
**Set:** `{ id, accountId, sessionId, subSkill, chosenBy, startedAt, endedAt?, endReason? }` · **Run:** `{ id, accountId, kind, offeredAt?, skippedAt?, startedAt?, completedAt? }` · **Flag:** `{ id, accountId, sessionId, setId, fundamental, reason, createdAt }` · **StudySession:** `{ id, accountId, startedAt, lastActionAt, longestPauseMs, endedAt?, endReason? }`.
Ids are strings. Times are ms numbers.

## Module interfaces (pure unless marked)

### ENGINE: `lib/engine/index.js` re-exports everything below. No `node:` imports, no Date.now and no Math.random.
```js
outcomeOf(attempt) -> 'right_first_time' | 'needed_help' | null          // R6.1
labelOf(finishedAttempts /* one sub-skill, both pools */) ->
  { label: 'unrated'|'shaky'|'getting'|'solid', lookedAt, right, examRight, heldBack }   // R6.2
labelAsOf(attempts, time) ; firstLabel(attempts)
chemistryLabel(labels /* array of 6 */) -> { label: null|'shaky'|'getting'|'solid', rated, weakestSubSkill }   // R6.5
weakest(labelsBySubSkill /* {1:'shaky',...} */, available /* number[] */) -> subSkill | null             // R6.3 rules 1-2
nextSubSkill({ labels, sets /* finished-question sets, in start order */, eligible }) -> subSkill | null  // R6.3
retryDecision({ last, sessionAttempts, questions }) -> null | { type:'ask', questionId } | { type:'park', fundamental, reason }   // R6.4 rule 1
nextQuestion({ subSkill, questions /* that sub-skill's practice pool */, attempts /* all his */, sessionId, parked /* fundamental[] */, label })
  -> { type:'ask', questionId, retry: boolean } | { type:'park', fundamental, reason } | { type:'end' }   // R6.4
attemptTransition(attempt, action, { question, isCorrect, now })
  // action: {kind:'answer', value} | {kind:'stuck'} | {kind:'show'} | {kind:'open-solution'}
  // -> { attempt: updatedAttempt, state: 'fresh'|'hinted'|'correct'|'solution' } | { error: 'not-allowed' }   // IMPL 6
attemptState(attempt) -> 'fresh'|'hinted'|'correct'|'solution'
quickCheckPlan({ questions /* pool 'check' */, attempts, run, labels }) -> { questionId } | { done: true }   // PRD story 4 (Finish the quick check = only Not rated yet sub-skills)
unstuck(...) ; sessionFacts(...) ; diagnosticScore(...)   // PRD section 3 measures, U1-U6
```
Every rule id in IMPL 5.3 (R6.1-a … R6.5-d, U1-U6) needs a test whose title starts with that id.

### BANK
```js
// lib/chem/notation.js
renderNotation(text) -> htmlString   // throws NotationError on bad markup; escapes everything else
// lib/chem/electrons.js
valenceElectrons(protonNumber) ; configuration(protonNumber) -> '2.8.1'
// lib/chem/diagrams.js
renderDiagram(diagram) -> { svg /* inline SVG string with <title> and <desc> */, description }
checkDiagram(diagram, periodicTable) -> string[]   // IMPL 7.4 arithmetic problems
// lib/answers/match.js
matchAnswer(kind, accepted, typed, { tolerance }) -> { ok: true, correct: boolean } | { ok: false, message }   // IMPL 7.2
// lib/bank/load.js   (reads files, not pure)
loadBank(contentDir) -> { questions, byId, subskills, fundamentals, periodicTable, diagrams /* merged from content/diagrams/*.json */, manifest }
// lib/bank/validate.js
validateBank(bank, { requireChecks /* false until blind solves are done */ }) -> string[]   // IMPL 4.4 rules 1-21
// views/periodic-table.js
renderPeriodicTableButton() ; renderPeriodicTablePopover(periodicTable)   // popover/popovertarget, no JS
```
Scripts: `node scripts/validate-bank.js` (exit 1 on problems), `node scripts/blind-export.js <subSkill>` (writes `.scratch/blind-sN.json` with no keys), `node scripts/blind-compare.js <subSkill> <solverFile>`.
`content/bank/manifest.json`: `{ "practice": [1,2,3,4,5,6], "check": [1,2,3,4,5,6], "release": false }`.

### WEB
- **Store:** `lib/store.js` gains the tables studySessions, sets, attempts, runs and flags, with small methods (`insert(table,row)`, `update(table,id,fields)`, `where(table,pred)`). It keeps the existing atomic write and the reload-on-external-change behaviour, and existing users/progress data still loads. The old `progress` object becomes demo-only: `scripts/seed-demo.js` must keep working, so make it write attempts, or keep progress as a fallback.
- **Routes** (IMPL 2.6 adapted): `/chemistry` (the topic page), `/practise/:topicId` starts a set (`chosenBy: student`), `/practise/next` (the weakest), `/practise/q` (the current attempt page), with POST actions `answer | stuck | show | open-solution | next | stop`. Also `/practise/summary`, `/check` (the quick check) with POST `start | answer | skip | stop`, and `/check/done`. Every form carries the attempt id and the state it was drawn in; a stale post redirects to the current page.
- **The dashboard** derives labels from attempts through ENGINE (`labelOf`, `chemistryLabel`, `nextSubSkill`), keeping its three-state look.
- **The pages** follow IMPL 6's state table exactly: copy from appendix B, the Periodic Table popover on every question page, diagrams in worked solutions, notation rendered with `renderNotation`, and his own answers shown as plain text.
- **Flow tests** in `test/flows/` drive the real server over HTTP with a tiny fixture bank in `test/flows/fixtures/`.

## Definition of done (each agent)
`node --test test/` is green in your worktree (with stand-ins where needed); your branch has local commits; you reply with the files, test counts and anything you interpreted.
