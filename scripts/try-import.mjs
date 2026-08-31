/**
 * Run the LandXML importer against real files and report, per file, exactly what
 * happened. Not a test: the files it reads are third-party samples that do not
 * ship with this repo. It exists so the reader can be pointed at whatever LandXML
 * you actually have and give an honest answer.
 *
 * Usage: node scripts/try-import.mjs <file-or-directory> [...]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { Window } from "happy-dom";
import { register } from "node:module";

// The importer uses the browser's DOMParser; give it one.
const window = new Window();
globalThis.DOMParser = window.DOMParser;

const { parseLandXML } = await import("../src/importers/landxml.ts").catch(async () => {
  // tsx/ts-node may not be present; fall back to the built studio bundle is not
  // useful here, so say so plainly rather than failing obscurely.
  console.error("Could not load the TypeScript importer. Run with: npx tsx scripts/try-import.mjs <paths>");
  process.exit(2);
});

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: node scripts/try-import.mjs <file-or-directory> [...]");
  process.exit(2);
}

const files = [];
for (const t of targets) {
  try {
    if (statSync(t).isDirectory()) {
      for (const f of readdirSync(t)) {
        if (extname(f).toLowerCase() === ".xml") files.push(join(t, f));
      }
    } else files.push(t);
  } catch { console.log(`  ${t}: cannot read`); }
}

let ok = 0, refused = 0;
for (const f of files) {
  let xml;
  try { xml = readFileSync(f, "utf8"); } catch { console.log(`${basename(f)}: unreadable`); continue; }
  const r = parseLandXML(xml);
  const name = basename(f).slice(0, 38).padEnd(40);
  if (r.ok) {
    ok += 1;
    for (const a of r.alignments) {
      const kinds = a.elements.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + 1 }), {});
      console.log(`${name} OK  "${a.name.slice(0, 22)}"  ` +
        `${a.elements.length} elements ${JSON.stringify(kinds)}  ${a.pvis.length} PVIs  [${a.sourceUnit}]`);
      for (const n of a.notes) console.log(`${" ".repeat(40)}     note: ${n}`);
    }
  } else {
    refused += 1;
    console.log(`${name} --  ${r.code}: ${r.detail.slice(0, 88)}`);
  }
}
console.log(`\n${files.length} files · ${ok} imported · ${refused} refused with a reason`);
