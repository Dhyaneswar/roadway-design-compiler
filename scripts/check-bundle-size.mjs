/**
 * Fail the build if the ENTRY chunk grows back.
 *
 * `chunkSizeWarningLimit` in the Vite config only prints a warning; it does not
 * fail Vite and it does not fail CI. The config comment claimed an oversize entry
 * "should fail loudly", which was aspiration rather than fact -- QA was right to
 * flag it. This is the assertion that makes the sentence true.
 *
 * ⚠ What is being defended is the ENTRY chunk, not the total. three.js is ~550 KB
 * and is deliberately deferred behind a dynamic import in `activate3d()`; the
 * regression to catch is somebody importing the viewer statically again, which
 * would move that half-megabyte onto the first paint of every visit -- including
 * every agent that only ever reads the design and never opens the 3D tab.
 *
 *   node scripts/check-bundle-size.mjs [dist-dir]
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "studio/dist";
const ASSETS = join(DIST, "assets");

/**
 * Budget for the entry chunk, in KB.
 *
 * Set above the current 222 KB with room for ordinary growth, and far below the
 * 772 KB the entry was before the split -- so a static viewer import trips it
 * immediately while a few new modules do not.
 */
const ENTRY_BUDGET_KB = 300;

let files;
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"));
} catch {
  console.error(`no built assets at ${ASSETS} -- run the studio build first`);
  process.exit(2);
}

const kb = (p) => statSync(join(ASSETS, p)).size / 1024;
const entry = files.filter((f) => f.startsWith("index-"));
const deferred = files.filter((f) => !f.startsWith("index-"));

if (entry.length !== 1) {
  console.error(`expected exactly one entry chunk, found ${entry.length}: ${files.join(", ")}`);
  process.exit(2);
}

const entryKb = kb(entry[0]);
for (const f of [...entry, ...deferred]) {
  const tag = f.startsWith("index-") ? "entry   " : "deferred";
  console.log(`  ${tag}  ${kb(f).toFixed(1).padStart(7)} KB  ${f}`);
}

if (entryKb > ENTRY_BUDGET_KB) {
  console.error(
    `\nFAIL: entry chunk is ${entryKb.toFixed(1)} KB, over the ${ENTRY_BUDGET_KB} KB budget.\n` +
    `Something that should load on demand is now loading on first paint. The usual\n` +
    `cause is a static import of studio/viewer3d.ts (three.js). Import it dynamically,\n` +
    `or raise ENTRY_BUDGET_KB here deliberately and say why.`,
  );
  process.exit(1);
}

console.log(
  `\nOK: entry ${entryKb.toFixed(1)} KB is within the ${ENTRY_BUDGET_KB} KB budget` +
  `${deferred.length ? `, with ${deferred.length} chunk(s) deferred` : ""}.`,
);
