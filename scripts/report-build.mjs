/**
 * Identify the build behind a running page, through the tool surface itself.
 *
 * Independent QA on 2026-08-31 recorded "Served code commit/build ID:
 * unknown/not exposed by the tool surface" and fell back to hashing the tool
 * catalogue. That fingerprints the CONTRACT, not the binary: two builds with
 * identical tool shapes hash the same, so a green result could not be attributed
 * to a commit. read_design now carries a build block; this prints it, next to
 * the catalogue hash so old and new evidence line up.
 *
 * Usage:
 *   node scripts/report-build.mjs <dist-dir>          # a local build
 *   node scripts/report-build.mjs https://host/       # a deployed one
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TARGET = process.argv[2];
if (!TARGET) {
  console.log("usage: node scripts/report-build.mjs <dist-dir | url>");
  process.exit(2);
}
const isUrl = /^https?:\/\//i.test(TARGET);
const WEB = Number(process.argv[3] || 8265);
const CDP = 9475;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json" };

let server;
if (!isUrl) {
  server = createServer((req, res) => {
    let u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/") u = "/index.html";
    const p = join(TARGET, normalize(u).replace(/^(\.\.[/\\])+/, ""));
    if (!existsSync(p) || !statSync(p).isFile()) return void res.writeHead(404).end("nf");
    const b = readFileSync(p);
    res.writeHead(200, { "Content-Type": MIME[extname(p).toLowerCase()] || "application/octet-stream", "Content-Length": b.length }).end(b);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sock, chrome, profile, id = 0;
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

try {
  const url = isUrl ? TARGET : `http://127.0.0.1:${WEB}/`;
  if (server) await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "build-"));
  chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--headless=new",
    "--window-size=1200,800", "--enable-features=WebMCPTesting", url], { stdio: ["ignore","pipe","pipe"] });
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(200); }
  await sleep(4500);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith(isUrl ? TARGET.replace(/\/$/, "") : `http://127.0.0.1:${WEB}`));
  if (!page) throw new Error("no page at " + url);
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r, {once:true}); sock.addEventListener("error", j, {once:true}); });

  const catalogue = await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    return JSON.stringify(tools.map(t => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations,
    })));
  })()`);
  const design = JSON.parse(await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === "read_design");
    const raw = await mc.executeTool(t, JSON.stringify({}));
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return o.content[0].text;
  })()`));

  const tools = JSON.parse(catalogue);
  const build = design.build ?? { commit: "unknown", builtAt: "unknown" };
  console.log("target            ", url);
  console.log("build commit      ", build.commit);
  console.log("built at (UTC)    ", build.builtAt);
  console.log("tool count        ", tools.length);
  console.log("tool-catalogue sha", createHash("sha256").update(catalogue).digest("hex"));
  console.log("catalogue bytes   ", Buffer.byteLength(catalogue, "utf8"));
  if (build.commit === "unknown") {
    console.log("\n⚠ This build predates the build stamp, or was built outside a git checkout.");
  } else if (build.commit.endsWith("-dirty")) {
    console.log("\n⚠ Built from a tree with uncommitted changes: it is NOT that commit.");
  }
  sock.close();
} catch (e) { console.log("ERROR: " + e.message); process.exitCode = 1; }
finally { if (chrome) chrome.kill(); if (server) server.close(); await sleep(300); if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} } }
