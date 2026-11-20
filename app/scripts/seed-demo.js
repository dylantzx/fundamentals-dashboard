// Sets the student's progress so each dashboard state can be shown.
// Usage: node scripts/seed-demo.js [first-time|part-way|returning]   (default: returning)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Progress per demo state, matching the approved mockups' numbers. */
export const DEMO_PROGRESS = Object.freeze({
  // Nothing answered yet.
  'first-time': { topics: {}, checksDone: 0 },
  // Two checks done and one answer into the third.
  'part-way': {
    topics: {
      t1: { right: 3, total: 3 }, // Solid 3/3
      t2: { right: 1, total: 3 }, // Shaky 1/3 -> Next up
      t3: { right: 1, total: 1 }, // Needs 2 more answers
    },
    checksDone: 2,
  },
  // All six rated: 2 Shaky, 3 Getting there, 1 Solid; Isotopes is Next up.
  returning: {
    topics: {
      t1: { right: 4, total: 5 }, // Solid
      t2: { right: 3, total: 5 }, // Getting there
      t3: { right: 1, total: 3 }, // Shaky (Next up: earlier than t4)
      t4: { right: 2, total: 5 }, // Shaky
      t5: { right: 2, total: 4 }, // Getting there
      t6: { right: 2, total: 3 }, // Getting there
    },
    checksDone: 6,
  },
});

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

async function main() {
  const state = process.argv[2] || 'returning';
  if (!Object.hasOwn(DEMO_PROGRESS, state)) {
    console.error(`Unknown state "${state}". Use one of: ${Object.keys(DEMO_PROGRESS).join(', ')}`);
    process.exit(1);
  }
  const { createStore } = await import('../lib/store.js');
  const store = createStore(process.env.STEADY_DATA_DIR || path.join(appDir, 'data'));
  const student = store.listUsers().find((u) => u.role === 'student');
  if (!student) {
    console.log('Run the app and finish setup first.');
    process.exit(1);
  }
  store.setProgress(student.id, structuredClone(DEMO_PROGRESS[state]));
  console.log(`Set ${student.username}'s progress to the "${state}" demo. Reload the dashboard to see it.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
