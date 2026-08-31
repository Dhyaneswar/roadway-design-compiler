/**
 * An agent dressing a road: materials, then roadside furniture, then a look at it.
 *
 * The point of this one is that NOTHING here is inferred. The agent states what
 * each segment is made of and places each rail, barrier and marking between
 * stations it chose. The viewer draws exactly that and nothing else.
 *
 * Usage: node scripts/verify-roadside.mjs <dist> [outDir] [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, OUT = ".", PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8250);
const CDP = 9470;
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
  mkdirSync(OUT, { recursive: true });
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

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "rs-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1500,980", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("no page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  console.log("=== 1. what is the road made of? ===");
  for (const [side, i, mat] of [["left",1,"asphalt"],["left",2,"gravel"],["right",1,"asphalt"],["right",2,"gravel"]]) {
    const r = JSON.parse(await ev(CALL("set_segment_material",
      { template: "2-lane", side, index: i, material: mat, commit: true })));
    console.log(`   ${side} segment ${i} -> ${mat}: ${r.committed ? "committed" : "REFUSED " + r.code}`);
  }

  console.log("\n=== 2. nothing is placed until someone places it ===");
  const empty = JSON.parse(await ev(CALL("read_roadside", {})));
  console.log(`   count ${empty.count} — "${empty.note}"`);

  console.log("\n=== 3. the agent places furniture ===");
  const place = async (o) => {
    const r = JSON.parse(await ev(CALL("place_roadside_item", { ...o, commit: true })));
    console.log(`   ${String(o.id).padEnd(12)} ${r.committed ? `placed, ${r.placed.lengthFt} ft` : "REFUSED " + r.code}`);
    return r;
  };
  await place({ id: "gr-left-1", kind: "guardrail", side: "left", beginStationFt: 2000, endStationFt: 3400, offsetFt: 20 });
  await place({ id: "cb-right-1", kind: "concrete-barrier", side: "right", beginStationFt: 4200, endStationFt: 5200, offsetFt: 19 });
  await place({ id: "cl-stripe", kind: "pavement-marking", side: "right", beginStationFt: 1000, endStationFt: 6225, offsetFt: 0.5, pattern: "dashed" });

  console.log("\n=== 4. what it refuses ===");
  const bad = JSON.parse(await ev(CALL("place_roadside_item",
    { id: "gr-bad", kind: "guardrail", side: "left", beginStationFt: 5000, endStationFt: 9000, offsetFt: 20, commit: true })));
  console.log(`   off the end of the alignment: ${bad.code}`);
  const neg = JSON.parse(await ev(CALL("place_roadside_item",
    { id: "gr-neg", kind: "guardrail", side: "left", beginStationFt: 2000, endStationFt: 2400, offsetFt: -20, commit: true })));
  console.log(`   signed offset:                ${neg.code}`);
  const nopat = JSON.parse(await ev(CALL("place_roadside_item",
    { id: "mk-nopat", kind: "pavement-marking", side: "left", beginStationFt: 2000, endStationFt: 2400, offsetFt: 6, commit: true })));
  console.log(`   marking with no pattern:      ${nopat.code}`);

  console.log("\n=== 5. quantity take-off ===");
  const q = JSON.parse(await ev(CALL("read_roadside", {})));
  for (const row of q.quantities) console.log(`   ${row.kind.padEnd(18)} ${row.count} item(s)  ${row.totalLengthFt} ft`);

  console.log("\n=== 6. the 3D view ===");
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='3D corridor'); if(b) b.click(); })()`);
  await sleep(3500);
  await ev(`(() => { const s=document.getElementById('exag'); if(s){ s.value='2'; s.dispatchEvent(new Event('change')); } })()`);
  await sleep(1500);
  await shot("roadside-3d-wide.png");
  // Zoom to where the guardrail actually is -- 2.5 ft of steel on a 6,000 ft road
  // is invisible at full extent, which is a camera problem, not a geometry one.
  const cv = await ev(`(() => { const c = document.querySelector('#view3d canvas'); if(!c) return null;
    const r = c.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  if (cv) {
    for (let i = 0; i < 16; i++) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: cv.x, y: cv.y, deltaX: 0, deltaY: -110 });
      await sleep(70);
    }
    await sleep(1200);
    await shot("roadside-3d-close.png");
  }
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
