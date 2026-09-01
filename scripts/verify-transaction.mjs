/**
 * One transaction boundary: everything a change touched, undone together.
 *
 * Drives the REAL studio, because that is where the defect lived. A fake host
 * can only mirror snapshotProject/restoreProject, and independent QA rightly
 * pointed out that a mirror cannot catch a regression in the thing it mirrors.
 *
 *   F010  A terrain-only commit never reached the ledger: pending stayed at
 *         zero, undo said NothingToUndo, and the surface stayed loaded. A
 *         combined import reported undone:true, restored the road, and left the
 *         replacement terrain in place.
 *   F015  A shared design arrived with no pending banner and a live export
 *         button, so unconfirmed agent work laundered through a link.
 *
 * Usage: node scripts/verify-transaction.mjs <dist> [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8269);
const CDP = 9479;
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
let chrome, profile, failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures += 1;
}

/** A TIN at a chosen elevation, so two imports are told apart by their bounds. */
const terrainXml = (name, z) => `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Imperial linearUnit="foot" areaUnit="squareFoot" volumeUnit="cubicFeet"
    angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>
  <Surfaces><Surface name="${name}"><Definition surfType="TIN">
    <Pnts>
      <P id="1">1349000 2199000 ${z}</P>
      <P id="2">1352000 2199000 ${z}</P>
      <P id="3">1349000 2202000 ${z}</P>
      <P id="4">1352000 2202000 ${z}</P>
    </Pnts>
    <Faces><F>1 2 3</F><F>2 4 3</F></Faces>
  </Definition></Surface></Surfaces>
</LandXML>`;

function connect(port, web) {
  let sock, id = 0;
  const api = {
    async open() {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${web}`));
      if (!page) throw new Error("no page");
      sock = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });
    },
    cdp(m, p = {}) {
      return new Promise((res, rej) => {
        const i = ++id; const t = setTimeout(() => rej(new Error(m + " timeout")), 120000);
        const h = (e) => { const x = JSON.parse(e.data); if (x.id !== i) return;
          clearTimeout(t); sock.removeEventListener("message", h);
          if (x.error) return rej(new Error(x.error.message));
          res(x.result); };
        sock.addEventListener("message", h); sock.send(JSON.stringify({ id: i, method: m, params: p }));
      });
    },
    async ev(e) { return (await api.cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value; },
    async call(tool, args) {
      return JSON.parse(await api.ev(`(async () => {
        const mc = document.modelContext ?? navigator.modelContext;
        const tools = await mc.getTools();
        const t = tools.find(x => x.name === ${JSON.stringify(tool)});
        if (!t) return JSON.stringify({ missing: ${JSON.stringify(tool)} });
        const raw = await mc.executeTool(t, JSON.stringify(${JSON.stringify(args)}));
        let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
        const txt = o && o.content && o.content[0] && o.content[0].text;
        return typeof txt === "string" ? txt : JSON.stringify(o);
      })()`));
    },
    async importXml(xml, commit) {
      await api.cdp("Runtime.evaluate", { expression: `window.__x = ${JSON.stringify(xml)}; "ok"` });
      return JSON.parse(await api.ev(`(async () => {
        const mc = document.modelContext ?? navigator.modelContext;
        const tools = await mc.getTools();
        const t = tools.find(x => x.name === "import_landxml");
        const raw = await mc.executeTool(t, JSON.stringify({ xml: window.__x, commit: ${commit} }));
        let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
        return o.content[0].text;
      })()`));
    },
    close() { sock?.close(); },
  };
  return api;
}

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "txn-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1400,900", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const a = connect(CDP, WEB);
  await a.open();

  console.log("=== F010: a terrain-only commit is a transaction ===");
  const pre = await a.call("read_pending_changes", {});
  check("no pending changes to start", pre.pendingCount === 0, `${pre.pendingCount}`);
  const impA = await a.importXml(terrainXml("QA-Terrain-A", 840), true);
  check("terrain A committed", impA.committed === true, impA.code ?? "");
  const extA = await a.call("read_terrain_extent", {});
  check("terrain A is loaded", extA.name === "QA-Terrain-A", extA.name ?? "none");
  const p1 = await a.call("read_pending_changes", {});
  check("it entered the ledger", p1.pendingCount === 1,
    `${p1.pendingCount}: ${JSON.stringify(p1.pending?.map((x) => x.description))}`);

  console.log("\n=== F010: undo puts the ground back ===");
  const u1 = await a.call("undo_last_change", {});
  check("undo succeeded", u1.undone === true, u1.code ?? "");
  const extNone = await a.call("read_terrain_extent", {});
  check("terrain A is gone again", extNone.loaded !== true || extNone.name !== "QA-Terrain-A",
    extNone.name ?? "no ground");

  console.log("\n=== F010: a combined import undoes road AND ground together ===");
  await a.importXml(terrainXml("QA-Terrain-A", 840), true);
  await a.call("place_roadside_item", { id: "qa-gr", kind: "guardrail", side: "left",
    beginStationFt: 1200, endStationFt: 1600, offsetFt: 20, commit: true });
  const beforeRoadside = await a.call("read_roadside", {});
  const beforeGround = await a.call("read_terrain_extent", {});
  check("set-up: ground A and one roadside item",
    beforeGround.name === "QA-Terrain-A" && (beforeRoadside.items?.length ?? beforeRoadside.count) >= 1,
    `${beforeGround.name}, roadside ${JSON.stringify(beforeRoadside.count ?? beforeRoadside.items?.length)}`);

  // An alignment plus a DIFFERENT surface, the shape QA used.
  const combined = readFileSync(join(DIST, "..", "..", "out", "sample-simple-road.xml"), "utf8");
  const impC = await a.importXml(combined, true);
  check("combined import committed", impC.committed === true, impC.code ?? "");
  const afterGround = await a.call("read_terrain_extent", {});
  check("it replaced the ground", afterGround.name !== "QA-Terrain-A", afterGround.name ?? "none");

  const u2 = await a.call("undo_last_change", {});
  check("undo succeeded", u2.undone === true, u2.code ?? "");
  const backGround = await a.call("read_terrain_extent", {});
  check("the ground is back to A", backGround.name === "QA-Terrain-A", backGround.name ?? "none");
  const backRoadside = await a.call("read_roadside", {});
  check("the roadside item is back",
    (backRoadside.count ?? backRoadside.items?.length ?? 0) >= 1,
    JSON.stringify(backRoadside.count ?? backRoadside.items?.length));

  console.log("\n=== F015: unconfirmed work does not launder through a link ===");
  const doc = await a.call("read_design_document", {});
  const pending = await a.call("read_pending_changes", {});
  check("the source page has unconfirmed changes", pending.pendingCount > 0, `${pending.pendingCount}`);
  check("the document carries them", doc.unconfirmedCarried === pending.pendingCount,
    `carried ${doc.unconfirmedCarried} of ${pending.pendingCount}`);
  const link = doc.shareUrl;
  check("a share link was produced", typeof link === "string" && link.includes("#design="));

  // Open the link in a SECOND page and see what the recipient gets.
  await a.cdp("Target.createTarget", { url: link });
  await sleep(4000);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const shared = list.find((t) => t.type === "page" && t.url.includes("#design="));
  if (!shared) {
    check("the shared page opened", false, "no page with a design fragment");
  } else {
    const b = connect(CDP, WEB);
    b.openOn = shared;
    const sock2 = new WebSocket(shared.webSocketDebuggerUrl);
    await new Promise((r, j) => { sock2.addEventListener("open", r, {once:true}); sock2.addEventListener("error", j, {once:true}); });
    let id2 = 0;
    const ev2 = (expr) => new Promise((res, rej) => {
      const i = ++id2; const t = setTimeout(() => rej(new Error("timeout")), 60000);
      const h = (e) => { const x = JSON.parse(e.data); if (x.id !== i) return;
        clearTimeout(t); sock2.removeEventListener("message", h);
        res(x.result?.result?.value); };
      sock2.addEventListener("message", h);
      sock2.send(JSON.stringify({ id: i, method: "Runtime.evaluate",
        params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
    const banner = await ev2(`!!document.getElementById('agentPending')`);
    check("the recipient sees the pending banner", banner === true, `banner present: ${banner}`);
    const listed = await ev2(`(document.querySelectorAll('#agentPending .pending-list li') || []).length`);
    check("it lists the inherited changes", Number(listed) >= pending.pendingCount,
      `${listed} listed vs ${pending.pendingCount} carried`);
    // The deliverable must still be gated for them.
    await ev2(`document.getElementById('download').click(); true`);
    await sleep(400);
    const status = await ev2(`document.getElementById('status').textContent`);
    check("the LandXML download is blocked", /awaiting your confirmation/i.test(String(status)),
      String(status).slice(0, 90));
    sock2.close();
  }

  console.log("\n=== F017: a reload does not clear the confirmation requirement ===");
  // Everything above left pending entries; confirm them so this arm starts clean.
  await a.ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/confirm/i.test(x.textContent)); if(b) b.click(); return true; })()`);
  await sleep(500);
  const clean = await a.call("read_pending_changes", {});
  check("starting from zero pending", clean.pendingCount === 0, `${clean.pendingCount}`);

  await a.call("set_project_setup", { name: "QA-Reload-Probe", commit: true });
  const beforeReload = await a.call("read_pending_changes", {});
  check("the edit is pending before reload", beforeReload.pendingCount === 1,
    `${beforeReload.pendingCount}`);
  const gateBefore = await a.call("export_landxml", {});
  check("export refuses before reload", gateBefore.code === "AwaitingEngineerConfirmation",
    gateBefore.code ?? "produced a file");

  await a.cdp("Page.enable");
  await a.cdp("Page.reload", { ignoreCache: false });
  await sleep(5000);

  const nameAfter = await a.ev(`document.getElementById('name').value`);
  check("the edit survived the reload", nameAfter === "QA-Reload-Probe", String(nameAfter));
  const afterReload = await a.call("read_pending_changes", {});
  check("it is STILL pending after reload", afterReload.pendingCount >= 1,
    `${afterReload.pendingCount}: ${JSON.stringify(afterReload.pending?.map((x) => x.description))}`);
  const gateAfter = await a.call("export_landxml", {});
  check("export STILL refuses after reload", gateAfter.code === "AwaitingEngineerConfirmation",
    gateAfter.code ?? "produced a file");
  const csvAfter = await a.call("export_staking_csv", { intervalFt: 100 });
  check("staking CSV also still refuses", csvAfter.code === "AwaitingEngineerConfirmation",
    csvAfter.code ?? "produced a file");

  console.log("\n=== F018: inherited provenance does not jam undo ===");
  const doc2 = await a.call("read_design_document", {});
  check("the document carries the unconfirmed work", (doc2.unconfirmedCarried ?? 0) >= 1,
    `${doc2.unconfirmedCarried}`);
  const load = await a.call("load_design_document", { document: doc2.document, commit: true });
  check("load committed", load.committed === true, load.code ?? "");
  const afterLoad = await a.call("read_pending_changes", {});
  check("the reply's count matches the reader",
    load.pendingEngineerConfirmation === afterLoad.pendingCount,
    `reply ${load.pendingEngineerConfirmation} vs reader ${afterLoad.pendingCount}`);
  const undoLoad = await a.call("undo_last_change", {});
  check("the load itself can still be undone", undoLoad.undone === true, undoLoad.code ?? "");

  console.log("\n=== F016: paging past the end says so ===");
  await a.importXml(terrainXml("QA-Terrain-Page", 800), true);
  const g1 = await a.call("read_ground", { intervalFt: 50 });
  const lastStation = g1.samples?.[g1.samples.length - 1]?.station;
  const beyond = await a.call("read_ground", { intervalFt: 50, fromStationFt: 99999 });
  check("a station past the end returns nothing, not page one",
    (beyond.returned ?? -1) === 0, `returned ${beyond.returned}, first ${beyond.samples?.[0]?.station}`);
  check("and says why", /already seen the last page/.test(String(beyond.truncation)),
    String(beyond.truncation).slice(0, 80));
  check("a normal first page still works", (g1.returned ?? 0) > 0, `${g1.returned} rows to ${lastStation}`);

  console.log("\n=== F019: the missing-context notice survives repeated reloads ===");
  await a.importXml(terrainXml("QA-Ctx", 900), true);
  const ctxLoaded = await a.call("read_terrain_extent", {});
  check("context imported", ctxLoaded.name === "QA-Ctx", ctxLoaded.name ?? "none");

  for (const pass of ["first", "second", "third"]) {
    await a.cdp("Page.reload", { ignoreCache: false });
    await sleep(4500);
    const warn = await a.ev(`(document.getElementById('contextMissing')||{}).textContent || ""`);
    check(`${pass} reload still names the missing ground`, /QA-Ctx/.test(String(warn)),
      String(warn).slice(0, 66) || "(no notice)");
    const g = await a.call("read_ground", {});
    check(`${pass} reload still reports the geometry unavailable`,
      g.code === "NoGroundSurface", g.code ?? "returned ground");
  }

  console.log("\n=== F019: the JSON path carries it too ===");
  const jdoc = await a.call("read_design_document", {});
  check("read_design_document.document carries context",
    jdoc.document?.context?.terrainName === "QA-Ctx",
    JSON.stringify(jdoc.document?.context));
  const reloaded = await a.call("load_design_document", { document: jdoc.document, commit: true });
  check("load reports what it was designed against",
    reloaded.designedAgainstContext?.terrainName === "QA-Ctx",
    JSON.stringify(reloaded.designedAgainstContext));
  const reshared = await a.call("read_design_document", {});
  check("re-sharing does not drop it",
    reshared.document?.context?.terrainName === "QA-Ctx",
    JSON.stringify(reshared.document?.context));

  console.log("\n=== F019: re-importing clears the notice ===");
  await a.importXml(terrainXml("QA-Ctx", 900), true);
  await sleep(600);
  const cleared = await a.ev(`!document.getElementById('contextMissing')`);
  check("the notice goes when the ground is back", cleared === true, `still shown: ${!cleared}`);

  // F019-1 and F019-2: the context that arrives with a loaded document must be
  // PERSISTED with that transaction and UNDONE with it. The immediate re-share
  // check catches neither -- one needs a reload, the other needs an undo.
  // ⚠ The warning only fires for context that is MISSING. Loading a document
  // that names ground which is currently loaded correctly shows nothing, so
  // both arms below establish a DIFFERENT baseline first and check that the
  // load replaces it. That is what isolates the JSON path from the autosave one.
  console.log("\n=== F019-1: a JSON load's context survives a reload ===");
  await a.importXml(terrainXml("QA-Ctx-A", 910), true);
  const docA = await a.call("read_design_document", {});
  check("document A carries context A", docA.document?.context?.terrainName === "QA-Ctx-A",
    JSON.stringify(docA.document?.context));

  await a.importXml(terrainXml("QA-Ctx-B", 920), true);
  const docB = await a.call("read_design_document", {});
  check("document B carries context B", docB.document?.context?.terrainName === "QA-Ctx-B",
    JSON.stringify(docB.document?.context));

  // Reload: no ground loaded, so the baseline warning names B.
  await a.cdp("Page.reload", { ignoreCache: false });
  await sleep(4500);
  const baseB = await a.ev(`(document.getElementById('contextMissing')||{}).textContent||""`);
  check("baseline warning names B", /QA-Ctx-B/.test(String(baseB)),
    String(baseB).slice(0, 58) || "(none)");

  await a.call("load_design_document", { document: docA.document, commit: true });
  await sleep(400);
  const swapped = await a.ev(`(document.getElementById('contextMissing')||{}).textContent||""`);
  check("the JSON load replaces it with A",
    /QA-Ctx-A/.test(String(swapped)) && !/QA-Ctx-B/.test(String(swapped)),
    String(swapped).slice(0, 58) || "(none)");

  await a.cdp("Page.reload", { ignoreCache: false });
  await sleep(4500);
  const warnAfter = await a.ev(`(document.getElementById('contextMissing')||{}).textContent||""`);
  check("it STILL names A after a reload",
    /QA-Ctx-A/.test(String(warnAfter)) && !/QA-Ctx-B/.test(String(warnAfter)),
    String(warnAfter).slice(0, 58) || "(none)");
  const docAfter = await a.call("read_design_document", {});
  check("and the document still carries it",
    docAfter.document?.context?.terrainName === "QA-Ctx-A",
    JSON.stringify(docAfter.document?.context));

  console.log("\n=== F019-2: undo takes the loaded context back with it ===");
  // State: missing A. Load B over it, then undo and expect A back.
  await a.call("load_design_document", { document: docB.document, commit: true });
  await sleep(400);
  const loadedA = await a.ev(`(document.getElementById('contextMissing')||{}).textContent||""`);
  check("loading B replaces the warning with B",
    /QA-Ctx-B/.test(String(loadedA)) && !/QA-Ctx-A/.test(String(loadedA)),
    String(loadedA).slice(0, 58) || "(none)");

  const undoLoad2 = await a.call("undo_last_change", {});
  check("undo succeeded", undoLoad2.undone === true, undoLoad2.code ?? "");
  const restoredWarn = await a.ev(`(document.getElementById('contextMissing')||{}).textContent||""`);
  check("the warning goes back to A, not B",
    /QA-Ctx-A/.test(String(restoredWarn)) && !/QA-Ctx-B/.test(String(restoredWarn)),
    String(restoredWarn).slice(0, 58) || "(none)");
  const docRestored = await a.call("read_design_document", {});
  check("and the persisted document agrees",
    docRestored.document?.context?.terrainName === "QA-Ctx-A",
    JSON.stringify(docRestored.document?.context));

  console.log("\n=== F019: a preview still changes nothing ===");
  const warnPre = await a.ev(`(document.getElementById('contextMissing')||{}).textContent||""`);
  await a.call("load_design_document", { document: docA.document, commit: false });
  await sleep(300);
  const warnPost = await a.ev(`(document.getElementById('contextMissing')||{}).textContent||""`);
  check("preview leaves the warning alone", warnPost === warnPre,
    String(warnPost).slice(0, 40));

  console.log("\n=== F025: the provenance text does not grow on every open ===");
  await a.ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/confirm/i.test(x.textContent)); if(b) b.click(); return true; })()`);
  await sleep(600);
  await a.call("set_project_setup", { name: "QA-Provenance-Probe", commit: true });
  const firstPending = await a.call("read_pending_changes", {});
  check("one pending entry to start", firstPending.pendingCount === 1,
    `${firstPending.pendingCount}`);

  // Reload three times -- QA saw the label appended once per open.
  for (const round of [1, 2, 3]) {
    await a.cdp("Page.reload", { ignoreCache: false });
    await sleep(4500);
    const p = await a.call("read_pending_changes", {});
    const text = String(p.pending?.[0]?.description ?? "");
    const repeats = (text.match(/inherited/gi) || []).length;
    check(`reload ${round}: the origin label appears at most once`, repeats <= 1,
      `${repeats} occurrences: ${text.slice(0, 88)}`);
    check(`reload ${round}: the base description is intact`,
      /project setup/i.test(text), text.slice(0, 60));
  }

  const doc3 = await a.call("read_design_document", {});
  const carried = (doc3.document?.unconfirmed ?? []).join(" | ");
  check("the DOCUMENT carries canonical text, with no label",
    carried.length > 0 && !/inherited/i.test(carried), carried.slice(0, 88));

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
  a.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
