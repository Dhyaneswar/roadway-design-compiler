/**
 * Production smoke test: the full submission story against the deployed URL,
 * driven exactly as a visiting agent would drive it.
 *
 * Usage: node scripts/verify-live.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = process.argv[2] || "https://roadway-design-compiler.gandidhyaneswar.workers.dev/";
const OUT = process.argv[3] || ".";
const CDP = 9416;
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
  profile = mkdtempSync(join(tmpdir(), "live-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1440,980", "--enable-features=WebMCPTesting", URL], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(5000);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith(URL.slice(0, 42)));
  if (!page) throw new Error("no page attached; targets: " + list.map(t => t.url).join(" | "));
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  console.log("banner:", (await ev("(document.getElementById('agentStatus')||{}).textContent||''")).trim().slice(0, 90));
  const names = (await ev(`(async () => (await (document.modelContext ?? navigator.modelContext).getTools()).map(t=>t.name).join(","))()`)).split(",");
  console.log("tools:", names.length);

  console.log("\n-- criteria at 70 mph on the seeded road --");
  const c70 = JSON.parse(await ev(CALL("check_design_criteria", { designSpeedMph: 70, emax: 0.06 })));
  console.log("   checked", c70.checked, "| failed", c70.failed, "| compliant", c70.compliant);
  const fail = (c70.verdicts || []).find((v) => v.status === "fail");
  if (fail) console.log("   e.g.", fail.detail);

  console.log("\n-- agent banks the curves --");
  const sup = JSON.parse(await ev(CALL("set_superelevation", { designSpeedMph: 70, emax: 0.06, commit: true })));
  console.log("   committed:", sup.committed, "| pending:", sup.pendingEngineerConfirmation);
  const tr = JSON.parse(await ev(CALL("read_superelevation", {})));
  (tr.transitions || []).forEach((t) => console.log(
    `   curve ${t.curveIndex + 1} ${t.direction} R=${t.radiusFt} e=${t.fullSuperPercent}% Lr=${t.runoffLengthFt}`));

  console.log("\n-- the seal --");
  const blocked = JSON.parse(await ev(CALL("export_landxml", {})));
  console.log("   export:", blocked.refused ? "REFUSED " + blocked.code : "OK (unexpected)");
  console.log("   confirm tools available to the agent:",
    names.filter((n) => /(^|_)(confirm|approve|seal|sign|accept)(_|$)/i.test(n)).length === 0 ? "NONE" : "SOME");
  await shot("live-01-pending.png");

  await ev(`(() => { const b=document.querySelector('#agentPending .pending-confirm'); if(b) b.click(); })()`);
  await sleep(900);
  const okxml = JSON.parse(await ev(CALL("export_landxml", {})));
  console.log("   after human confirm:", okxml.refused ? "still refused" : `OK, ${okxml.lengthBytes} bytes of LandXML`);
  await shot("live-02-confirmed.png");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
