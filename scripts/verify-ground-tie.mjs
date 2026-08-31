/**
 * Does the road actually tie to the ground, or does it only LOOK like it does?
 *
 * A road drawn on terrain looks right whether or not the sampling is correct, so
 * this checks the wiring three ways rather than trusting the picture:
 *
 *   1. correlation between the ground under the alignment and the design profile
 *      -- a profile authored on that ground must track it; noise means the wrong place
 *   2. a deliberately n/e-SWAPPED control read, which must fall entirely off the survey
 *   3. cut and fill against the app's own build path, station-derivation included
 *
 * Usage: npx tsx scripts/verify-ground-tie.mjs <landxml-with-alignment-and-surface>
 */
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
globalThis.DOMParser = new Window().DOMParser;
const { parseLandXML } = await import("../src/importers/landxml.ts");
const { TinSampler } = await import("../src/kernel/terrain.ts");
const { tryBuild } = await import("../src/studio/webmcp-refusals.ts");
const { computeHorizontal } = await import("../src/kernel/horizontal.ts");
const { computeVertical } = await import("../src/kernel/vertical.ts");
const { sampleAlignment } = await import("../src/kernel/sample.ts");

const r = parseLandXML(readFileSync(process.argv[2], "utf8"));
const a = r.alignments[0], tin = r.surfaces[0];
const s = new TinSampler(tin);

// Build through the SAME path the app uses, so stations are derived identically.
const form = {
  name: a.name, beginStation: a.beginStation, startE: a.start.e, startN: a.start.n,
  startAzimuthDeg: a.startAzimuthDeg,
  elements: a.elements.map(el => el.type === "tangent"
    ? { kind: "tangent", length: String(el.length) }
    : { kind: "arc", radius: String(el.radius), deltaDeg: String(el.deltaDeg), direction: el.direction }),
  pvis: a.pvis.map(v => ({ station: String(v.station), elevation: String(v.elevation),
    ...(v.curveLength !== undefined ? { curveLength: String(v.curveLength) } : {}) })),
  templates: [{ name: "t", left: [{ name: "lane", width: "12", slopePercent: "-2" }],
                right: [{ name: "lane", width: "12", slopePercent: "-2" }] }],
  drops: [{ template: "t", toStation: "" }],
};
const built = tryBuild(form);
if (built.refused) { console.log("REFUSED", built.code, built.detail); process.exit(1); }
const d = built.design;
const h = computeHorizontal(d.alignment), v = computeVertical(d.profile);

const N = 120, pts = sampleAlignment(d.alignment, N), rows = [];
for (let i = 0; i <= N; i++) {
  const sta = d.alignment.beginStation + (h.length * i) / N;
  const g = s.elevationAt(pts[i].n, pts[i].e);
  if (g !== undefined) rows.push({ sta, g, d: v.elevationAt(sta) });
}
const mean = xs => xs.reduce((t,x)=>t+x,0)/xs.length;
const gs = rows.map(x=>x.g), ds = rows.map(x=>x.d), mg = mean(gs), md = mean(ds);
let num=0, dg=0, dd=0;
for (let i=0;i<rows.length;i++){const x=gs[i]-mg,y=ds[i]-md;num+=x*y;dg+=x*x;dd+=y*y;}
const corr = num/Math.sqrt(dg*dd);

console.log(`on-surface: ${rows.length}/${N+1}`);
console.log(`ground ${Math.min(...gs).toFixed(1)}..${Math.max(...gs).toFixed(1)} ft   design ${Math.min(...ds).toFixed(1)}..${Math.max(...ds).toFixed(1)} ft`);
console.log(`\nPearson r(ground, design) = ${corr.toFixed(4)}`);
console.log(corr > 0.9 ? "  => the design profile TRACKS the ground under it. Sampling the right place."
  : corr > 0.5 ? "  => partial correlation. Suspicious." : "  => UNCORRELATED. Wrong place.");

const swapped = [];
for (let i=0;i<=N;i++){ const g = s.elevationAt(pts[i].e, pts[i].n); if (g!==undefined) swapped.push(g); }
console.log(`\ncontrol: sampling with n/e swapped -> ${swapped.length}/${N+1} land on the surface`);
console.log(swapped.length===0 ? "  => a swapped read falls entirely off the survey. The order in use is the only one that works."
  : "  => a swap also lands; extent alone does not prove the order.");

const diffs = rows.map(x=>x.d-x.g);
console.log(`\ncut/fill: mean ${mean(diffs).toFixed(2)} ft, max fill ${Math.max(...diffs).toFixed(2)}, max cut ${Math.min(...diffs).toFixed(2)}`);
