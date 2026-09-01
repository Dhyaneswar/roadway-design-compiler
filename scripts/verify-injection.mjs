/**
 * An imported name never becomes markup, proved in a real browser.
 *
 * Independent QA imported a surface whose name contained an encoded
 * `<em id="qaLegendInjection">` and watched it become a real DOM element in the
 * 3D legend. A parser test cannot prove that is fixed -- the parser was never
 * the problem, the DOM sink was -- so this drives the actual page and asks the
 * document whether the element exists.
 *
 * Usage: node scripts/verify-injection.mjs <dist> [port]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const [DIST, PORT] = process.argv.slice(2);
const WEB = Number(PORT || 8271);
const CDP = 9481;
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
/**
 * `detail` is shown on FAILURE only.
 *
 * It used to print on both, so a passing check could read
 * "PASS ... value mismatched" -- the explanation of the failure that did not
 * happen. A verdict line that contradicts its own verdict is worse than a bare
 * one. Pass `always` for a measured value worth seeing either way.
 */
function check(label, ok, detail, always) {
  const shown = ok ? always : (detail ?? always);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${shown ? "  -- " + shown : ""}`);
  if (!ok) failures += 1;
}

// A surface, a section surface and a point code, each named to inject.
const HOSTILE = `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Imperial linearUnit="foot" areaUnit="squareFoot" volumeUnit="cubicFeet"
    angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>
  <Surfaces>
    <Surface name="&lt;em id=qaSurfaceInjection&gt;g&lt;/em&gt;">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">1349000 2199000 800</P>
          <P id="2">1352000 2199000 800</P>
          <P id="3">1349000 2202000 800</P>
        </Pnts>
        <Faces><F>1 2 3</F></Faces>
      </Definition>
    </Surface>
  </Surfaces>
  <CrossSects>
    <CrossSect sta="1000">
      <DesignCrossSectSurf name="&lt;em id=qaSectionInjection&gt;s&lt;/em&gt;" side="right">
        <CrossSectPnt code="&lt;em id=qaCodeInjection&gt;c&lt;/em&gt;">-12 100</CrossSectPnt>
        <CrossSectPnt code="&lt;em id=qaCodeInjection2&gt;c&lt;/em&gt;">12 100</CrossSectPnt>
      </DesignCrossSectSurf>
    </CrossSect>
  </CrossSects>
</LandXML>`;

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "inj-"));
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

  console.log("=== import a file whose names are markup ===");
  await cdp("Runtime.evaluate", { expression: `window.__x = ${JSON.stringify(HOSTILE)}; "ok"` });
  const imported = JSON.parse(await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === "import_landxml");
    const raw = await mc.executeTool(t, JSON.stringify({ xml: window.__x, commit: true }));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return o.content[0].text;
  })()`));
  check("the file imported", imported.committed === true, imported.code ?? "");

  // Open the 3D view so the legend is actually built.
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='3D corridor'); if(b) b.click(); return true; })()`);
  await sleep(3500);

  console.log("\n=== did any of it become a DOM element? ===");
  for (const id of ["qaSurfaceInjection", "qaSectionInjection", "qaCodeInjection",
                    "qaCodeInjection2"]) {
    const present = await ev(`!!document.getElementById(${JSON.stringify(id)})`);
    check(`${id} is NOT an element`, present === false, present ? "INJECTED" : "inert");
  }

  console.log("\n=== but the name is still shown, as text ===");
  const legendText = await ev(`(document.getElementById('legend3d')||{}).textContent||""`);
  check("the legend shows the raw name",
    /qaSurfaceInjection|qaSectionInjection/.test(String(legendText)),
    "(not shown at all)", String(legendText).slice(0, 76));
  const legendHtml = await ev(`(document.getElementById('legend3d')||{}).innerHTML||""`);
  check("and it is escaped in the markup", !/<em /i.test(String(legendHtml)),
    /<em /i.test(String(legendHtml)) ? "raw <em> present" : "escaped");

  console.log("\n=== the status line takes the same treatment ===");
  const statusHtml = await ev(`(document.getElementById('status')||{}).innerHTML||""`);
  check("no injected element in the status line", !/<em /i.test(String(statusHtml)),
    String(statusHtml).slice(0, 60));

  console.log("\n=== the authored pavement stack is drawn and legended ===");
  const callTool = async (tool, args) => JSON.parse(await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === ${JSON.stringify(tool)});
    if (!t) return JSON.stringify({ missing: ${JSON.stringify(tool)} });
    const raw = await mc.executeTool(t, JSON.stringify(${JSON.stringify(args)}));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return o.content[0].text;
  })()`));

  const beforeLegend = String(await ev(`(document.getElementById('legend3d')||{}).textContent||""`));
  const set = await callTool("set_pavement_layers", {
    template: "2-lane",
    layers: [
      { name: "surface", thicknessIn: 4, material: "asphalt concrete" },
      { name: "base", thicknessIn: 8 },
      { name: "subbase", thicknessIn: 12, material: "graded aggregate" },
    ],
    commit: true,
  });
  check("the stack committed", set.committed === true, set.code ?? set.detail ?? "");
  check("it totals 24 in", set.totalThicknessIn === 24, String(set.totalThicknessIn));
  await sleep(2500);

  const legend = String(await ev(`(document.getElementById('legend3d')||{}).textContent||""`));
  for (const [name, inches] of [["surface", 4], ["base", 8], ["subbase", 12]]) {
    check(`the legend shows ${name} at ${inches} in`,
      legend.includes(`pavement: ${name} ${inches}"`),
      legend.includes(name) ? "name present, value mismatched" : "absent",
      `pavement: ${name} ${inches}"`);
  }
  check("the legend grew when the stack was added", legend.length > beforeLegend.length,
    `${beforeLegend.length} -> ${legend.length} chars`);
  check("no engineering claim in the legend",
    !/recommend|adequate|structural number/i.test(legend));

  const read = await callTool("read_pavement_layers", {});
  const row = (read.templates || []).find((t) => t.template === "2-lane");
  check("read_pavement_layers returns the exact authored values",
    JSON.stringify(row?.layers?.map((L) => L.thicknessIn)) === "[4,8,12]",
    JSON.stringify(row?.layers?.map((L) => L.thicknessIn)));
  check("and says nothing was calculated",
    /no structural adequacy was calculated/i.test(String(read.note)),
    String(read.note).slice(0, 58));

  const undone = await callTool("undo_last_change", {});
  await sleep(2000);
  const afterUndo = String(await ev(`(document.getElementById('legend3d')||{}).textContent||""`));
  check("undo removes the stack from the view",
    undone.undone === true && !afterUndo.includes("pavement: surface"),
    undone.undone === true ? "still shown in the legend" : (undone.code ?? "undo refused"),
    "gone");

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
