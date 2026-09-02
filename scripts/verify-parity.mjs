/**
 * Two things this proves:
 *
 *   A. HUMAN PARITY -- an engineer can author superelevation from the UI, with no
 *      agent involved. If they cannot, the agent is a gatekeeper on an engineering
 *      decision, which inverts the liability model the app is built on.
 *
 *   B. THE ACTIVITY LOG DISCRIMINATES -- driving the DOM leaves the WebMCP log
 *      empty; calling a tool fills it. That is how you tell whether an agent used
 *      the tool surface or just clicked around the page.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// Repo-relative, resolved from this file: the default used to be one
// developer's absolute path, which is useless to anybody who clones this.
const DIST = process.argv[2]
  || fileURLToPath(new URL("../studio/dist", import.meta.url));
const OUT = process.argv[3] || ".";
const WEB = Number(process.argv[4] || 8200);
const CDP = 9418;
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
let sock, chrome, profile, id = 0;
function cdp(m, p = {}) {
  return new Promise((res, rej) => {
    const i = ++id; const t = setTimeout(() => rej(new Error(m + " timeout")), 90000);
    const h = (e) => { const x = JSON.parse(e.data); if (x.id !== i) return;
      clearTimeout(t); sock.removeEventListener("message", h);
      if (x.error) return rej(new Error(x.error.message));
      if (x.result?.exceptionDetails) return rej(new Error(x.result.exceptionDetails.exception?.description || "threw"));
      res(x.result); };
    sock.addEventListener("message", h); sock.send(JSON.stringify({ id: i, method: m, params: p }));
  });
}
const ev = async (e) => (await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
async function shot(n) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, n), Buffer.from(r.data, "base64"));
  console.log("  shot ->", n);
}
const logState = `(() => {
  const s = document.querySelector('#agentLog summary');
  return (s ? s.textContent : '(no log)').trim();
})()`;

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "par-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1440,1050", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("no page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  console.log("=== A. HUMAN authors superelevation, no agent ===");
  console.log("  log before:", await ev(logState));

  // Tick the box and set 70 mph, exactly as a person would.
  await ev(`(() => {
    const box = document.getElementById('supEnabled');
    box.checked = true; box.dispatchEvent(new Event('change'));
    const sp = document.getElementById('supSpeed');
    sp.value = '70'; sp.dispatchEvent(new Event('input'));
  })()`);
  await sleep(1200);

  const summary = await ev(`(() => document.getElementById('supSummary').textContent.trim())()`);
  console.log("  banking summary computed by the UI:");
  summary.split("  curve").filter(Boolean).slice(0, 4).forEach((l, i) => {
    if (i === 0 && !l.startsWith(" ")) console.log("   ", l.trim().slice(0, 110));
    else console.log("    curve" + l.trim().slice(0, 105));
  });

  const pendingAfterHuman = await ev(`(() => !!document.getElementById('agentPending'))()`);
  console.log("  pending-confirmation banner:", pendingAfterHuman ? "SHOWN (wrong)" : "none — a human's own edit needs no confirmation");
  console.log("  log after human edit:", await ev(logState));
  await shot("parity-01-human.png");

  console.log("\n=== B. AGENT does the same thing through WebMCP ===");
  const res = await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === 'read_superelevation');
    const raw = await mc.executeTool(t, JSON.stringify({}));
    let o = raw; if (typeof o === 'string') { try { o = JSON.parse(o); } catch {} }
    const txt = o && o.content && o.content[0] && o.content[0].text;
    const parsed = JSON.parse(typeof txt === 'string' ? txt : '{}');
    return JSON.stringify({ enabled: parsed.enabled, transitions: (parsed.transitions||[]).length });
  })()`);
  console.log("  read_superelevation sees the human's policy:", res);
  console.log("  log after ONE tool call:", await ev(logState));

  console.log("\n=== annotations present on the wire? ===");
  const ann = await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const withAnn = tools.filter(t => t.annotations && Object.keys(t.annotations).length > 0);
    const ro = tools.filter(t => t.annotations && t.annotations.readOnlyHint === true);
    const dest = tools.filter(t => t.annotations && t.annotations.destructiveHint === true);
    const rm = tools.find(t => t.name === 'remove_pvi');
    const rd = tools.find(t => t.name === 'read_design');
    return JSON.stringify({ total: tools.length, annotated: withAnn.length,
      readOnly: ro.length, destructive: dest.map(t => t.name),
      sample_remove_pvi: rm ? rm.annotations : null,
      sample_read_design: rd ? rd.annotations : null,
      keysOnRemove: rm && rm.annotations ? Object.keys(rm.annotations) : [] });
  })()`);
  console.log(" ", ann);
  await shot("parity-02-agent.png");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
