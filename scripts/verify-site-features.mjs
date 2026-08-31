/**
 * Importing the site that is already there, and designing into it.
 *
 * A survey LandXML carries no alignment and no surface -- only what exists. The
 * point of this check is that such a file is USEFUL, not refused: the site loads,
 * reports its extent, and an alignment can then be placed inside it.
 *
 * Usage: node scripts/verify-site-features.mjs <dist> <survey.xml> [outDir] [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize, basename } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, XML, OUT = ".", PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8280);
const CDP = 9490;
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
  profile = mkdtempSync(join(tmpdir(), "site-"));
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

  await cdp("Runtime.evaluate", {
    expression: "window.__xml = " + JSON.stringify(readFileSync(XML, "utf8")) + "; 'ok'",
  });

  console.log("=== before ===");
  console.log(" ", JSON.parse(await ev(CALL("read_site_features", {}))).note);

  console.log("\n=== agent imports " + basename(XML) + " (a survey: no alignment, no surface) ===");
  const imp = JSON.parse(await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === "import_landxml");
    const raw = await mc.executeTool(t, JSON.stringify({ xml: window.__xml, commit: true }));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return o.content[0].text;
  })()`));
  if (imp.refused) console.log("  REFUSED", imp.code, "-", String(imp.detail).slice(0, 110));
  else {
    console.log("  " + imp.change);
    console.log("  " + imp.note);
  }

  console.log("\n=== the existing site ===");
  const sf = JSON.parse(await ev(CALL("read_site_features", {})));
  if (!sf.loaded) { console.log("  NOT LOADED -", sf.note); }
  else {
    console.log(`  ${sf.featureCount} features · ${sf.pointCount} points · ${sf.unresolvedRefs} unresolved refs`);
    const b = sf.siteExtentFt;
    console.log(`  extent  N ${b.minN.toFixed(0)}..${b.maxN.toFixed(0)}   E ${b.minE.toFixed(0)}..${b.maxE.toFixed(0)} ft`);
    console.log("  groups:", (sf.groups || []).slice(0, 8).map((g) => `${g.group}(${g.count})`).join("  "));
    console.log("  " + sf.note);
  }

  console.log("\n=== now design a road INTO that site ===");
  if (sf.loaded) {
    const b = sf.siteExtentFt;
    const setup = JSON.parse(await ev(CALL("set_project_setup", {
      name: "Road through the site",
      startEastingFt: Math.round(b.minE + 40),
      startNorthingFt: Math.round((b.minN + b.maxN) / 2),
      beginStationFt: 0, startAzimuthDeg: 90, commit: true,
    })));
    console.log("  place the alignment start inside the site:", setup.committed ? "committed" : "REFUSED " + setup.code);
    const len = JSON.parse(await ev(CALL("read_alignment_range", {})));
    console.log(`  alignment now ${len.beginStationFt}..${len.endStationFt} ft`);
  }

  console.log("\n=== the 3D view ===");
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='3D corridor'); if(b) b.click(); })()`);
  await sleep(3500);
  await shot("site-3d.png");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
