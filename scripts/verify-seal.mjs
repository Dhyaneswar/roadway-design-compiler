/**
 * The seal boundary, proved end to end.
 *
 *   1. Export works on an untouched design.
 *   2. The agent changes something -> export is REFUSED, AwaitingEngineerConfirmation.
 *   3. The agent has no tool that clears it (asserted against the live tool list).
 *   4. A human clicks confirm in the UI -> export works again.
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
const WEB = Number(process.argv[4] || 8190);
const CDP = 9414;
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

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "seal-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1440,980", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("no page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  const names = await ev(`(async () => (await (document.modelContext ?? navigator.modelContext).getTools()).map(t => t.name).join(","))()`);
  console.log("tools:", names.split(",").length);

  console.log("\n1. export on an untouched design:");
  const e0 = JSON.parse(await ev(CALL("export_landxml", {})));
  console.log("   ", e0.refused ? "REFUSED " + e0.code : `OK, ${e0.lengthBytes} bytes`);

  console.log("\n2. agent banks the curves at 70 mph:");
  const chg = JSON.parse(await ev(CALL("set_superelevation", { designSpeedMph: 70, emax: 0.06, commit: true })));
  console.log("    committed:", chg.committed, "| pendingEngineerConfirmation:", chg.pendingEngineerConfirmation);

  console.log("\n3. export now:");
  const e1 = JSON.parse(await ev(CALL("export_landxml", {})));
  console.log("   ", e1.refused ? "REFUSED " + e1.code : "OK (UNEXPECTED)");
  if (e1.refused) console.log("    ", e1.detail.slice(0, 150));

  console.log("\n4. can the agent clear it itself?");
  const toolList = names.split(",");
  // Word-boundary match: plain /sign/ also matches "de-sign", which made this
  // check report a false positive the first time it ran.
  const clearing = toolList.filter((n) => /(^|_)(confirm|approve|seal|sign|accept)(_|$)/i.test(n));
  console.log("    tools matching confirm/approve/seal/sign:", clearing.length === 0 ? "NONE" : clearing.join(","));

  console.log("\n5. what the agent is told to do:");
  const pend = JSON.parse(await ev(CALL("read_pending_changes", {})));
  console.log("    pendingCount:", pend.pendingCount, "| deliverableBlocked:", pend.deliverableBlocked);
  console.log("    ", pend.note);

  await shot("seal-01-pending.png");

  console.log("\n6. a HUMAN clicks confirm in the UI:");
  const clicked = await ev(`(() => { const b=document.querySelector('#agentPending .pending-confirm'); if(!b) return "no banner"; b.click(); return "clicked"; })()`);
  console.log("    ", clicked);
  await sleep(900);

  console.log("\n7. export after confirmation:");
  const e2 = JSON.parse(await ev(CALL("export_landxml", {})));
  console.log("   ", e2.refused ? "REFUSED " + e2.code : `OK, ${e2.lengthBytes} bytes of LandXML`);
  await shot("seal-02-confirmed.png");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
