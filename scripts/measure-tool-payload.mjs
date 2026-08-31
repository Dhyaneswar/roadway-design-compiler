/**
 * How big is the tool manifest this page registers?
 *
 * KNOWN GOOD, measured 2026-08-31: 31 tools / 23.3 KB / ~6,000 tokens loads in BOTH
 * Chrome with --enable-features=WebMCPTesting AND ChatGPT's in-app browser. There is
 * headroom above this; do not trim the surface on suspicion alone.
 *
 * ⚠ What DOES break it: redeploying a different tool set to the same URL while a
 * ChatGPT chat already holds the page's configuration. That chat then reports
 * "WebMCP is still disabled because the page's configuration exceeds supported
 * limits" -- which reads like a size ceiling and is really a stale session. A NEW
 * chat loads the same page fine. So freeze deploys once anyone is testing.
 *
 * Run this before and after any change to the tool surface, so a real ceiling can be
 * told apart from a stale one.
 *
 * Usage: node scripts/measure-tool-payload.mjs [url]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = process.argv[2] || "https://roadway-design-compiler.gandidhyaneswar.workers.dev/";
const CDP = 9460;
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

try {
  profile = mkdtempSync(join(tmpdir(), "size-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--enable-features=WebMCPTesting", URL], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(6000);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith(URL.slice(0, 40)));
  if (!page) throw new Error("no page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  const out = JSON.parse(await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const rows = tools.map(t => {
      const schema = typeof t.inputSchema === "string" ? t.inputSchema : JSON.stringify(t.inputSchema ?? {});
      return { name: t.name, n: t.name.length, d: (t.description||"").length, s: schema.length };
    });
    return JSON.stringify({ count: tools.length, rows });
  })()`));

  const tot = out.rows.reduce((a, r) => ({ n: a.n + r.n, d: a.d + r.d, s: a.s + r.s }), { n:0, d:0, s:0 });
  const total = tot.n + tot.d + tot.s;

  console.log(`tools registered: ${out.count}\n`);
  console.log("  name                                   name   desc  schema   total");
  for (const r of [...out.rows].sort((a,b) => (b.d+b.s) - (a.d+a.s))) {
    console.log(`  ${r.name.slice(0,36).padEnd(38)}${String(r.n).padStart(4)} ${String(r.d).padStart(6)} ${String(r.s).padStart(7)} ${String(r.n+r.d+r.s).padStart(7)}`);
  }
  console.log(`\n  TOTAL${" ".repeat(35)}${String(tot.n).padStart(4)} ${String(tot.d).padStart(6)} ${String(tot.s).padStart(7)} ${String(total).padStart(7)}`);
  console.log(`\n  ${(total/1024).toFixed(1)} KB of tool definitions`);
  console.log(`  ~${Math.round(total/4).toLocaleString()} tokens (at ~4 chars/token)`);
  console.log(`  mean per tool: ${Math.round(total/out.count)} chars`);
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
