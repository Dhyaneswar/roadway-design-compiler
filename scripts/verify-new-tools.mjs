/**
 * The three new tools, driven over WebMCP against the built app.
 *
 *   undo_last_change      undoes unconfirmed work, REFUSES confirmed work
 *   propose_alternatives  computes options and applies none
 *   export_staking_csv    a second deliverable, behind the same seal
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DIST = process.argv[2] || "T:\\search - Copy\\roadway\\studio\\dist";
const OUT = process.argv[3] || ".";
const WEB = Number(process.argv[4] || 8210);
const CDP = 9422;
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
  console.log("   shot ->", n);
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
const range = `(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  const tools = await mc.getTools();
  const t = tools.find(x => x.name === 'read_alignment_range');
  const raw = await mc.executeTool(t, "{}");
  let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
  return JSON.parse(o.content[0].text).endStationFt;
})()`;

const A = (label, rationale, radius, lastSta, lastEl) => ({
  label, rationale,
  design: {
    name: "RDC-DESIGN-1", rationale,
    beginStation: 1000, startE: 2200000, startN: 1350000, startAzimuthDeg: 75,
    elements: [
      { type: "tangent", length: 1200 },
      { type: "arc", radius, deltaDeg: 45, direction: "right" },
      { type: "tangent", length: 800 },
    ],
    pvis: [
      { station: 1000, elevation: 850 },
      { station: 2200, elevation: 872, curveLength: 500 },
      { station: lastSta, elevation: lastEl },
    ],
  },
});

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "new-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1500,1000", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("no page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  const names = (await ev(`(async () => (await (document.modelContext ?? navigator.modelContext).getTools()).map(t=>t.name).join(","))()`)).split(",");
  console.log("tools:", names.length);
  for (const n of ["undo_last_change", "propose_alternatives", "export_staking_csv"]) {
    console.log("  " + n.padEnd(22) + (names.includes(n) ? "registered" : "MISSING"));
  }

  console.log("\n=== undo_last_change ===");
  console.log("  nothing to undo yet:", JSON.parse(await ev(CALL("undo_last_change", {}))).code);
  const start = await ev(range);
  await ev(CALL("add_horizontal_element", { type: "tangent", lengthFt: 900, commit: true }));
  const grown = await ev(range);
  console.log(`  agent adds 900 ft:   end station ${start} -> ${grown}`);
  const undone = JSON.parse(await ev(CALL("undo_last_change", {})));
  const back = await ev(range);
  console.log(`  undo:                ${undone.undone ? "undone" : "FAILED"} -> end station ${back}`);
  console.log("  restored exactly:   ", back === start);

  console.log("\n=== undo REFUSES confirmed work ===");
  await ev(CALL("add_horizontal_element", { type: "tangent", lengthFt: 500, commit: true }));
  await ev(`(() => { const b=document.querySelector('#agentPending .pending-confirm'); if(b) b.click(); })()`);
  await sleep(700);
  const refused = JSON.parse(await ev(CALL("undo_last_change", {})));
  console.log("  after the engineer confirms:", refused.code);
  console.log(" ", (refused.detail || "").slice(0, 110));

  console.log("\n=== propose_alternatives ===");
  const alts = JSON.parse(await ev(CALL("propose_alternatives", {
    question: "Three ways to take the curve",
    designSpeedMph: 60,
    alternatives: [
      A("tight", "shortest alignment, least right-of-way", 900, 4000, 858),
      A("balanced", "middle ground", 1800, 4700, 861),
      A("gentle", "most forgiving, widest take", 3200, 5600, 866),
    ],
  })));
  console.log("  offered:", alts.offered, "| appliedAnything:", alts.appliedAnything);
  for (const a of alts.alternatives || []) {
    if (a.refusal) { console.log(`  ${String(a.label).padEnd(9)} invalid: ${a.refusal.code}`); continue; }
    console.log(`  ${String(a.label).padEnd(9)} ${String(a.alignmentLengthFt).padStart(8)} ft  min R ${String(a.minRadiusFt).padStart(5)}  ` +
      `min K ${String(a.minK).padStart(6)}  criteria ${a.criteriaFailed}/${a.criteriaChecked} fail`);
  }
  const afterOffer = await ev(range);
  console.log("  design untouched by the offer:", afterOffer === back + 500);
  await shot("new-01-alternatives.png");
  console.log("  adopt tools available to the agent:",
    names.filter((n) => /adopt|choose|select_alt/i.test(n)).length === 0 ? "NONE" : "SOME");

  console.log("\n=== export_staking_csv ===");
  const blocked = JSON.parse(await ev(CALL("export_staking_csv", { intervalFt: 50 })));
  console.log("  with nothing pending:", blocked.refused ? "REFUSED " + blocked.code : `OK, ${blocked.pointCount} points`);
  if (!blocked.refused) {
    console.log("  first data line:", String(blocked.csv).split("\n").find((l) => !l.startsWith("#") && !l.startsWith("station,")));
  }
  await ev(CALL("set_superelevation", { designSpeedMph: 60, emax: 0.06, commit: true }));
  const gated = JSON.parse(await ev(CALL("export_staking_csv", { intervalFt: 50 })));
  console.log("  after an unconfirmed change:", gated.refused ? "REFUSED " + gated.code : "OK (UNEXPECTED)");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
