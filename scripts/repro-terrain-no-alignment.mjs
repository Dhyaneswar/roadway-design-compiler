/**
 * REPRO: a terrain-only LandXML imports "successfully" and renders nothing.
 *
 * A/B, same app, same session:
 *   A. import a file with NO alignment but a real TIN  -> tool says committed, 3D is empty
 *   B. import a file WITH an alignment and the same    -> tool says committed, 3D shows ground
 *
 * The difference is the only variable: whether the import moved the design origin.
 * The 3D view draws ground in the CORRIDOR's frame and drops points beyond a reach
 * derived from the corridor, so ground that never got a matching origin is filtered
 * out entirely -- silently, with the tool still reporting success.
 *
 * Usage: node scripts/repro-terrain-no-alignment.mjs <dist> <terrainOnlyXml> <alignmentXml> [outDir] [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize, basename } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, XML_A, XML_B, OUT = ".", PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8261);
const CDP = 9471;
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

// ⚠ Do NOT try to measure the 3D view by reading the canvas back in-page.
// drawImage() on a WebGL canvas without preserveDrawingBuffer returns a BLANK
// image, so an in-page pixel probe reports "100% background" for a scene that is
// in fact fully drawn. It did exactly that here and proved nothing in both arms.
// Page.captureScreenshot goes through the compositor and shows the real frame.
// The screenshots are the evidence; read them.

async function importFile(path, label) {
  await cdp("Runtime.evaluate", {
    expression: `window.__xml = ${JSON.stringify(readFileSync(path, "utf8"))}; "ok"`,
  });
  const r = JSON.parse(await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === "import_landxml");
    const raw = await mc.executeTool(t, JSON.stringify({ xml: window.__xml, commit: true }));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return o.content[0].text;
  })()`));
  console.log(`\n=== ${label}: ${basename(path)} ===`);
  if (r.refused) {
    console.log(`  REFUSED ${r.code}: ${r.detail}`);
    return r;
  }
  console.log(`  tool says committed: ${r.committed}`);
  console.log(`  change: ${r.change ?? "(imported alignment)"}`);
  if (r.groundSurface) {
    console.log(`  ground surface: "${r.groundSurface.name}" ` +
      `${r.groundSurface.triangles} triangles, ${r.groundSurface.points} points`);
  }
  return r;
}

async function look(label, shotName) {
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='3D corridor'); if(b) b.click(); })()`);
  await sleep(3500);
  await shot(shotName);
}

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "repro-"));
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

  const setup = JSON.parse(await ev(CALL("read_design", {})));
  console.log("=== the design the app starts with ===");
  console.log(`  origin  E ${setup.project.startEastingFt}  N ${setup.project.startNorthingFt}`);

  // ---- A: terrain only, no alignment -------------------------------------
  const a = await importFile(XML_A, "A  terrain only, NO alignment");
  const extA = JSON.parse(await ev(CALL("read_terrain_extent", {})));
  console.log(`  read_terrain_extent -> ${extA.refused ? "REFUSED " + extA.code
    : `"${extA.name}" ${extA.triangles} triangles  E ${extA.boundsFt?.easting?.map(Math.round).join("..")}` +
      `  N ${extA.boundsFt?.northing?.map(Math.round).join("..")}`}`);
  await look("A", "repro-A-terrain-only.png");

  // ---- B: same app, a file that carries an alignment too ------------------
  const b = await importFile(XML_B, "B  alignment AND terrain");
  const extB = JSON.parse(await ev(CALL("read_terrain_extent", {})));
  console.log(`  read_terrain_extent -> ${extB.refused ? "REFUSED " + extB.code
    : `"${extB.name}" ${extB.triangles} triangles`}`);
  const designB = JSON.parse(await ev(CALL("read_design", {})));
  console.log(`  origin now  E ${designB.project.startEastingFt}  N ${designB.project.startNorthingFt}`);
  await look("B", "repro-B-with-alignment.png");

  console.log("\n=== VERDICT ===");
  console.log(`  A (no alignment): tool committed=${a.committed}, ground data present=${!extA.refused}`);
  console.log(`  B (alignment):    tool committed=${b.committed}, ground data present=${!extB.refused}`);
  console.log("  Both arms report SUCCESS from the tool and hold the surface in memory.");
  console.log("  The difference is visible only in the two screenshots:");
  console.log("    repro-A-terrain-only.png    -> road drawn, NO ground");
  console.log("    repro-B-with-alignment.png  -> road drawn ON the ground");

  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
