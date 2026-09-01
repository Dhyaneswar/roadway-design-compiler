/**
 * An authored name must survive the WHOLE path as text, not as markup.
 *
 * F030. `tests/export-name-escaping.test.ts` proves the pure function. This
 * proves the path an engineer actually walks: an agent sets the project name
 * through set_project_setup, a person confirms it in the Studio, and the
 * exported file is parsed as XML by the browser that produced it.
 *
 * ⚠ A unit test on toLandXML could pass while the deliverable is broken -- the
 * name reaches the exporter through the form, the ledger and the confirmation
 * gate, and any of those could re-encode or decode it on the way.
 *
 *   node scripts/verify-export-name.mjs studio/dist
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { createServer } from "node:http";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DIST = process.argv[2] ?? "studio/dist";
const WEB = 8317, CDP = 9499;

const server = createServer((req, res) => {
  let u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/") u = "/index.html";
  const p = join(DIST, normalize(u).replace(/^(\.\.[/\\])+/, ""));
  if (!existsSync(p) || !statSync(p).isFile()) return void res.writeHead(404).end("nf");
  const b = readFileSync(p);
  res.writeHead(200, {
    "Content-Type": extname(p).toLowerCase() === ".js"
      ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
    "Content-Length": b.length,
  }).end(b);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sock, chrome, profile, id = 0;
function cdp(m, p = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => rej(new Error(m + " timeout")), 60000);
    const h = (e) => {
      const x = JSON.parse(e.data);
      if (x.id !== i) return;
      clearTimeout(t); sock.removeEventListener("message", h);
      if (x.error) return rej(new Error(x.error.message));
      res(x.result);
    };
    sock.addEventListener("message", h);
    sock.send(JSON.stringify({ id: i, method: m, params: p }));
  });
}
const ev = async (e) =>
  (await cdp("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))
    ?.result?.value;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
};

/** Call a WebMCP tool the way an agent does: the tool object and a JSON STRING. */
const call = async (tool, args) => {
  const txt = await ev(`(async () => {
    const mc = document.modelContext ?? navigator.modelContext;
    const tools = await mc.getTools();
    const t = tools.find(x => x.name === ${JSON.stringify(tool)});
    if (!t) return JSON.stringify({ error: true, detail: "no such tool" });
    const raw = await mc.executeTool(t, ${JSON.stringify(JSON.stringify(args))});
    let o = raw; if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return o.content[0].text;
  })()`);
  try { return JSON.parse(txt); } catch { return { parseError: txt }; }
};

// The exact sentinel from the QA finding: an ampersand, quotes, angle brackets.
const NASTY = 'A & B "quoted" <road>';

try {
  await new Promise((r) => server.listen(WEB, "127.0.0.1", r));
  profile = mkdtempSync(join(tmpdir(), "expname-"));
  chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--headless=new",
    "--enable-features=WebMCPTesting", `http://127.0.0.1:${WEB}/`,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {}
    await sleep(200);
  }
  await sleep(5000);
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${WEB}`));
  if (!page) throw new Error("studio page never appeared");
  sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    sock.addEventListener("open", r, { once: true });
    sock.addEventListener("error", j, { once: true });
  });

  console.log("\nan agent sets a name full of XML metacharacters");
  const set = await call("set_project_setup", { name: NASTY, commit: true });
  check("accepted the name", !set.refused && !set.error, JSON.stringify(set).slice(0, 110));
  check("the name reached the form",
    (await ev(`document.getElementById('name').value`)) === NASTY,
    JSON.stringify(await ev(`document.getElementById('name').value`)));

  console.log("\nthe seal still holds before a person confirms");
  const early = await call("export_landxml", {});
  check("export refuses while unconfirmed", early.refused === true &&
    early.code === "AwaitingEngineerConfirmation", JSON.stringify(early.code));

  console.log("\na person confirms, then exports");
  const clicked = await ev(`(() => {
    const b = document.querySelector('.pending-confirm');
    if (!b) return "no confirm button";
    b.click(); return "clicked";
  })()`);
  check("found and clicked the engineer's confirmation", clicked === "clicked", String(clicked));

  const out = await call("export_landxml", {});
  check("export succeeded", !out.refused && !out.error, JSON.stringify(out).slice(0, 110));

  const xml = out.landxml ?? out.xml ?? out.content ?? "";
  check("returned a LandXML document", typeof xml === "string" && xml.includes("<LandXML"),
    `${typeof xml}, ${String(xml).length} chars`);

  console.log("\nthe exported file is parsed by the browser that produced it");
  const verdict = await ev(`(() => {
    const xml = ${JSON.stringify(String(xml))};
    const d = new DOMParser().parseFromString(xml, "text/xml");
    const err = d.getElementsByTagName("parsererror").length;
    const nameOf = (tag) => {
      const el = d.getElementsByTagName(tag)[0];
      return el ? el.getAttribute("name") : null;
    };
    return JSON.stringify({
      parserError: err,
      root: d.documentElement && d.documentElement.nodeName,
      project: nameOf("Project"),
      alignment: nameOf("Alignment"),
      profile: nameOf("Profile"),
      profAlign: nameOf("ProfAlign"),
      alignmentCount: d.getElementsByTagName("Alignment").length,
    });
  })()`);
  const v = JSON.parse(verdict);
  check("no parser error", v.parserError === 0, String(v.parserError));
  check("root is LandXML", v.root === "LandXML", String(v.root));
  check("Project name round-trips exactly", v.project === NASTY, JSON.stringify(v.project));
  check("Alignment name round-trips exactly", v.alignment === NASTY, JSON.stringify(v.alignment));
  check("Profile name round-trips exactly", v.profile === NASTY, JSON.stringify(v.profile));
  check("ProfAlign name round-trips exactly", v.profAlign === `${NASTY}-profile`,
    JSON.stringify(v.profAlign));
  check("the name did not forge a second alignment", v.alignmentCount === 1,
    String(v.alignmentCount));

  /**
   * F034. A character XML 1.0 cannot represent must be refused BEFORE it can
   * reach a "successful" export. There is no escape for U+0001 -- `&#1;` is
   * itself illegal -- so the only alternatives are refusing or silently
   * rewriting the author's name, and rewriting a road name is not ours to do.
   */
  console.log("\na control character XML cannot carry is refused, not exported");
  const nameBefore = await ev(`document.getElementById('name').value`);
  const ctrl = await call("set_project_setup", { name: "A\u0001B", commit: true });
  check("refused", ctrl.refused === true || ctrl.error === true,
    JSON.stringify(ctrl).slice(0, 140));
  check("names the code point", /U\+0001/.test(JSON.stringify(ctrl)),
    String(ctrl.detail ?? "").slice(0, 120));
  check("the design was not mutated",
    (await ev(`document.getElementById('name').value`)) === nameBefore);

  /**
   * Tab, LF and CR are legal XML characters, so they are ACCEPTED -- but an XML
   * parser normalises each to a space inside an attribute value, so the exporter
   * writes them as numeric character references to make them round-trip.
   */
  console.log("\na tab is legal, so it is kept -- and must survive the round trip");
  const tabbed = await call("set_project_setup", { name: "A\tB road", commit: true });
  check("accepted", !tabbed.refused && !tabbed.error, JSON.stringify(tabbed).slice(0, 90));
  await ev(`document.querySelector('.pending-confirm')?.click()`);
  const tabOut = await call("export_landxml", {});
  const tabXml = String(tabOut.landxml ?? "");
  check("written as a character reference, not a literal tab", tabXml.includes("&#9;"));
  const tabBack = await ev(`(() => {
    const d = new DOMParser().parseFromString(${JSON.stringify(tabXml)}, "text/xml");
    if (d.getElementsByTagName("parsererror").length) return "PARSER ERROR";
    return d.getElementsByTagName("Project")[0].getAttribute("name");
  })()`);
  check("the tab survives attribute normalisation", tabBack === "A\tB road",
    JSON.stringify(tabBack));

  /**
   * F035. A single-line input cannot hold a line feed, so the write is lossy.
   * The tool must say so AND leave nothing behind -- not the mangled name, and
   * not a pending change asking an engineer to confirm work it just disowned.
   */
  console.log("\na newline the form cannot hold is refused AND rolled back");
  const preName = await ev(`document.getElementById('name').value`);
  const prePending = await ev(`document.querySelectorAll('.pending-list li').length`);
  const lossy = await call("set_project_setup", { name: "A\nB", commit: true });
  check("reported a problem", lossy.error === true || lossy.refused === true,
    JSON.stringify(lossy).slice(0, 140));
  check("says it was rolled back", lossy.rolledBack !== false, String(lossy.rolledBack));
  check("the name on screen is unchanged",
    (await ev(`document.getElementById('name').value`)) === preName,
    JSON.stringify(await ev(`document.getElementById('name').value`)));
  check("no pending change was left behind",
    (await ev(`document.querySelectorAll('.pending-list li').length`)) === prePending,
    `${prePending} -> ${await ev(`document.querySelectorAll('.pending-list li').length`)}`);

  sock.close();
  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (e) {
  console.log("ERROR: " + e.message);
  process.exitCode = 1;
} finally {
  if (chrome) chrome.kill();
  server.close();
  await sleep(300);
  if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} }
}
