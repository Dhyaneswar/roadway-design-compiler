/**
 * Walk the video script beat by beat against the DEPLOYED app and screenshot each
 * one, so the recording is mechanical rather than exploratory.
 *
 * Every beat prints what the app actually returned. If a number here disagrees
 * with the narration in SUBMISSION.md, fix the narration -- not the number.
 *
 * Usage: node scripts/rehearse-video.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = process.argv[2] || "https://roadway-design-compiler.gandidhyaneswar.workers.dev/";
const OUT = process.argv[3] || ".";
const CDP = 9420;
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
async function beat(n, label) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const f = `beat-${String(n).padStart(2, "0")}.png`;
  writeFileSync(join(OUT, f), Buffer.from(r.data, "base64"));
  console.log(`   [${f}]  ${label}`);
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
const click3d = `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='3D corridor'); if(b) b.click(); return !!b; })()`;
const clickDesign = `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Design'); if(b) b.click(); return !!b; })()`;

try {
  mkdirSync(OUT, { recursive: true });
  profile = mkdtempSync(join(tmpdir(), "reh-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1600,1000", "--enable-features=WebMCPTesting", URL], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(5500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith(URL.slice(0, 42)));
  if (!page) throw new Error("no page attached");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  console.log("\n0:00-0:20  the app, a road on screen");
  console.log("   banner:", (await ev("(document.getElementById('agentStatus')||{}).textContent||''")).trim().slice(0, 70));
  await beat(1, "opening shot — Design view, road and tables visible");

  console.log("\n0:20-0:45  agent: check this against 70 mph");
  const c1 = JSON.parse(await ev(CALL("check_design_criteria", { designSpeedMph: 70, emax: 0.06 })));
  console.log(`   ${c1.checked} checks, ${c1.failed} failed`);
  const worst = (c1.verdicts || []).find((v) => v.status === "fail");
  console.log("   headline:", worst?.detail);
  console.log("   basis   :", worst?.basis);
  await beat(2, "criteria failure on screen — the number AND the equation");

  console.log("\n0:45-1:15  agent widens the curve to the radius the verdict named");
  const target = Math.ceil((worst?.required ?? 2100) / 50) * 50;
  const widen = JSON.parse(await ev(CALL("set_horizontal_element", { index: 2, radiusFt: target, commit: true })));
  console.log(`   set curve 1 radius -> ${target} ft :`, widen.committed ? "committed" : "REFUSED");
  const c2 = JSON.parse(await ev(CALL("check_design_criteria", { designSpeedMph: 70, emax: 0.06 })));
  console.log(`   re-check: ${c1.failed} failures -> ${c2.failed}`);
  await beat(3, "re-check — failure count drops");

  console.log("\n1:15-1:45  agent: bank the curves for 70 mph");
  const before = JSON.parse(await ev(CALL("read_cross_section", { station: 2500 })));
  const edge = (x, side) => {
    const a = x?.[side]; if (!Array.isArray(a) || !a.length) return "n/a";
    const p = a[a.length - 1];
    return (p.point.z - x.centerline.z).toFixed(3) + " ft";
  };
  console.log(`   cross section 25+00 BEFORE:  left ${edge(before,"left")}   right ${edge(before,"right")}`);
  const sup = JSON.parse(await ev(CALL("set_superelevation", { designSpeedMph: 70, emax: 0.06, commit: true })));
  console.log("   set_superelevation:", sup.committed ? "committed" : "REFUSED");
  const tr = JSON.parse(await ev(CALL("read_superelevation", {})));
  (tr.transitions || []).forEach((t, i) => console.log(
    `   curve ${i + 1} ${t.direction}  R=${t.radiusFt}  e=${t.fullSuperPercent}%  runoff ${t.runoffLengthFt} ft`));
  const after = JSON.parse(await ev(CALL("read_cross_section", { station: 2500 })));
  console.log(`   cross section 25+00 AFTER :  left ${edge(after,"left")}   right ${edge(after,"right")}`);
  await beat(4, "banking numbers — Design view");
  await ev(click3d); await sleep(3000);
  await ev(`(() => { const s=document.getElementById('exag'); if(s){ s.value='10'; s.dispatchEvent(new Event('change')); } })()`);
  await sleep(1800);
  await beat(5, "3D corridor at 10x exaggeration — the road banked");
  await ev(clickDesign); await sleep(1200);

  console.log("\n1:45-2:15  agent: export the LandXML  ->  REFUSED");
  const blocked = JSON.parse(await ev(CALL("export_landxml", {})));
  console.log("   ", blocked.refused ? blocked.code : "OK (UNEXPECTED)");
  console.log("   ", (blocked.detail || "").slice(0, 130));
  const names = (await ev(`(async () => (await (document.modelContext ?? navigator.modelContext).getTools()).map(t=>t.name).join(","))()`)).split(",");
  console.log("    tools that could clear it:",
    names.filter((n) => /(^|_)(confirm|approve|seal|sign|accept)(_|$)/i.test(n)).length === 0 ? "NONE" : "SOME");
  await beat(6, "the refusal + the yellow confirmation banner — THE MONEY SHOT");

  console.log("\n2:15-2:40  the engineer confirms, and the export succeeds");
  await ev(`(() => { const b=document.querySelector('#agentPending .pending-confirm'); if(b) b.click(); })()`);
  await sleep(1000);
  const okxml = JSON.parse(await ev(CALL("export_landxml", {})));
  console.log("   export:", okxml.refused ? "still refused" : `OK, ${okxml.lengthBytes} bytes of LandXML`);
  await beat(7, "export succeeds, banner gone");

  console.log("\n2:40-2:50  every one of those was a WebMCP tool call");
  await ev(`(() => { const d=document.getElementById('agentLog'); if(d) d.open = true; })()`);
  await sleep(600);
  console.log("   ", (await ev("(document.querySelector('#agentLog summary')||{}).textContent||''")).trim());
  await beat(8, "activity log open — proof it was WebMCP throughout");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
