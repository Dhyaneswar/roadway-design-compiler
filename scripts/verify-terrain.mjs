/**
 * Terrain, end to end: an agent imports real ground, the 3D view shows the road
 * sitting on it, and cut/fill is computed against a real surveyed surface.
 *
 * Usage: node scripts/verify-terrain.mjs <dist> <landxml-with-surface> [outDir] [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize, basename } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, XML, OUT = ".", PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8240);
const CDP = 9450;
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
  profile = mkdtempSync(join(tmpdir(), "terr-"));
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

  console.log("=== before: is there any ground? ===");
  console.log(" ", JSON.parse(await ev(CALL("read_terrain_extent", {}))).note ?? "loaded");
  const noGround = JSON.parse(await ev(CALL("read_ground", {})));
  console.log("  read_ground:", noGround.refused ? noGround.code : "OK (unexpected)");

  await cdp("Runtime.evaluate", {
    expression: `window.__xml = ${JSON.stringify(readFileSync(XML, "utf8"))}; "ok"`,
  });

  console.log(`\n=== agent imports ${basename(XML)} — alignment AND ground ===`);
  const imp = JSON.parse(await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === "import_landxml");
    const raw = await mc.executeTool(t, JSON.stringify({ xml: window.__xml, commit: true }));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return o.content[0].text;
  })()`));
  console.log("  committed:", imp.committed, "| alignment:", imp.importedFrom?.alignmentName);
  console.log("  road length:", imp.alignmentLengthFt, "ft");

  console.log("\n=== the ground it landed on ===");
  const ext = JSON.parse(await ev(CALL("read_terrain_extent", {})));
  console.log(`  surface "${ext.name}": ${ext.triangles} triangles, ${ext.points} points`);
  console.log(`  elevation range: ${ext.boundsFt?.elevation?.map((v) => v.toFixed(1)).join(" .. ")} ft`);
  console.log(`  alignment fully on the survey: ${ext.alignmentFullyOnSurface}` +
    (ext.stationsOffSurface ? ` (${ext.stationsOffSurface} stations off it)` : ""));

  console.log("\n=== cut and fill against real ground ===");
  const g = JSON.parse(await ev(CALL("read_ground", {})));
  if (g.refused) console.log("  REFUSED", g.code);
  else {
    console.log(`  ${g.sampled} stations · max cut ${g.maxCutFt} ft · max fill ${g.maxFillFt} ft`);
    console.log(`  balance points: ${g.balancePoints.length}  mean |cut/fill|: ${g.meanAbsFt} ft`);
    console.log("  note:", g.note);
    for (const s of (g.samples || []).slice(0, 3)) {
      console.log(`    sta ${s.station.toFixed(0).padStart(6)}  ground ${s.groundZ.toFixed(2).padStart(8)}  ` +
        `design ${s.designZ.toFixed(2).padStart(8)}  ${s.cutFillFt > 0 ? "FILL" : "CUT "} ${Math.abs(s.cutFillFt).toFixed(2)} ft`);
    }
  }

  console.log("\n=== does the 3D view show the road on the ground? ===");
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='3D corridor'); if(b) b.click(); })()`);
  await sleep(3500);
  await ev(`(() => { const s=document.getElementById('exag'); if(s){ s.value='5'; s.dispatchEvent(new Event('change')); } })()`);
  await sleep(2000);
  await shot("terrain-3d.png");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
