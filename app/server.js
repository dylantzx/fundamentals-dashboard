// Steady: local web server entry point.
//   node server.js            -> listens on 127.0.0.1:4600 (env PORT overrides)
//   import { createApp }      -> an http.Server for tests (call .listen(0, '127.0.0.1'))

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createStore } from './lib/store.js';
import { createAuthenticator, scryptNFromEnv } from './lib/auth.js';
import { createSessions, IDLE_MS } from './lib/sessions.js';
import { createRouter } from './lib/routes.js';
import { loadQuestionBank } from './lib/question-bank.js';
import { loadExplanations } from './lib/explanations.js';
import fs from 'node:fs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads the real views and dashboard model. Imported lazily so the server
 * modules can be tested on their own with stand-ins.
 */
async function loadRealUi() {
  const [login, setup, dashboard, parent, placeholder, model] = await Promise.all([
    import('./views/login.js'),
    import('./views/setup.js'),
    import('./views/dashboard.js'),
    import('./views/parent.js'),
    import('./views/placeholder.js'),
    import('./lib/dashboard-model.js'),
  ]);
  return {
    views: {
      renderLogin: login.renderLogin,
      renderSetup: setup.renderSetup,
      renderDashboard: dashboard.renderDashboard,
      renderParentHome: parent.renderParentHome,
      renderComingNext: placeholder.renderComingNext,
      renderNotFound: placeholder.renderNotFound,
    },
    buildDashboardModel: model.buildDashboardModel,
  };
}

/**
 * Builds the Steady app as an http.Server (not yet listening).
 *
 * @param {{
 *   dataDir?: string,             // default env STEADY_DATA_DIR or app/data
 *   scryptN?: number,             // default env STEADY_SCRYPT_N or 16384
 *   now?: () => number,           // clock in ms, for the idle timeout (default Date.now)
 *   idleMs?: number,              // default 20 minutes
 *   publicDir?: string,           // default app/public
 *   views?: import('./lib/routes.js').Views,       // override the real views/*.js
 *   buildDashboardModel?: (o: { user: any, progress: any }) => any,  // override lib/dashboard-model.js
 *   log?: (line: string) => void, // access/error log sink (default console.log)
 *   bankDir?: string | null,      // question bank folder (export.json + assets/); default env STEADY_BANK_DIR
 *                                 // or ../question-bank. null = no bank: practice pages show "Coming next".
 *   explanationsFile?: string,    // why answers are right or wrong; default app/content/explanations.json
 * }} [opts]
 * @returns {http.Server & { store: any, sessions: any, auth: any }}
 */
export function createApp(opts = {}) {
  const dataDir = opts.dataDir ?? process.env.STEADY_DATA_DIR ?? path.join(APP_DIR, 'data');
  const scryptN = opts.scryptN ?? scryptNFromEnv();
  const now = opts.now ?? Date.now;
  const publicDir = opts.publicDir ?? path.join(APP_DIR, 'public');
  const log = opts.log ?? ((line) => console.log(line));

  const store = createStore(dataDir);
  const sessions = createSessions({ now, idleMs: opts.idleMs ?? IDLE_MS });
  const auth = createAuthenticator(store, { N: scryptN });

  /** @type {Promise<any> | null} */
  let uiPromise = null;
  const loadUi = () =>
    (uiPromise ??= (async () => {
      const needReal = !opts.views || !opts.buildDashboardModel;
      const real = needReal ? await loadRealUi() : null;
      return {
        views: opts.views ?? real.views,
        buildDashboardModel: opts.buildDashboardModel ?? real.buildDashboardModel,
      };
    })().catch((err) => {
      uiPromise = null;
      throw err;
    }));

  const bankDir = opts.bankDir === undefined
    ? process.env.STEADY_BANK_DIR ?? path.join(APP_DIR, '..', 'question-bank')
    : opts.bankDir;
  let bank = null;
  if (bankDir && fs.existsSync(path.join(bankDir, 'export.json'))) {
    try {
      bank = loadQuestionBank(bankDir, { explanations: readExplanations(opts.explanationsFile, log) });
    } catch (err) {
      log(`question bank not loaded from ${bankDir}: ${err && err.message}`);
    }
  }

  const handler = createRouter({ store, sessions, auth, loadUi, publicDir, bank, log });
  const server = http.createServer(handler);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return Object.assign(server, { store, sessions, auth, bank });
}

/** Explanations are optional: a missing or broken file just means no "why" after answers. */
function readExplanations(file, log) {
  const f = file ?? path.join(APP_DIR, 'content', 'explanations.json');
  try {
    return loadExplanations(f);
  } catch (err) {
    log(`explanations not loaded from ${f}: ${err && err.message}`);
    return new Map();
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.PORT) || 4600;
  const host = '127.0.0.1';
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`Steady is running at http://localhost:${port}  (Ctrl+C to stop)`);
    console.log(server.bank
      ? `Question bank: ${server.bank.items.length} practice items from ${server.bank.sourceLine()}`
      : 'Question bank: not found, practice pages show "Coming next"');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
