/**
 * read_ground actually samples at the interval it was asked for.
 *
 * The unit test guards the BRIDGE (that the argument is passed down and reported).
 * It cannot guard the studio's own sampling arithmetic, because its fake host
 * mirrors that formula rather than running it. This drives the real built app, so
 * the number it prints is the number an agent gets.
 *
 * Usage: node scripts/verify-ground-interval.mjs <dist> <landxml-with-alignment-and-surface> [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize, basename } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, XML, PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8263);
const CDP = 9473;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json" };
const server = createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/") u = "/index.html";
  const p = join(DIST, normalize(u).replace(/^(\.\.[/\\])+/, ""));
  if (!existsSync(p) || !statSync(p).isFile()) return void res.writeHead(404).end("nf");
  const b = readFileSync(p);
  res.writeHead(200, { "Content-Type": MIME[extname(p).toLowerCase()] || "application/octet-stream", "Content-Length": b.length }).end(b);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sock, chrome, profile, id = 0, failures = 0;
function cdp(m, p = {}) {
  return new Promise((res, rej) => {
    const i = ++id; const t = setTimeout(() => rej(new Error(m + " timeout")), 120000);
    const h = (e) => { const x = JSON.parse(e.data); if (x.id !== i) return;
      clearTimeout(t); sock.removeEventListener("message", h);
      if (x.error) return rej(new Error(x.error.message));
      if (x.result?.exceptionDetails) return rej(new Error(x.result.exceptionDetails.exception?.description || "threw"));
      res(x.result); };
    sock.addEventListener("message", h); sock.send(JSON.stringify({ id: i, method: m, params: p }));
  });
}
const ev = async (e) => (await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
const CALL = (tool, args) => `(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  const tools = await mc.getTools();
  const t = tools.find(x => x.name === ${JSON.stringify(tool)});
  if (!t) return JSON.stringify({ missing: ${JSON.stringify(tool)} });
  const raw = await mc.executeTool(t, JSON.stringify(${JSON.stringify(args)}));
  let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
  const txt = o && o.content && o.content[0] && o.content[0].text;
  return typeof txt === "string" ? txt : JSON.stringify(o);
})()`;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures += 1;
}

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "gint-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1400,900", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("no page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  await cdp("Runtime.evaluate", {
    expression: `window.__xml = ${JSON.stringify(readFileSync(XML, "utf8"))}; "ok"`,
  });
  const imp = JSON.parse(await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === "import_landxml");
    const raw = await mc.executeTool(t, JSON.stringify({ xml: window.__xml, commit: true }));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return o.content[0].text;
  })()`));
  console.log(`imported ${basename(XML)} -> alignment ${imp.alignmentLengthFt} ft\n`);

  console.log("=== read_ground at three intervals, against the real app ===");
  const spacings = new Map();
  for (const want of [25, 50, 100]) {
    const g = JSON.parse(await ev(CALL("read_ground", { intervalFt: want })));
    if (g.refused || g.error) { check(`intervalFt ${want}`, false, g.code); continue; }
    const s = g.samples;
    const measured = s.length >= 2 ? Number((s[1].station - s[0].station).toFixed(3)) : undefined;
    spacings.set(want, measured);
    console.log(`  intervalFt ${String(want).padStart(3)}  ->  reported ${g.intervalFt}` +
      `  measured ${measured}  stations ${g.sampled}`);
    // The contract is EXACT: stations sit on whole multiples of the interval from
    // the begin station, and the end station is sampled as a short last piece.
    // "Roughly the right average spacing" is a different promise and not this one.
    check(`${want} ft spacing is exact`, Math.abs(measured - want) < 1e-6,
      `measured ${measured}`);
    const begin = s[0].station;
    const offGrid = s.slice(0, -1).filter((x) => Math.abs((x.station - begin) % want) > 1e-6);
    check(`${want} ft stations land on whole multiples`, offGrid.length === 0,
      offGrid.length ? `${offGrid.length} off-grid, e.g. ${offGrid[0].station}` : "all on grid");
    check(`${want} ft is reported back accurately`, Math.abs(g.intervalFt - measured) < 0.01,
      `said ${g.intervalFt}, served ${measured}`);
  }
  check("the three intervals differ from each other",
    new Set([...spacings.values()]).size === 3, [...spacings.values()].join(" / "));

  console.log("\n=== a nonsense interval is refused, not silently defaulted ===");
  for (const bad of [0, -25]) {
    const g = JSON.parse(await ev(CALL("read_ground", { intervalFt: bad })));
    check(`intervalFt ${bad} refused`, g.code === "BadArgument", g.code ?? "accepted it");
  }

  console.log("\n=== omitting it still defaults to 50 ===");
  const d = JSON.parse(await ev(CALL("read_ground", {})));
  check("default is 50 ft", Math.abs(d.intervalFt - 50) < 0.51, `got ${d.intervalFt}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
