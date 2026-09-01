/**
 * The coordinate system is project state, end to end, in the real app.
 *
 * The unit tests drive a fake host. This drives studio/main.ts itself: the two
 * <select> elements, the scale-factor input, readForm/writeForm/restoreForm, the
 * ledger and both exports. F004 was precisely a bug in that wiring -- the CRS
 * was read off the DOM and never entered the form -- so a fake host could not
 * have caught it and cannot prove it fixed.
 *
 * Usage: node scripts/verify-crs.mjs <dist> [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8267);
const CDP = 9477;
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
let sock, chrome, profile, id = 0, failures = 0;
function cdp(m, p = {}) {
  return new Promise((res, rej) => {
    const i = ++id; const t = setTimeout(() => rej(new Error(m + " timeout")), 120000);
    const h = (e) => { const x = JSON.parse(e.data); if (x.id !== i) return;
      clearTimeout(t); sock.removeEventListener("message", h);
      if (x.error) return rej(new Error(x.error.message));
      res(x.result); };
    sock.addEventListener("message", h); sock.send(JSON.stringify({ id: i, method: m, params: p }));
  });
}
const ev = async (e) => (await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
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
const call = async (tool, args) => JSON.parse(await ev(CALL(tool, args)));
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures += 1;
}
// What the two <select> elements and the CSF input actually hold.
const CONTROLS = `JSON.stringify({
  zone: document.getElementById('crsZone').value,
  basis: document.getElementById('crsBasis').value,
  csf: (document.getElementById('crsCsf') || {}).value ?? null,
  csfRowShown: (document.getElementById('csfRow') || {}).style?.display !== 'none',
})`;

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "crs-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1400,900", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("no page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  console.log("=== the CRS is in the saved design, not beside it ===");
  const doc0 = await call("read_design_document", {});
  check("read_design_document carries the CRS", JSON.stringify(doc0).includes("GA-West"),
    JSON.stringify(doc0).includes("crs") ? "crs present" : "NO crs key at all");

  console.log("\n=== an agent change moves the real controls and enters the ledger ===");
  const set = await call("set_coordinate_system", { zone: "GA-East", basis: "grid", commit: true });
  check("committed", set.committed === true, set.code ?? "");
  const c1 = JSON.parse(await ev(CONTROLS));
  check("the Studio's own select moved", c1.zone === "GA-East", `select shows ${c1.zone}`);
  const pend = await call("read_pending_changes", {});
  check("it is in the pending ledger", pend.pendingCount === 1,
    `${pend.pendingCount} pending: ${JSON.stringify(pend.pending?.map((p) => p.description))}`);

  console.log("\n=== undo restores it -- the F004 failure ===");
  const undo = await call("undo_last_change", {});
  check("undo succeeded", undo.undone === true, undo.code ?? "");
  const c2 = JSON.parse(await ev(CONTROLS));
  check("the zone is back to GA-West", c2.zone === "GA-West", `select shows ${c2.zone}`);
  const pend2 = await call("read_pending_changes", {});
  check("the ledger is clear", pend2.pendingCount === 0, `${pend2.pendingCount} pending`);

  console.log("\n=== ground coordinates require a scale factor ===");
  const bad = await call("set_coordinate_system", { zone: "GA-West", basis: "ground", commit: true });
  check("refused without a CSF", bad.code === "GroundBasisNeedsScaleFactor", bad.code ?? "accepted");
  const c3 = JSON.parse(await ev(CONTROLS));
  check("nothing changed on refusal", c3.basis === "grid", `basis is ${c3.basis}`);

  const good = await call("set_coordinate_system",
    { zone: "GA-West", basis: "ground", combinedScaleFactor: 0.99988, commit: true });
  check("accepted with a CSF", good.committed === true, good.code ?? "");
  const c4 = JSON.parse(await ev(CONTROLS));
  check("the CSF input holds it", String(c4.csf) === "0.99988", `input shows ${c4.csf}`);
  check("the CSF row is visible for ground", c4.csfRowShown === true);

  console.log("\n=== both exports describe the same world ===");
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/confirm/i.test(x.textContent)); if(b) b.click(); })()`);
  await sleep(600);
  const csv = await call("export_staking_csv", { intervalFt: 100 });
  const xml = await call("export_landxml", {});
  if (csv.refused || xml.refused) {
    check("exports produced", false, `csv:${csv.code ?? "ok"} xml:${xml.code ?? "ok"}`);
  } else {
    check("CSV carries EPSG 2240", String(csv.csv).includes("2240"));
    check("LandXML carries EPSG 2240", String(xml.landxml).includes("2240"));
    check("CSV does not claim the CRS is unset", !String(csv.csv).includes("CRS not set"));
    check("CSV states the ground basis", String(csv.csv).includes("ground"));
  }

  console.log("\n=== a human can select local coordinates, and so can an agent ===");
  const local = await call("set_coordinate_system", { zone: "", basis: "grid", commit: true });
  check("empty zone accepted", local.committed === true, local.code ?? "");
  const c5 = JSON.parse(await ev(CONTROLS));
  check("the select shows None", c5.zone === "", `select shows "${c5.zone}"`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
