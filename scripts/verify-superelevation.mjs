/**
 * Does an agent turning superelevation on actually bank the road?
 *
 * Proves it two ways at once: the cross-section numbers flip sign through the
 * curve, and the 3D corridor visibly rolls. Screenshots before and after.
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
const WEB = Number(process.argv[4] || 8180);
const CDP = 9412;
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
const click = (label) => `(() => { const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()===${JSON.stringify(label)}); b.forEach(x=>x.click()); return b.length; })()`;

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
  profile = mkdtempSync(join(tmpdir(), "sup-"));
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

  // Cross section mid-curve BEFORE banking
  console.log("BEFORE, cross section @ 2500:");
  const before = await ev(CALL("read_cross_section", { station: 2500 }));
  const b = JSON.parse(before);
  const edge = (x, side) => {
    const arr = x?.[side]; if (!Array.isArray(arr) || arr.length === 0) return "n/a";
    const p = arr[arr.length - 1];
    return (p.point.z - x.centerline.z).toFixed(3) + " ft @ " + p.offset + " ft";
  };
  console.log("  left edge :", edge(b, "left"));
  console.log("  right edge:", edge(b, "right"));

  await ev(click("3D corridor")); await sleep(2500);
  await ev(`(() => { const s=document.getElementById('exag'); if(s){ s.value='10'; s.dispatchEvent(new Event('change')); } })()`);
  await sleep(1500);
  await shot("sup-01-before.png");

  console.log("\nagent turns superelevation on (70 mph, emax 6%):");
  console.log(" ", (await ev(CALL("set_superelevation",
    { designSpeedMph: 70, emax: 0.06, commit: true }))).slice(0, 220));

  console.log("\ntransitions:");
  const tr = JSON.parse(await ev(CALL("read_superelevation", {})));
  (tr.transitions || []).forEach((t) => {
    console.log(`  curve ${t.curveIndex + 1} ${t.direction}  R=${t.radiusFt}  e=${t.fullSuperPercent}%  ` +
      `Lr=${t.runoffLengthFt}  Lt=${t.tangentRunoutFt}  full ${t.pcStation.toFixed(0)}->${t.ptStation.toFixed(0)}`);
  });

  console.log("\nAFTER, cross section @ 2500:");
  const after = JSON.parse(await ev(CALL("read_cross_section", { station: 2500 })));
  const edge2 = (x, side) => {
    const arr = x?.[side]; if (!Array.isArray(arr) || arr.length === 0) return "n/a";
    const p = arr[arr.length - 1];
    return (p.point.z - x.centerline.z).toFixed(3) + " ft @ " + p.offset + " ft";
  };
  console.log("  left edge :", edge2(after, "left"));
  console.log("  right edge:", edge2(after, "right"));

  await sleep(2000);
  await shot("sup-02-after.png");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
