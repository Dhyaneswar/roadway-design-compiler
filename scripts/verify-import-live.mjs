/**
 * An agent importing a REAL, third-party LandXML file over WebMCP.
 *
 * Uses public sample files that do not ship with this repo, so it takes their
 * paths as arguments. The point is that the road being imported was drawn by
 * somebody else, in somebody else's software.
 *
 * Usage: node scripts/verify-import-live.mjs <dist> <good.xml> <spiralled.xml> [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize, basename } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, GOOD, SPIRALLED, PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8230);
const CDP = 9440;
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

/** Pass the file through a global so a megabyte of XML never goes into an eval string. */
async function callWithXml(tool, xmlVar, extra = {}) {
  return ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === ${JSON.stringify(tool)});
    if (!t) return JSON.stringify({ missing: ${JSON.stringify(tool)} });
    const args = Object.assign({ xml: window.${xmlVar} }, ${JSON.stringify(extra)});
    const raw = await mc.executeTool(t, JSON.stringify(args));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    const txt = o && o.content && o.content[0] && o.content[0].text;
    return typeof txt === "string" ? txt : JSON.stringify(o);
  })()`);
}
const CALL = (tool, args) => `(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  const tools = await mc.getTools();
  const t = tools.find(x => x.name === ${JSON.stringify(tool)});
  const raw = await mc.executeTool(t, JSON.stringify(${JSON.stringify(args)}));
  let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
  const txt = o && o.content && o.content[0] && o.content[0].text;
  return typeof txt === "string" ? txt : JSON.stringify(o);
})()`;

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "imp-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1440,950", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("no page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  await cdp("Runtime.evaluate", {
    expression: `window.__good = ${JSON.stringify(readFileSync(GOOD, "utf8"))};` +
      `window.__spiral = ${JSON.stringify(readFileSync(SPIRALLED, "utf8"))};` +
      `"loaded"`,
  });

  console.log(`=== agent imports ${basename(GOOD)} — drawn by someone else ===`);
  const preview = JSON.parse(await callWithXml("import_landxml", "__good"));
  if (preview.refused) { console.log("  REFUSED", preview.code, preview.detail); }
  else {
    console.log("  PREVIEW  length", preview.alignmentLengthFt, "ft ·", preview.curveCount, "curves");
    console.log("  from     ", JSON.stringify(preview.importedFrom?.alignmentsInFile));
    console.log("  unit     ", preview.importedFrom?.sourceUnit);
    for (const n of preview.importedFrom?.notes ?? []) console.log("  note:", n);
  }
  const before = await ev(`(() => document.getElementById('name').value)()`);
  const committed = JSON.parse(await callWithXml("import_landxml", "__good", { commit: true }));
  const after = await ev(`(() => document.getElementById('name').value)()`);
  console.log(`  preview changed nothing: ${before !== after ? "NO" : "yes"} (name was "${before}")`);
  console.log(`  COMMIT   design name is now "${after}"`);

  console.log("\\n=== the agent then critiques the imported road ===");
  const crit = JSON.parse(await ev(CALL("check_design_criteria", { designSpeedMph: 45, emax: 0.06 })));
  console.log(`  at 45 mph: ${crit.checked} checks, ${crit.failed} failed`);
  const worst = (crit.verdicts || []).find((v) => v.status === "fail");
  if (worst) console.log("  e.g.", worst.detail);

  console.log(`\\n=== ${basename(SPIRALLED)} — a file it must NOT pretend to read ===`);
  const spir = JSON.parse(await callWithXml("import_landxml", "__spiral", { commit: true }));
  console.log("  ", spir.refused ? spir.code : "IMPORTED (WRONG)");
  console.log("  ", (spir.detail || "").slice(0, 150));
  const stillThere = await ev(`(() => document.getElementById('name').value)()`);
  console.log(`  design untouched by the refusal: ${stillThere === after}`);
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
