/**
 * Can the design actually be handed to the engineer who has to seal it?
 *
 *   1. an agent edits, the design survives a full page RELOAD
 *   2. the agent produces a link, and a SECOND browser opens the same design
 *   3. the agent can set the coordinate system (parity: the human already could)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DIST = process.argv[2] || "T:\\search - Copy\\roadway\\studio\\dist";
const WEB = Number(process.argv[3] || 8220);
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

/** One independent browser, so "a second person opens the link" is literal. */
async function browser(port, url) {
  const profile = mkdtempSync(join(tmpdir(), "hand-"));
  const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1400,950", "--enable-features=WebMCPTesting", url], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1:"));
  if (!page) throw new Error("no page on " + port);
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });
  let id = 0;
  const cdp = (m, p = {}) => new Promise((res, rej) => {
    const i = ++id; const t = setTimeout(() => rej(new Error(m + " timeout")), 60000);
    const h = (e) => { const x = JSON.parse(e.data); if (x.id !== i) return;
      clearTimeout(t); sock.removeEventListener("message", h);
      if (x.error) return rej(new Error(x.error.message));
      if (x.result?.exceptionDetails) return rej(new Error(x.result.exceptionDetails.exception?.description || "threw"));
      res(x.result); };
    sock.addEventListener("message", h); sock.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  const ev = async (e) => (await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { cdp, ev, close: () => { try { sock.close(); } catch {} chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {} } };
}

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
const NAME = `(() => document.getElementById('name').value)()`;
const LEN = `(() => (document.body.innerText.match(/([\\d.]+) ft\\s*alignment length/)||[])[1] || 'n/a')()`;

let a, b2;
try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  const url = `http://127.0.0.1:${WEB}/`;
  a = await browser(9430, url);

  console.log("=== 1. does an edit survive a reload? ===");
  await a.ev(CALL("set_project_setup", { name: "Handoff Test Road", commit: true }));
  await a.ev(CALL("add_horizontal_element", { type: "tangent", lengthFt: 777, commit: true }));
  await sleep(900);
  console.log("  before reload:  name =", await a.ev(NAME));
  await a.cdp("Page.reload", {});
  await sleep(5000);
  console.log("  after  reload:  name =", await a.ev(NAME));
  console.log("  survived:", (await a.ev(NAME)) === "Handoff Test Road");

  console.log("\n=== 2. can the agent hand it to someone else? ===");
  const doc = JSON.parse(await a.ev(CALL("read_design_document", {})));
  const link = doc.shareUrl;
  console.log("  link length:", link.length, "chars");
  console.log("  design lives in the fragment, never sent to a server:", link.includes("#design="));

  b2 = await browser(9431, link);
  console.log("  SECOND browser, opened from the link alone:");
  console.log("    name  =", await b2.ev(NAME));
  console.log("    length=", await b2.ev(LEN), "ft");
  const same = (await b2.ev(NAME)) === "Handoff Test Road";
  console.log("    same design:", same);

  console.log("\n=== 3. parity: can the agent set the coordinate system? ===");
  const zones = JSON.parse(await b2.ev(CALL("read_coordinate_systems", {})));
  console.log("  zones offered:", (zones.available || []).map((z) => z.value).join(", "));
  const bad = JSON.parse(await b2.ev(CALL("set_coordinate_system", { zone: "GA-Middle", commit: true })));
  console.log("  an invented zone:", bad.code, "->", (bad.available || []).join(", "));
  const good = JSON.parse(await b2.ev(CALL("set_coordinate_system", { zone: "GA-East", basis: "ground", commit: true })));
  console.log("  GA-East/ground:", good.committed ? "committed" : "REFUSED");
  const now = JSON.parse(await b2.ev(CALL("read_coordinate_systems", {})));
  console.log("  selected now:", JSON.stringify(now.selected));
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { a?.close(); b2?.close(); server.close(); await sleep(300); }
