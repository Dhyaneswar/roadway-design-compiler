/**
 * A saved design that a stricter build refuses must not wedge the studio.
 *
 * Shipping the delta < 180 bound made every autosave holding a 180 degree curve
 * open to an error and NO design. The restore block's guard wrapped restoreForm,
 * which only writes values into fields and cannot fail on impossible geometry --
 * the throw came later, from refresh(), outside it.
 *
 * ⚠ This has to run in a real browser. The wedge lived in the interaction between
 * localStorage, module boot order and refresh(); every unit test in the suite
 * passed while the deployed page opened dead.
 *
 *   node scripts/verify-restore-fallback.mjs studio/dist
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DIST = process.argv[2] ?? "studio/dist";
const WEB = 8311, CDP = 9491;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

const server = createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/") u = "/index.html";
  const p = join(DIST, normalize(u).replace(/^(\.\.[/\\])+/, ""));
  if (!existsSync(p) || !statSync(p).isFile()) return void res.writeHead(404).end("nf");
  const b = readFileSync(p);
  res.writeHead(200, {
    "Content-Type": MIME[extname(p).toLowerCase()] || "application/octet-stream",
    "Content-Length": b.length,
  }).end(b);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sock, chrome, profile, id = 0;
function cdp(m, p = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => rej(new Error(m + " timeout")), 60000);
    const h = (e) => {
      const x = JSON.parse(e.data);
      if (x.id !== i) return;
      clearTimeout(t); sock.removeEventListener("message", h);
      if (x.error) return rej(new Error(x.error.message));
      res(x.result);
    };
    sock.addEventListener("message", h);
    sock.send(JSON.stringify({ id: i, method: m, params: p }));
  });
}
const ev = async (e) =>
  (await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))
    ?.result?.value;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

/** What the page looks like to somebody who just opened it. */
const readPage = async () => ({
  status: (await ev(`document.getElementById('status')?.innerText ?? ""`)) ?? "",
  errors: (await ev(`document.getElementById('errors')?.innerText ?? ""`)) ?? "",
  rows: await ev(`document.querySelectorAll('.results table tr').length`),
  deltas: await ev(`JSON.stringify([...document.querySelectorAll('input')].map(i => i.value))`),
});

/**
 * ⚠ A REAL load, not a hash change.
 *
 * Page.navigate to the same document with only a different fragment fires
 * hashchange and never re-runs the module -- the assertions below then read the
 * PREVIOUS page's status and pass without testing anything. Going via
 * about:blank forces a fresh document; localStorage is per-origin and survives.
 */
const hardGoto = async (url) => {
  await cdp("Page.navigate", { url: "about:blank" });
  await sleep(500);
  await cdp("Page.navigate", { url });
  await sleep(5000);
};

/**
 * Clear the stored design and let a clean load write a fresh one.
 *
 * ⚠ Each case must start from a KNOWN-GOOD autosave. Once a failed restore
 * stopped overwriting stored work (F033), a case that poisoned the autosave left
 * it poisoned, and the next case mutated the wreckage instead of a clean design
 * -- so "a legal saved design is restored" failed for a reason that had nothing
 * to do with what it was testing.
 */
const freshAutosave = async () => {
  await ev(`localStorage.removeItem('rdc:design')`);
  await hardGoto(`http://127.0.0.1:${WEB}/`);
};

/** Overwrite the autosaved design, then reload as that reader would. */
const poisonAndReload = async (mutate) => {
  await freshAutosave();
  await ev(`(() => {
    const raw = JSON.parse(localStorage.getItem('rdc:design'));
    (${mutate})(raw.form ?? raw);
    localStorage.setItem('rdc:design', JSON.stringify(raw));
  })()`);
  await cdp("Page.reload", {});
  await sleep(5000);
  return readPage();
};

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "restore-"));
  chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--headless=new",
    "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {}
    await sleep(200);
  }
  await sleep(5000);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("studio page never appeared");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    sock.addEventListener("open", r, { once: true });
    sock.addEventListener("error", j, { once: true });
  });

  console.log("\nclean boot");
  const clean = await readPage();
  check("computes a design", clean.rows > 0, `${clean.rows} rows`);
  check("says it is valid", /valid design/.test(clean.status), JSON.stringify(clean.status));
  check("wrote an autosave", (await ev(`!!localStorage.getItem('rdc:design')`)) === true);

  console.log("\nautosave holding a 180 degree curve (the shipped regression)");
  const wedged = await poisonAndReload(
    `(f) => { for (const e of (f.elements ?? [])) if ((e.kind ?? e.type) === 'arc') { e.deltaDeg = '180'; break; } }`,
  );
  check("still computes a design", wedged.rows > 0, `${wedged.rows} rows`);
  check("does not strand the reader on the raw error",
    !/fix inputs to see the computed design/.test(wedged.errors), JSON.stringify(wedged.errors));
  check("says the saved design could not be restored",
    /could not restore your saved design/.test(wedged.status), JSON.stringify(wedged.status));
  check("names the reason", /less than 180/.test(wedged.status));
  check("says which design is on screen instead", /seeded design is loaded/.test(wedged.status));
  check("the 180 never reaches a field", !JSON.parse(wedged.deltas).includes("180"));

  console.log("\nautosave that is structurally wrong, not merely invalid");
  const junk = await poisonAndReload(`(f) => { f.elements = [{ kind: 'arc' }]; }`);
  check("still computes a design", junk.rows > 0, `${junk.rows} rows`);
  check("still explains itself", /could not restore/.test(junk.status), JSON.stringify(junk.status));

  console.log("\na LEGAL saved design is still restored, not thrown away");
  /**
   * ⚠ The edit has to leave the GEOMETRY alone. Changing a delta changes the arc
   * length, which moves the alignment end station, which orphans the last PVI --
   * the studio re-derives that on every edit, but writing straight into storage
   * skips the sync, so such a design is genuinely invalid and the fallback is
   * right to refuse it. Refusing it would then be scored as a bug here.
   */
  const good = await poisonAndReload(`(f) => { f.name = 'RESTORE-KEPT'; }`);
  check("computes", good.rows > 0, `${good.rows} rows`);
  check("reports no problem", !/could not restore/.test(good.status), JSON.stringify(good.status));
  check("kept the saved value", JSON.parse(good.deltas).includes("RESTORE-KEPT"));

  /**
   * F029. A share URL that carries a design and fails to decode must NOT fall
   * through to the reader's own autosave. The sentinel proves it: if the name
   * below ever reaches the screen, the reader is looking at their own road while
   * believing they opened the one they were sent.
   */
  console.log("\nmalformed share link, with a legal autosave already present");
  await freshAutosave();
  await ev(`(() => {
    const raw = JSON.parse(localStorage.getItem('rdc:design'));
    (raw.form ?? raw).name = 'AUTOSAVE-SENTINEL';
    localStorage.setItem('rdc:design', JSON.stringify(raw));
  })()`);
  /**
   * ⚠ The WHOLE stored document, byte for byte.
   *
   * This check used to be `name !== undefined`, which the sentinel AND the
   * seeded road that overwrote it both satisfied -- so it passed while a broken
   * share was quietly destroying the reader's saved work (F033). An assertion
   * that cannot tell the pass case from the failure case is not a test.
   */
  const savedBefore = await ev(`localStorage.getItem('rdc:design')`);
  await hardGoto(`http://127.0.0.1:${WEB}/#design=%%%%`);
  const bad = await readPage();
  check("does not show the reader their own saved road",
    !JSON.parse(bad.deltas).includes("AUTOSAVE-SENTINEL"), bad.deltas.slice(0, 120));
  check("does not claim the design is valid", !/valid design/.test(bad.status),
    JSON.stringify(bad.status));
  check("says the SHARED design could not be restored",
    /could not restore your shared design/.test(bad.status), JSON.stringify(bad.status));
  check("names the decode reason", /corrupt or truncated/.test(bad.status));
  check("still computes the seeded design", bad.rows > 0, `${bad.rows} rows`);
  const savedAfter = await ev(`localStorage.getItem('rdc:design')`);
  check("left the stored design byte-for-byte untouched", savedAfter === savedBefore,
    savedAfter === savedBefore
      ? "" : `${String(savedBefore).length} bytes -> ${String(savedAfter).length}`);

  console.log("\n...and a later clean visit still gets that design back");
  await hardGoto(`http://127.0.0.1:${WEB}/`);
  const back = await readPage();
  check("the sentinel design restores", JSON.parse(back.deltas).includes("AUTOSAVE-SENTINEL"),
    back.deltas.slice(0, 90));
  check("and is valid", /valid design/.test(back.status), JSON.stringify(back.status));

  console.log("\nmalformed share link, with NO autosave at all");
  await ev(`localStorage.removeItem('rdc:design')`);
  await hardGoto(`http://127.0.0.1:${WEB}/#design=%%%%`);
  const bare = await readPage();
  check("still computes the seeded design", bare.rows > 0, `${bare.rows} rows`);
  check("still explains itself", /could not restore your shared design/.test(bare.status),
    JSON.stringify(bare.status));

  /** A hash that is not a share at all must still restore the autosave. */
  console.log("\na plain #anchor is not a share and must not block autosave");
  await hardGoto(`http://127.0.0.1:${WEB}/`);
  await ev(`(() => {
    const raw = JSON.parse(localStorage.getItem('rdc:design'));
    (raw.form ?? raw).name = 'ANCHOR-KEEPS-AUTOSAVE';
    localStorage.setItem('rdc:design', JSON.stringify(raw));
  })()`);
  await hardGoto(`http://127.0.0.1:${WEB}/#some-anchor`);
  const anchor = await readPage();
  check("restored the autosave", JSON.parse(anchor.deltas).includes("ANCHOR-KEEPS-AUTOSAVE"));
  check("reported no problem", !/could not restore/.test(anchor.status),
    JSON.stringify(anchor.status));

  sock.close();
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.log("ERROR: " + e.message);
  process.exitCode = 1;
} finally {
  if (chrome) chrome.kill();
  server.close();
  await sleep(300);
  if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} }
}
