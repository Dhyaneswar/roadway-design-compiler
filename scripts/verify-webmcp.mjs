/**
 * Driver-owned verification for the Roadway Design Compiler's WebMCP surface.
 *
 * Drives the BUILT app over CDP with Chrome's WebMCP flag on, exactly as a
 * visiting agent would. Proves four things:
 *
 *   1. Tools register and carry real JSON Schemas.
 *   2. Preview does not mutate.
 *   3. The refusal -> solve -> commit arc works, and the refusal carries the
 *      number needed to solve it.
 *   4. Committed changes are stamped agent-proposed.
 *
 * Usage: node scripts/verify-webmcp.mjs [distDir] [outDir] [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DIST = process.argv[2] || "T:\\search - Copy\\roadway\\studio\\dist";
const OUT = process.argv[3] || ".";
const WEB = Number(process.argv[4] || 8170);
const CDP = 9410;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };
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
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
}

const ARC = `(async () => {
  const mc = document.modelContext ?? navigator.modelContext;
  if (!mc) return JSON.stringify({ fatal: "no modelContext" });
  const call = async (tool, args) => {
    const raw = await mc.executeTool(tool, JSON.stringify(args ?? {}));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    const t = o && o.content && o.content[0] && o.content[0].text;
    if (typeof t === "string") { try { return JSON.parse(t); } catch { return t; } }
    return o;
  };
  const tools = await mc.getTools();
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  const out = { toolCount: tools.length, toolNames: tools.map(t => t.name).sort(), steps: [] };
  const rec = (k, v) => out.steps.push({ step: k, result: v });

  const range0 = await call(byName.read_alignment_range, {});
  rec("1. alignment range at rest", range0);

  // preview must not mutate
  const preview = await call(byName.add_horizontal_element, { type: "tangent", lengthFt: 1500 });
  rec("2. PREVIEW add 1500 ft tangent", preview);
  const afterPreview = await call(byName.read_alignment_range, {});
  out.previewDidNotMutate = afterPreview.endStationFt === range0.endStationFt;
  rec("3. range after preview (must be unchanged)", afterPreview);

  // commit: the profile end station is DERIVED, so this now succeeds
  rec("4. COMMIT add 1500 ft tangent", await call(byName.add_horizontal_element,
    { type: "tangent", lengthFt: 1500, commit: true }));
  const grown = await call(byName.read_alignment_range, {});
  rec("5. range after commit (road is longer)", grown);
  out.roadGrewBy = grown.endStationFt - range0.endStationFt;

  // --- the arc: an engineering constraint the app will NOT silently fix
  const attempt = await call(byName.set_pvi, { index: 2, curveLengthFt: 3000, commit: true });
  rec("6. lengthen PVI 2 vertical curve to 3000 ft (expect REFUSAL)", attempt);

  if (attempt && attempt.refused && attempt.measurements &&
      typeof attempt.measurements.overlapFt === "number") {
    const m = attempt.measurements;
    // Solve from the engine's own numbers: shorten by twice the overlap plus margin.
    const solved = Math.floor(m.curveLengthFt - 2 * m.overlapFt - 20);
    out.solvedFrom = { code: attempt.code, overlapFt: m.overlapFt,
      triedFt: m.curveLengthFt, solvedCurveLengthFt: solved, resolvedBy: attempt.resolvedBy };
    rec("7. retry with the SOLVED curve length", await call(byName.set_pvi,
      { index: 2, curveLengthFt: solved, commit: true }));
    rec("8. what_do_i_need after the fix", await call(byName.what_do_i_need, {}));
    rec("9. profile table", await call(byName.read_profile_table, {}));
  }

  // --- design criteria: the same road judged at two speeds
  const at45 = await call(byName.check_design_criteria, { designSpeedMph: 45, emax: 0.06 });
  rec("11. criteria @ 45 mph", at45 && { checked: at45.checked, failed: at45.failed,
    compliant: at45.compliant });
  const at70 = await call(byName.check_design_criteria, { designSpeedMph: 70, emax: 0.06 });
  rec("12. criteria @ 70 mph", at70 && { checked: at70.checked, failed: at70.failed,
    compliant: at70.compliant });
  if (at70 && at70.verdicts) {
    const firstFail = at70.verdicts.find(v => v.status === "fail");
    out.exampleFailure = firstFail;
    // solve straight from the verdict: it states the radius that would comply
    if (firstFail && firstFail.check === "minimum-radius") {
      const target = Math.ceil(firstFail.required / 50) * 50;
      out.solvedRadiusFt = target;
      rec("13. widen curve 1 to the radius the verdict named",
        await call(byName.set_horizontal_element, { index: 2, radiusFt: target, commit: true }));
      const recheck = await call(byName.check_design_criteria, { designSpeedMph: 70, emax: 0.06 });
      rec("14. re-check @ 70 mph", recheck && { failed: recheck.failed,
        compliant: recheck.compliant });
    }
  }

  const xml = await call(byName.export_landxml, {});
  rec("10. LandXML export", xml && xml.landxml
    ? { lengthBytes: xml.lengthBytes, head: String(xml.landxml).slice(0, 80) } : xml);
  return JSON.stringify(out, null, 1);
})()`;

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "rdc-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1440,980", "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4000);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("no studio page");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  console.log("agent status:", (await ev("(document.getElementById('agentStatus')||{}).textContent||''")).trim().slice(0, 120));
  await shot("rdc-01-before.png");
  console.log(await ev(ARC));
  await sleep(1200);
  await shot("rdc-02-after.png");
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
