// Studio v0 — DOM glue only. All logic lives in tested modules:
// form-to-design (mapping/validation), kernel (geometry), exporters (LandXML).

import { alignmentRangeFromForm, formToDesign, type FormDropRow, type FormElementRow, type FormPviRow, type FormTemplateRow, type StudioForm } from "../src/studio/form-to-design";
import { sectionOffsets } from "../src/kernel/template-section";
import { computeHorizontal } from "../src/kernel/horizontal";
import { computeVertical } from "../src/kernel/vertical";
import { toLandXML } from "../src/exporters/landxml";
import { toStakingCsv } from "../src/exporters/staking";
import { registerWebMcp } from "../src/studio/webmcp-bridge";
import { AgentChangeLedger } from "../src/studio/agent-changes";
import { AgentActivityLog, classifyResult } from "../src/studio/agent-activity";
import { AlternativeSet, evaluateAlternatives, type AlternativeInput } from "../src/studio/alternatives";
import { autosave, decodeFragment, loadAutosave, shareUrl } from "../src/studio/design-document";
import { parseLandXML } from "../src/importers/landxml";
import type { DesignSectionSurface } from "../src/importers/design-sections";
import type { PlanFeatureSet } from "../src/importers/plan-features";
import { TinSampler, sampleGround, summariseEarthwork, type Tin } from "../src/kernel/terrain";
import { sampleAlignment as sampleAlign } from "../src/kernel/sample";
import { transitionFor } from "../src/kernel/superelevation";
import { sampleAlignment, sampleProfile } from "../src/kernel/sample";
import { azimuthToBearing, degreesToDms } from "../src/util/angle";
import { createViewer, type LegendEntry, type Viewer3D } from "./viewer3d";
import type { RoadDesign, SuperelevationSpec } from "../src/schema/road-design";
import type { RoadsideItem } from "../src/schema/roadside";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let elements: FormElementRow[] = [
  { kind: "tangent", length: "1200" },
  { kind: "arc", radius: "1500", deltaDeg: "45", direction: "right" },
  { kind: "tangent", length: "800" },
  { kind: "arc", radius: "2000", deltaDeg: "30", direction: "left" },
  { kind: "tangent", length: "1000" },
];
let pvis: FormPviRow[] = [
  { station: "1000", elevation: "850" },
  { station: "2500", elevation: "880", curveLength: "600" },
  { station: "4200", elevation: "846", curveLength: "800" },
  { station: "6225.29", elevation: "865.56" }, // station derived (alignment end)
];
const defaultTemplates = (): FormTemplateRow[] => [
  {
    name: "2-lane",
    left: [
      { name: "lane", width: "12", slopePercent: "-2" },
      { name: "shoulder", width: "6.5", slopePercent: "-4" },
    ],
    right: [
      { name: "lane", width: "12", slopePercent: "-2" },
      { name: "shoulder", width: "6.5", slopePercent: "-4" },
    ],
  },
];
let templates: FormTemplateRow[] = defaultTemplates();
let drops: FormDropRow[] = [{ template: "2-lane", toStation: "" }];
// Banking policy. Undefined = template cross slopes everywhere (the v0
// behaviour); set by the agent through set_superelevation.
let superelevation: SuperelevationSpec | undefined;
// Guardrail, barrier, markings and curb the engineer or an agent has placed.
let roadside: RoadsideItem[] = [];
// Everything an agent authors is held as PROPOSED until a person confirms it.
const agentLedger = new AgentChangeLedger();
// Every WebMCP tool call, recorded from inside the tool surface. A filled log
// is direct evidence the agent used our tools rather than driving the DOM.
const agentLog = new AgentActivityLog();
// Alternatives an agent has put on the table. Nothing here is applied until a
// person picks one -- choosing between defensible options is the engineer's job.
const alternatives = new AlternativeSet();
// Existing ground. Undefined until a LandXML surface is imported; the design
// works without it, it just cannot say anything about cut and fill.
let terrain: Tin | undefined;
let terrainSampler: TinSampler | undefined;
// The original designer's sections, held apart from our own corridor so the two
// can never be mistaken for each other.
let designSections: readonly DesignSectionSurface[] = [];
// The existing site, when a survey was imported.
let planFeatures: PlanFeatureSet | undefined;

function setTerrain(tin: Tin | undefined): void {
  terrain = tin;
  terrainSampler = tin ? new TinSampler(tin) : undefined;
  viewer?.setTerrain(tin);
  refresh();
}

/**
 * Ground under the alignment, station by station.
 *
 * Sampling density is capped: a long road at a tight interval is thousands of
 * point-in-triangle tests per keystroke, and the answer does not get better.
 */
function groundProfile(design: RoadDesign, intervalFt = 50) {
  if (!terrainSampler) return undefined;
  const h = computeHorizontal(design.alignment);
  const v = computeVertical(design.profile);
  const begin = design.alignment.beginStation;
  const count = Math.min(400, Math.max(2, Math.ceil(h.length / intervalFt)));
  const pts = sampleAlign(design.alignment, count);
  return sampleGround(
    terrainSampler,
    pts.map((p, i) => {
      const station = begin + (h.length * i) / (pts.length - 1 || 1);
      return { station, n: p.n, e: p.e, designZ: v.elevationAt(station) };
    }),
  );
}

function readForm(): StudioForm {
  return {
    name: $<HTMLInputElement>("name").value,
    beginStation: Number($<HTMLInputElement>("beginStation").value),
    startE: Number($<HTMLInputElement>("startE").value),
    startN: Number($<HTMLInputElement>("startN").value),
    startAzimuthDeg: Number($<HTMLInputElement>("azimuth").value),
    elements,
    pvis,
    templates,
    drops,
    ...(superelevation ? { superelevation } : {}),
    ...(roadside.length > 0 ? { roadside } : {}),
  };
}

function fmtSta(v: number): string {
  const s = Math.floor(v / 100);
  const r = v - s * 100;
  return `${s}+${r.toFixed(2).padStart(5, "0")}`;
}

function input(value: string, on: (v: string) => void, placeholder = ""): HTMLInputElement {
  const el = document.createElement("input");
  el.value = value;
  el.placeholder = placeholder;
  el.addEventListener("input", () => { on(el.value); refresh(); });
  return el;
}

function field(labelText: string, child: HTMLElement): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "f";
  const label = document.createElement("label");
  label.textContent = labelText;
  wrap.append(label, child);
  return wrap;
}

function renderElements(): void {
  const host = $("elements");
  host.innerHTML = "";
  elements.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "row";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1);
    div.append(idx);

    const kind = document.createElement("select");
    for (const k of ["tangent", "arc", "deflection"]) {
      const o = document.createElement("option");
      o.value = k; o.textContent = k; if (row.kind === k) o.selected = true;
      kind.append(o);
    }
    kind.addEventListener("change", () => {
      elements[i] = kind.value === "tangent"
        ? { kind: "tangent", length: "1000" }
        : kind.value === "arc"
          ? { kind: "arc", radius: "1500", deltaDeg: "30", direction: "right" }
          : { kind: "deflection", deflectionDeg: "0.5", direction: "left" };
      renderElements(); refresh();
    });
    div.append(field("type", kind));

    if (row.kind === "tangent") {
      div.append(field("length (ft)", input(row.length ?? "", (v) => (row.length = v))));
    } else if (row.kind === "arc") {
      div.append(field("radius (ft)", input(row.radius ?? "", (v) => (row.radius = v))));
      div.append(field("delta (°)", input(row.deltaDeg ?? "", (v) => (row.deltaDeg = v))));
    } else {
      div.append(field("deflection (°)", input(row.deflectionDeg ?? "", (v) => (row.deflectionDeg = v))));
    }
    if (row.kind !== "tangent") {
      const dir = document.createElement("select");
      for (const d of ["right", "left"]) {
        const o = document.createElement("option");
        o.value = d; o.textContent = d; if (row.direction === d) o.selected = true;
        dir.append(o);
      }
      dir.addEventListener("change", () => { row.direction = dir.value as "left" | "right"; refresh(); });
      div.append(field("turn", dir));
    }

    const del = document.createElement("button");
    del.className = "x"; del.textContent = "✕";
    del.addEventListener("click", () => { elements.splice(i, 1); renderElements(); refresh(); });
    div.append(del);
    host.append(div);
  });
}

function renderPvis(): void {
  const host = $("pvis");
  host.innerHTML = "";
  pvis.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "row";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1);
    div.append(idx);
    // The profile is stationed BY the alignment: first/last PVI stations are
    // derived (begin / end station), not typed — like ORD's profile extents.
    const isFirst = i === 0;
    const isLast = i === pvis.length - 1;
    const staInput = input(row.station, (v) => (row.station = v));
    staInput.id = `pviSta-${i}`;
    if (isFirst || isLast) {
      staInput.disabled = true;
      staInput.classList.add("derived");
      staInput.title = isFirst
        ? "derived: alignment begin station"
        : "derived: alignment end station (begin + Σ element lengths)";
    }
    const staLabel = isFirst ? "station (= begin)" : isLast ? "station (= end)" : "station (ft)";
    div.append(field(staLabel, staInput));
    div.append(field("elevation (ft)", input(row.elevation, (v) => (row.elevation = v))));
    div.append(field("VC length (ft)", input(row.curveLength ?? "", (v) => (row.curveLength = v), "none")));
    const del = document.createElement("button");
    del.className = "x"; del.textContent = "✕";
    del.addEventListener("click", () => { pvis.splice(i, 1); renderPvis(); refresh(); });
    div.append(del);
    host.append(div);
  });
}

// Live typical-section preview for one template card. Tolerant of half-typed
// numbers (skips unparseable segments); 4× vertical exaggeration, like a
// typical-section sheet.
function svgTemplatePreview(t: FormTemplateRow): string {
  const parse = (rows: { name: string; width: string; slopePercent: string }[]) =>
    rows
      .map((r) => ({ name: r.name, width: Number(r.width), slopePercent: Number(r.slopePercent) }))
      .filter((r) => Number.isFinite(r.width) && r.width > 0 && Number.isFinite(r.slopePercent));
  const left = sectionOffsets(parse(t.left));
  const right = sectionOffsets(parse(t.right));
  const W = 420, H = 90, EXAG = 4;
  const maxOff = Math.max(...left.map((p) => p.offset), ...right.map((p) => p.offset), 1);
  const allDz = [...left.map((p) => p.dz), ...right.map((p) => p.dz), 0];
  const minDz = Math.min(...allDz), maxDz = Math.max(...allDz);
  const span = 2 * maxOff * 1.1;
  const zSpan = Math.max((maxDz - minDz) * EXAG, 2);
  const sx = (off: number) => W / 2 + (off / span) * W;
  const sy = (dz: number) => H * 0.45 - ((dz - (minDz + maxDz) / 2) * EXAG / zSpan) * (H * 0.7);
  const pts = [
    ...left.map((p) => ({ x: sx(-p.offset), y: sy(p.dz) })).reverse(),
    { x: sx(0), y: sy(0) },
    ...right.map((p) => ({ x: sx(p.offset), y: sy(p.dz) })),
  ];
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const markers = pts
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="#d29922"/>`)
    .join("");
  const lw = left[left.length - 1]?.offset ?? 0;
  const rw = right[right.length - 1]?.offset ?? 0;
  return `<svg viewBox="0 0 ${W} ${H}">
    <line x1="${sx(0)}" y1="${(sy(0) - 18).toFixed(1)}" x2="${sx(0)}" y2="${(sy(0) + 18).toFixed(1)}" stroke="#8b949e" stroke-dasharray="3,3"/>
    <path d="${path}" fill="none" stroke="#58a6ff" stroke-width="2"/>
    ${markers}
    <text x="6" y="${H - 6}" fill="#8b949e" font-size="9" font-family="monospace">${lw.toFixed(1)} ft L</text>
    <text x="${W - 6}" y="${H - 6}" fill="#8b949e" font-size="9" font-family="monospace" text-anchor="end">${rw.toFixed(1)} ft R</text>
    <text x="${W / 2 + 4}" y="12" fill="#8b949e" font-size="9" font-family="monospace">CL — vert. exag. ${EXAG}:1</text>
  </svg>`;
}

function updateTemplatePreview(ti: number): void {
  const host = document.getElementById(`tplPrev-${ti}`);
  if (host && templates[ti]) host.innerHTML = svgTemplatePreview(templates[ti]);
}

function renderTemplates(): void {
  const host = $("templates");
  host.innerHTML = "";
  templates.forEach((t, ti) => {
    const card = document.createElement("div");
    card.className = "tpl";

    const head = document.createElement("div");
    head.className = "head";
    const nameInput = input(t.name, (v) => {
      // Keep drops pointing at the renamed template.
      const old = t.name;
      t.name = v;
      drops.forEach((d) => { if (d.template === old) d.template = v; });
      renderDrops();
    });
    head.append(field("template name", nameInput));
    const del = document.createElement("button");
    del.className = "x"; del.textContent = "✕"; del.title = "delete template";
    del.addEventListener("click", () => {
      templates.splice(ti, 1);
      const fallback = templates[0]?.name ?? "";
      drops.forEach((d) => { if (d.template === t.name) d.template = fallback; });
      renderTemplates(); renderDrops(); refresh();
    });
    head.append(del);
    card.append(head);

    for (const side of ["left", "right"] as const) {
      const label = document.createElement("div");
      label.className = "side-label";
      label.textContent = `${side} of centerline (outward)`;
      card.append(label);
      t[side].forEach((seg, si) => {
        const row = document.createElement("div");
        row.className = "seg";
        row.append(field("segment", input(seg.name, (v) => { seg.name = v; })));
        row.append(field("width (ft)", input(seg.width, (v) => { seg.width = v; updateTemplatePreview(ti); })));
        row.append(field("slope (%)", input(seg.slopePercent, (v) => { seg.slopePercent = v; updateTemplatePreview(ti); })));
        const x = document.createElement("button");
        x.className = "x"; x.textContent = "✕";
        x.addEventListener("click", () => { t[side].splice(si, 1); renderTemplates(); refresh(); });
        row.append(x);
        card.append(row);
      });
      const add = document.createElement("button");
      add.className = "add mini";
      add.textContent = `+ add ${side} segment`;
      add.addEventListener("click", () => {
        t[side].push({ name: "lane", width: "12", slopePercent: "-2" });
        renderTemplates(); refresh();
      });
      card.append(add);
    }

    const prev = document.createElement("div");
    prev.id = `tplPrev-${ti}`;
    prev.innerHTML = svgTemplatePreview(t);
    card.append(prev);
    host.append(card);
  });
}

function renderDrops(): void {
  const host = $("drops");
  host.innerHTML = "";
  drops.forEach((row, i) => {
    const div = document.createElement("div");
    div.className = "row";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(i + 1);
    div.append(idx);

    const from = document.createElement("span");
    from.className = "drop-from";
    from.id = `dropFrom-${i}`;
    from.textContent = "from —";
    div.append(from);

    const sel = document.createElement("select");
    for (const t of templates) {
      const o = document.createElement("option");
      o.value = t.name; o.textContent = t.name;
      if (row.template === t.name) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => { row.template = sel.value; refresh(); });
    div.append(field("template", sel));

    const isLast = i === drops.length - 1;
    const toInput = input(row.toStation, (v) => (row.toStation = v));
    toInput.id = `dropTo-${i}`;
    if (isLast) {
      toInput.disabled = true;
      toInput.classList.add("derived");
      toInput.title = "derived: alignment end station";
    }
    div.append(field(isLast ? "to (= end)" : "to station (ft)", toInput));

    // Taper from the previous drop's template (not meaningful on the first).
    if (i > 0) {
      const tr = input(row.transition ?? "", (v) => (row.transition = v), "none");
      tr.title = "blend from the previous template over this many feet";
      div.append(field("taper (ft)", tr));
    }

    const del = document.createElement("button");
    del.className = "x"; del.textContent = "✕";
    del.addEventListener("click", () => { drops.splice(i, 1); renderDrops(); refresh(); });
    div.append(del);
    host.append(div);
  });
}

// Walk the drop boundaries and refresh the derived "from" labels + the
// derived last "to" — same live-sync pattern as the PVI endpoints.
function syncDropStations(): void {
  if (drops.length === 0) return;
  let range: { begin: number; end: number };
  try {
    range = alignmentRangeFromForm(readForm());
  } catch {
    return;
  }
  let cursor: number | null = range.begin;
  drops.forEach((row, i) => {
    const from = document.getElementById(`dropFrom-${i}`);
    if (from) from.textContent = cursor !== null ? `from ${fmtSta(cursor)}` : "from ?";
    const isLast = i === drops.length - 1;
    if (isLast) {
      row.toStation = String(range.end);
      const toInput = document.getElementById(`dropTo-${i}`) as HTMLInputElement | null;
      if (toInput) toInput.value = range.end.toFixed(2);
    } else {
      const v = Number(row.toStation);
      cursor = Number.isFinite(v) && row.toStation.trim() !== "" ? v : null;
    }
  });
}

function svgPlanView(design: RoadDesign): string {
  const pts = sampleAlignment(design.alignment, 240);
  const h = computeHorizontal(design.alignment);
  const minE = Math.min(...pts.map((p) => p.e));
  const maxE = Math.max(...pts.map((p) => p.e));
  const minN = Math.min(...pts.map((p) => p.n));
  const maxN = Math.max(...pts.map((p) => p.n));
  const span = Math.max(maxE - minE, maxN - minN, 1);
  const pad = span * 0.08;
  const W = 460, H = 240;
  const sx = (e: number) => ((e - minE + pad) / (span + 2 * pad)) * W;
  const sy = (n: number) => H - ((n - minN + pad) / (span + 2 * pad)) * H;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.e).toFixed(1)},${sy(p.n).toFixed(1)}`).join(" ");
  // PC/PT markers from arc element reports
  let markers = "";
  for (const el of h.elements) {
    if (el.type !== "arc") continue;
    const pc = h.pointAt(el.beginStation - design.alignment.beginStation);
    const pt = h.pointAt(el.endStation - design.alignment.beginStation);
    markers += `<circle cx="${sx(pc.e).toFixed(1)}" cy="${sy(pc.n).toFixed(1)}" r="3" fill="#d29922"/>`;
    markers += `<circle cx="${sx(pt.e).toFixed(1)}" cy="${sy(pt.n).toFixed(1)}" r="3" fill="#d29922"/>`;
  }
  const begin = pts[0]!, end = pts[pts.length - 1]!;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;background:var(--panel);border:1px solid var(--line);border-radius:8px;">
    <path d="${path}" fill="none" stroke="#58a6ff" stroke-width="2.5"/>
    ${markers}
    <circle cx="${sx(begin.e).toFixed(1)}" cy="${sy(begin.n).toFixed(1)}" r="4" fill="#3fb950"/>
    <circle cx="${sx(end.e).toFixed(1)}" cy="${sy(end.n).toFixed(1)}" r="4" fill="#f85149"/>
    <text x="8" y="16" fill="#8b949e" font-size="10" font-family="monospace">N ↑ (grid)</text>
  </svg>`;
}

function svgProfileView(design: RoadDesign): string {
  const pts = sampleProfile(design.profile, 240);
  const v = computeVertical(design.profile);
  const minS = pts[0]!.station, maxS = pts[pts.length - 1]!.station;
  const elevs = pts.map((p) => p.elevation);
  const minZ = Math.min(...elevs), maxZ = Math.max(...elevs);
  const zSpan = Math.max(maxZ - minZ, 1);
  const W = 460, H = 150, padX = 8, padY = 16;
  const sx = (s: number) => padX + ((s - minS) / (maxS - minS)) * (W - 2 * padX);
  const sy = (z: number) => H - padY - ((z - minZ) / zSpan) * (H - 2 * padY);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.station).toFixed(1)},${sy(p.elevation).toFixed(1)}`).join(" ");
  let markers = "";
  for (const c of v.curves) {
    markers += `<circle cx="${sx(c.pviStation).toFixed(1)}" cy="${sy(c.pviElevation).toFixed(1)}" r="3" fill="#d29922"/>`;
  }
  for (const p of v.highLowPoints) {
    markers += `<circle cx="${sx(p.station).toFixed(1)}" cy="${sy(p.elevation).toFixed(1)}" r="3.5" fill="${p.kind === "high" ? "#3fb950" : "#f85149"}"/>`;
  }
  const exag = ((maxS - minS) / zSpan / (W / H)).toFixed(0);
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;background:var(--panel);border:1px solid var(--line);border-radius:8px;">
    <path d="${path}" fill="none" stroke="#58a6ff" stroke-width="2"/>
    ${markers}
    <text x="8" y="14" fill="#8b949e" font-size="10" font-family="monospace">profile — vert. exag. ~${exag}:1</text>
    <text x="8" y="${H - 4}" fill="#8b949e" font-size="10" font-family="monospace">${(minS / 100).toFixed(0)}+00</text>
    <text x="${W - 56}" y="${H - 4}" fill="#8b949e" font-size="10" font-family="monospace">${(maxS / 100).toFixed(0)}+${String(Math.round(maxS % 100)).padStart(2, "0")}</text>
  </svg>`;
}

// Pin first/last PVI stations to the alignment range. Full precision goes in
// the data (the schema's 0.01 ft tolerance must hold against the exact end
// station); the disabled inputs display 2 decimals.
function syncDerivedPviStations(): void {
  if (pvis.length === 0) return;
  let range: { begin: number; end: number };
  try {
    range = alignmentRangeFromForm(readForm());
  } catch {
    return; // element errors are reported by formToDesign below
  }
  pvis[0]!.station = String(range.begin);
  const first = document.getElementById("pviSta-0") as HTMLInputElement | null;
  if (first) first.value = range.begin.toFixed(2);
  if (pvis.length > 1) {
    const li = pvis.length - 1;
    pvis[li]!.station = String(range.end);
    const lastInput = document.getElementById(`pviSta-${li}`) as HTMLInputElement | null;
    if (lastInput) lastInput.value = range.end.toFixed(2);
  }
}

function refresh(): void {
  const errors = $("errors");
  const summary = $("summary");
  const status = $("status");
  syncDerivedPviStations();
  syncDropStations();
  try {
    const design = formToDesign(readForm());
    const h = computeHorizontal(design.alignment);
    const v = computeVertical(design.profile);
    errors.textContent = "";
    status.innerHTML = `<span class="ok">✓ valid design</span>`;

    // Keep the 3D view (if open/openable) in sync; its failures stay its own.
    lastDesign = design;
    renderSupSummary(design);
    autosave(readForm());
    try {
      viewer?.update(design);
    } catch (e) {
      setReadout(`corridor unavailable: ${(e as Error).message}`);
    }

    const endSta = design.alignment.beginStation + h.length;
    let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
      <div>${svgPlanView(design)}</div>
      <div>${svgProfileView(design)}</div>
    </div>`;
    html += `<div class="kpis">
      <div class="kpi"><div class="v">${h.length.toFixed(2)} ft</div><div class="k">alignment length</div></div>
      <div class="kpi"><div class="v">${fmtSta(design.alignment.beginStation)}</div><div class="k">begin station</div></div>
      <div class="kpi"><div class="v">${fmtSta(endSta)}</div><div class="k">end station</div></div>
    </div>`;

    const deflections = h.elements.filter((e) => e.type === "deflection");
    if (deflections.length) {
      html += `<h2>Angle points</h2><table><tr><th>#</th><th>PI station</th><th>deflection</th><th>bearing in</th><th>bearing out</th></tr>`;
      deflections.forEach((d, i) => {
        const a = d.deflection!;
        html += `<tr><td>${i + 1}</td><td>${fmtSta(d.beginStation)}</td>` +
          `<td>${degreesToDms(a.deflectionDeg)} ${a.direction === "left" ? "LT" : "RT"}</td>` +
          `<td>${azimuthToBearing(a.azimuthInDeg)}</td>` +
          `<td>${azimuthToBearing(a.azimuthOutDeg)}</td></tr>`;
      });
      html += `</table>`;
    }

    const arcs = h.elements.filter((e) => e.type === "arc");
    if (arcs.length) {
      html += `<h2>Curve data</h2><table><tr><th>#</th><th>PC</th><th>PT</th><th>R (ft)</th><th>Δ (°)</th><th>T (ft)</th><th>L (ft)</th><th>E (ft)</th></tr>`;
      arcs.forEach((a, i) => {
        html += `<tr><td>${i + 1}</td><td>${fmtSta(a.beginStation)}</td><td>${fmtSta(a.endStation)}</td>` +
          `<td>${a.curve!.radius.toFixed(2)}</td><td>${a.curve!.deltaDeg.toFixed(4)}</td>` +
          `<td>${a.curve!.tangentDistance.toFixed(2)}</td><td>${a.curve!.length.toFixed(2)}</td>` +
          `<td>${a.curve!.external.toFixed(2)}</td></tr>`;
      });
      html += `</table>`;
    }

    if (v.curves.length) {
      html += `<h2>Vertical curves</h2><table><tr><th>PVI</th><th>elev</th><th>L (ft)</th><th>K</th><th>PVC</th><th>PVT</th><th>g₁→g₂ (%)</th></tr>`;
      v.curves.forEach((c) => {
        html += `<tr><td>${fmtSta(c.pviStation)}</td><td>${c.pviElevation.toFixed(2)}</td>` +
          `<td>${c.length.toFixed(0)}</td><td>${Number.isFinite(c.K) ? c.K.toFixed(1) : "∞"}</td>` +
          `<td>${fmtSta(c.pvcStation)}</td><td>${fmtSta(c.pvtStation)}</td>` +
          `<td>${c.g1Percent.toFixed(2)} → ${c.g2Percent.toFixed(2)}</td></tr>`;
      });
      html += `</table>`;
    }
    if (v.highLowPoints.length) {
      html += `<h2>High / low points</h2><table><tr><th>kind</th><th>station</th><th>elevation</th></tr>`;
      v.highLowPoints.forEach((p) => {
        html += `<tr><td>${p.kind}</td><td>${fmtSta(p.station)}</td><td>${p.elevation.toFixed(2)}</td></tr>`;
      });
      html += `</table>`;
    }
    summary.innerHTML = html;
  } catch (e) {
    renderSupSummary(null);
    status.textContent = "";
    errors.textContent = (e as Error).message;
    summary.innerHTML = `<span style="color:var(--dim)">fix inputs to see the computed design</span>`;
  }
}

$("addElement").addEventListener("click", () => {
  elements.push({ kind: "tangent", length: "1000" });
  renderElements(); refresh();
});
$("addPvi").addEventListener("click", () => {
  pvis.push({ station: "", elevation: "" });
  renderPvis(); refresh();
});
$("addTemplate").addEventListener("click", () => {
  templates.push({
    name: `template-${templates.length + 1}`,
    left: [{ name: "lane", width: "12", slopePercent: "-2" }],
    right: [{ name: "lane", width: "12", slopePercent: "-2" }],
  });
  renderTemplates(); renderDrops(); refresh();
});
$("addDrop").addEventListener("click", () => {
  // The previously-last row stops being derived — seed it with the midpoint
  // of its remaining range so the form stays valid while the user types.
  try {
    const range = alignmentRangeFromForm(readForm());
    let cursor = range.begin;
    for (let i = 0; i < drops.length - 1; i++) {
      const v = Number(drops[i]!.toStation);
      if (Number.isFinite(v)) cursor = v;
    }
    const prevLast = drops[drops.length - 1];
    if (prevLast) prevLast.toStation = ((cursor + range.end) / 2).toFixed(2);
  } catch {
    // bad element inputs — the error panel already explains
  }
  drops.push({ template: templates[0]?.name ?? "", toStation: "" });
  renderDrops(); refresh();
});
function readCrs() {
  const zone = $<HTMLSelectElement>("crsZone").value;
  if (!zone) return undefined;
  const basis = $<HTMLSelectElement>("crsBasis").value as "grid" | "ground";
  return zone === "GA-East"
    ? {
        zone,
        epsgCode: 2239,
        horizontalDatum: "NAD83 / Georgia Coordinate System of 1985, East Zone",
        verticalDatum: "NAVD88",
        coordinateBasis: basis,
      }
    : {
        zone,
        epsgCode: 2240,
        horizontalDatum: "NAD83 / Georgia Coordinate System of 1985, West Zone",
        verticalDatum: "NAVD88",
        coordinateBasis: basis,
      };
}

$("download").addEventListener("click", () => {
  try {
    const design = formToDesign(readForm());
    const xml = toLandXML({ name: design.name, alignment: design.alignment, profile: design.profile, crs: readCrs() });
    const blob = new Blob([xml], { type: "application/xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${design.name.replace(/[^\w\-]+/g, "_")}.xml`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    // errors already shown by refresh()
  }
});
// Parity: the agent has export_staking_csv, so the engineer has this. A
// deliverable reachable only through an agent would make the agent a gatekeeper.
$("downloadStaking").addEventListener("click", () => {
  try {
    const design = formToDesign(readForm());
    const raw = $<HTMLInputElement>("stakeInterval").value.trim();
    const intervalFt = Number(raw === "" ? "25" : raw);
    if (!Number.isFinite(intervalFt) || intervalFt <= 0) {
      $("status").innerHTML = '<span class="err">staking interval must be a positive number</span>';
      return;
    }
    const csv = toStakingCsv({ ...design, crs: readCrs() }, { intervalFt, includeOffsets: true });
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${design.name.replace(/[^\w\-]+/g, "_")}_staking_${intervalFt}ft.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    // errors already shown by refresh()
  }
});
$("loadExample").addEventListener("click", () => {
  ($("name") as HTMLInputElement).value = "RDC-S1-SAMPLE";
  ($("beginStation") as HTMLInputElement).value = "1000";
  ($("startE") as HTMLInputElement).value = "2200000";
  ($("startN") as HTMLInputElement).value = "1350000";
  ($("azimuth") as HTMLInputElement).value = "75";
  elements = [
    { kind: "tangent", length: "1200" },
    { kind: "arc", radius: "1500", deltaDeg: "45", direction: "right" },
    { kind: "tangent", length: "800" },
    { kind: "arc", radius: "2000", deltaDeg: "30", direction: "left" },
    { kind: "tangent", length: "1000" },
  ];
  pvis = [
    { station: "1000", elevation: "850" },
    { station: "2500", elevation: "880", curveLength: "600" },
    { station: "4200", elevation: "846", curveLength: "800" },
    { station: "6225.29", elevation: "865.56" }, // station derived (alignment end)
  ];
  templates = defaultTemplates();
  drops = [{ template: "2-lane", toStation: "" }];
  renderElements(); renderPvis(); renderTemplates(); renderDrops(); refresh();
});

["name", "beginStation", "startE", "startN", "azimuth"].forEach((id) =>
  $(id).addEventListener("input", refresh),
);

// --- Agent surface (WebMCP) ---
//
// This replaces the old browser-side Anthropic call. That version asked the user
// to paste an API key into localStorage and shipped `dangerouslyAllowBrowser`,
// which is the wrong shape twice over: it puts a live credential in a web page,
// and it embeds a second AI in an app whose whole point is that the VISITING
// agent drives it. The capability is unchanged -- describe a road in English and
// get a design -- but it now belongs to the agent, through tools.
//
// The engineering conventions that used to live in that system prompt now live in
// the tool descriptions, so every agent inherits them.

/** Apply a whole form to the live studio: inputs, state, and a re-render. */
function writeForm(next: StudioForm, agentChange?: string): void {
  // Snapshot before anything changes: this is what undo_last_change restores.
  const before = agentChange !== undefined ? snapshotForm() : undefined;
  $<HTMLInputElement>("name").value = next.name;
  $<HTMLInputElement>("beginStation").value = String(next.beginStation);
  $<HTMLInputElement>("startE").value = String(next.startE);
  $<HTMLInputElement>("startN").value = String(next.startN);
  $<HTMLInputElement>("azimuth").value = String(next.startAzimuthDeg);
  elements = next.elements;
  pvis = next.pvis;
  templates = next.templates;
  drops = next.drops;
  superelevation = next.superelevation;
  roadside = next.roadside ?? [];
  syncSupControls();
  renderElements();
  renderPvis();
  renderTemplates();
  renderDrops();
  refresh();
  if (agentChange !== undefined) {
    agentLedger.record(agentChange, before);
  }
  renderPendingBanner();
}

/** The confirmation boundary, made visible. An agent may author the whole road;
 *  only a person standing behind a seal can confirm it. */
function renderPendingBanner(): void {
  let bar = document.getElementById("agentPending");
  const pending = agentLedger.pending();
  if (pending.length === 0) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "agentPending";
    document.body.append(bar);
  }
  bar.innerHTML = "";

  const head = document.createElement("div");
  head.className = "pending-head";
  head.textContent =
    `${pending.length} agent-proposed change${pending.length === 1 ? "" : "s"} awaiting your confirmation`;

  const sub = document.createElement("div");
  sub.className = "pending-sub";
  sub.textContent =
    "LandXML export is blocked until a licensed engineer confirms these. The agent cannot clear this.";

  const list = document.createElement("ul");
  list.className = "pending-list";
  for (const c of pending) {
    const li = document.createElement("li");
    li.textContent = c.description;
    list.append(li);
  }

  const btn = document.createElement("button");
  btn.className = "pending-confirm";
  btn.type = "button";
  btn.textContent = "I am the engineer — confirm these";
  btn.addEventListener("click", () => {
    agentLedger.confirmAll();
    renderPendingBanner();
    refresh();
  });

  bar.append(head, sub, list, btn);
}



/** Zones this project offers, read from the control rather than duplicated. */
function crsZones(): { value: string; label: string }[] {
  const sel = document.getElementById("crsZone") as HTMLSelectElement | null;
  if (!sel) return [];
  return [...sel.options]
    .filter((o) => o.value !== "")
    .map((o) => ({ value: o.value, label: o.textContent ?? o.value }));
}

/** Set the CRS from a zone key. Returns false if the control rejects it. */
function setCrs(zone: string, basis: "grid" | "ground"): boolean {
  const sel = document.getElementById("crsZone") as HTMLSelectElement | null;
  const bas = document.getElementById("crsBasis") as HTMLSelectElement | null;
  if (!sel || !bas) return false;
  if (![...sel.options].some((o) => o.value === zone)) return false;
  sel.value = zone;
  bas.value = basis;
  refresh();
  return true;
}

/** A deep copy of the current form, for the undo history. */
function snapshotForm(): StudioForm {
  return JSON.parse(JSON.stringify(readForm())) as StudioForm;
}

/** Restore a form without recording it as a new agent change. */
function restoreForm(f: StudioForm): void {
  $<HTMLInputElement>("name").value = f.name;
  $<HTMLInputElement>("beginStation").value = String(f.beginStation);
  $<HTMLInputElement>("startE").value = String(f.startE);
  $<HTMLInputElement>("startN").value = String(f.startN);
  $<HTMLInputElement>("azimuth").value = String(f.startAzimuthDeg);
  elements = f.elements;
  pvis = f.pvis;
  templates = f.templates;
  drops = f.drops;
  superelevation = f.superelevation;
  roadside = f.roadside ?? [];
  syncSupControls();
  renderElements();
  renderPvis();
  renderTemplates();
  renderDrops();
  refresh();
  renderPendingBanner();
}

/**
 * The alternatives panel. An agent fills this; only a click applies anything.
 * Adopting is recorded as a normal agent-proposed change, because the geometry
 * came from the agent even though the choice came from the engineer.
 */
function renderAlternatives(): void {
  let box = document.getElementById("agentAlternatives");
  if (alternatives.count() === 0) { box?.remove(); return; }
  if (!box) {
    box = document.createElement("div");
    box.id = "agentAlternatives";
    document.body.append(box);
  }
  box.innerHTML = "";

  const head = document.createElement("div");
  head.className = "alt-head";
  head.textContent = alternatives.prompt || "Your agent has offered alternatives";

  const sub = document.createElement("div");
  sub.className = "alt-sub";
  const speed = alternatives.designSpeedMph;
  sub.textContent =
    (speed !== undefined ? `Judged at ${speed} mph. ` : "") +
    "Computed, not applied. Nothing changes until you pick one — the agent has no tool that can.";

  const close = document.createElement("button");
  close.className = "alt-close";
  close.type = "button";
  close.textContent = "\u00d7";
  close.setAttribute("aria-label", "Dismiss alternatives");
  close.addEventListener("click", () => { alternatives.clear(); renderAlternatives(); });

  const list = document.createElement("div");
  list.className = "alt-list";

  alternatives.list().forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "alt-card" + (a.refusal ? " alt-invalid" : "");

    const label = document.createElement("div");
    label.className = "alt-label";
    label.textContent = a.label;

    const why = document.createElement("div");
    why.className = "alt-why";
    why.textContent = a.rationale;

    const facts = document.createElement("div");
    facts.className = "alt-facts";
    if (a.refusal) {
      facts.textContent = "does not validate: " + a.refusal.code;
    } else {
      const bits = [
        `${a.alignmentLengthFt} ft`,
        `${a.curveCount} curve${a.curveCount === 1 ? "" : "s"}`,
      ];
      if (a.minRadiusFt !== undefined) bits.push(`min R ${a.minRadiusFt} ft`);
      if (a.minK !== undefined) bits.push(`min K ${a.minK}`);
      if (a.criteriaChecked !== undefined) {
        bits.push(a.criteriaFailed === 0
          ? `${a.criteriaChecked} checks, all pass`
          : `${a.criteriaFailed} of ${a.criteriaChecked} FAIL`);
      }
      facts.textContent = bits.join("  ·  ");
    }

    card.append(label, why, facts);

    if (a.failures && a.failures.length > 0) {
      const fails = document.createElement("ul");
      fails.className = "alt-fails";
      for (const f of a.failures.slice(0, 3)) {
        const li = document.createElement("li");
        li.textContent = f.detail;
        fails.append(li);
      }
      card.append(fails);
    }

    if (!a.refusal) {
      const adopt = document.createElement("button");
      adopt.className = "alt-adopt";
      adopt.type = "button";
      adopt.textContent = "Adopt this one";
      adopt.addEventListener("click", () => {
        const form = alternatives.formAt(i);
        if (!form) return;
        // Goes through writeForm, so it is stamped agent-proposed like any other
        // agent-authored geometry. The engineer chose it; the agent produced it.
        writeForm(form, `adopted alternative "${a.label}"`);
        alternatives.clear();
        renderAlternatives();
        renderAgentLog();
      });
      card.append(adopt);
    }
    list.append(card);
  });

  box.append(close, head, sub, list);
}

const registeredTools = registerWebMcp({
  readForm,
  writeForm,
  readCrs,
  pendingChanges: () =>
    agentLedger.pending().map((c) => ({ id: c.id, description: c.description })),
  onToolCall: (tool, result) => {
    const { kind, summary } = classifyResult(result);
    agentLog.record(tool, kind, summary);
    renderAgentLog();
  },
  undoLastAgentChange: () => {
    const r = agentLedger.undoLast();
    if (!r.ok) return { ok: false as const, reason: r.reason };
    restoreForm(r.before as StudioForm);
    renderAgentLog();
    return { ok: true as const, description: r.change.description };
  },
  planFeatures: () => planFeatures,
  setPlanFeatures: (f) => { planFeatures = f; viewer?.setPlanFeatures(f); refresh(); },
  designSections: () => designSections,
  setDesignSections: (d) => { designSections = d; viewer?.setDesignSections(d); refresh(); },
  terrain: () => terrain,
  setTerrain,
  groundProfile: (intervalFt) => {
    try {
      return groundProfile(formToDesign(readForm()), intervalFt ?? 50);
    } catch {
      return undefined; // an invalid design has no ground profile to report
    }
  },
  shareLink: () => shareUrl(readForm(), window.location.href),
  setCrs,
  crsZones,
  offerAlternatives: (question, alts: readonly AlternativeInput[], designSpeedMph, emax) => {
    alternatives.offer(question, alts, evaluateAlternatives(alts, designSpeedMph, emax));
    alternatives.designSpeedMph = designSpeedMph;
    renderAlternatives();
    return alts.length;
  },
});

// Tell the visitor what their agent can do here -- or that this browser has no
// WebMCP, which otherwise looks like the app ignoring them.
(() => {
  const box = document.getElementById("agentStatus");
  if (!box) return;
  if (registeredTools.length > 0) {
    box.className = "agent-live";
    box.textContent =
      `Agent surface live — ${registeredTools.length} WebMCP tools registered. ` +
      `Ask your agent to design, inspect or change this road; it proposes, the ` +
      `kernel computes, and you confirm.`;
  } else {
    box.className = "agent-absent";
    box.textContent =
      "No WebMCP in this browser. Open this page in ChatGPT's in-app browser, or in " +
      "Chrome with chrome://flags/#enable-webmcp-testing enabled, to let an agent drive it. " +
      "Everything below works on its own regardless.";
  }
})();

// --- 3D corridor view (strictly additive; the Design view is untouched) ---
// Lazily created on first switch so WebGL never runs — and can never fail —
// unless the user opens the view.
let viewer: Viewer3D | null = null;
let viewer3dFailed = false;
let lastDesign: RoadDesign | null = null;
const setReadout = (t: string): void => {
  $("readout3d").textContent = t;
};
const setLegend = (entries: LegendEntry[]): void => {
  $("legend3d").innerHTML = entries
    .map(
      (e) =>
        `<span style="margin-right:10px;"><span style="color:${e.color};">■</span> ${e.name}</span>`,
    )
    .join("");
};

function activate3d(): void {
  if (!viewer && !viewer3dFailed) {
    try {
      viewer = createViewer($("viewer3d"), setReadout, setLegend);
    } catch (e) {
      viewer3dFailed = true;
      $("viewer3d").innerHTML =
        `<div style="padding:16px; color:var(--dim); font-size:12.5px;">` +
        `3D view unavailable (${(e as Error).message}). Usually this means WebGL ` +
        `is off — check browser hardware acceleration. The Design view is unaffected.</div>`;
    }
    if (viewer && lastDesign) {
      try {
        viewer.update(lastDesign);
      } catch (e) {
        setReadout(`corridor unavailable: ${(e as Error).message}`);
      }
    }
  }
  viewer?.setActive(true);
}

function switchView(to3d: boolean): void {
  (document.querySelector("main") as HTMLElement).style.display = to3d ? "none" : "grid";
  $("view3d").style.display = to3d ? "flex" : "none";
  $("btnViewDesign").classList.toggle("active", !to3d);
  $("btnView3d").classList.toggle("active", to3d);
  if (to3d) { activate3d(); viewer?.setTerrain(terrain); viewer?.setDesignSections(designSections); viewer?.setPlanFeatures(planFeatures); }
  else viewer?.setActive(false);
}
$("btnViewDesign").addEventListener("click", () => switchView(false));
$("btnView3d").addEventListener("click", () => switchView(true));
$("exag").addEventListener("change", () =>
  viewer?.setExaggeration(Number($<HTMLSelectElement>("exag").value)),
);

/** The agent activity log. Newest first. */
function renderAgentLog(): void {
  const body = document.getElementById("agentLogBody");
  const box = document.getElementById("agentLog");
  if (!body || !box) return;
  const entries = agentLog.recent(50);
  const summary = box.querySelector("summary");
  if (summary) {
    summary.textContent =
      agentLog.count() === 0
        ? "Agent activity — no WebMCP tool calls yet"
        : `Agent activity — ${agentLog.count()} WebMCP tool call${agentLog.count() === 1 ? "" : "s"}` +
          `, ${agentLog.commitCount()} applied`;
  }
  if (entries.length === 0) {
    body.innerHTML =
      '<div class="log-empty">Nothing yet. When an agent calls a tool on this page it appears ' +
      "here — which is how you can tell it used WebMCP rather than clicking the form.</div>";
    return;
  }
  body.innerHTML = "";
  for (const e of entries) {
    const line = document.createElement("div");
    line.className = "log-line";
    const t = document.createElement("span");
    t.className = "log-time";
    t.textContent = e.at.toLocaleTimeString();
    const name = document.createElement("span");
    name.className = `log-tool k-${e.kind}`;
    name.textContent = e.tool;
    const sum = document.createElement("span");
    sum.className = "log-sum";
    sum.textContent = e.summary;
    line.append(t, name, sum);
    body.append(line);
  }
}

// --- superelevation, authored by the ENGINEER ---
//
// The agent can set this through set_superelevation, but a licensed engineer must
// be able to author everything the agent can. A capability only an agent can reach
// would make the agent a gatekeeper on an engineering decision, which inverts the
// liability the whole app is built around.

function readSupControls(): SuperelevationSpec | undefined {
  const on = $<HTMLInputElement>("supEnabled").checked;
  if (!on) return undefined;
  const num = (id: string): number | undefined => {
    const raw = $<HTMLInputElement>(id).value.trim();
    if (raw === "") return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  };
  const speed = num("supSpeed");
  if (speed === undefined || speed <= 0) return undefined;
  const emaxPercent = num("supEmax") ?? 6;
  const spec: SuperelevationSpec = { designSpeedMph: speed, emax: emaxPercent / 100 };
  const nc = num("supNc");
  if (nc !== undefined) spec.normalCrownPercent = nc;
  const grad = num("supGrad");
  if (grad !== undefined) spec.maxRelativeGradientPercent = grad;
  return spec;
}

/** Push module state back into the controls -- used when the AGENT sets it. */
function syncSupControls(): void {
  const box = $<HTMLInputElement>("supEnabled");
  box.checked = superelevation !== undefined;
  if (superelevation) {
    $<HTMLInputElement>("supSpeed").value = String(superelevation.designSpeedMph);
    $<HTMLInputElement>("supEmax").value = String(superelevation.emax * 100);
    if (superelevation.normalCrownPercent !== undefined) {
      $<HTMLInputElement>("supNc").value = String(superelevation.normalCrownPercent);
    }
    if (superelevation.maxRelativeGradientPercent !== undefined) {
      $<HTMLInputElement>("supGrad").value = String(superelevation.maxRelativeGradientPercent);
    }
  }
  $("supFields").classList.toggle("on", box.checked);
}

/** Per-curve banking summary, computed by the kernel, shown to the engineer. */
function renderSupSummary(design: RoadDesign | null): void {
  const host = $("supSummary");
  host.innerHTML = "";
  if (!superelevation) {
    host.textContent = "Not banked. Template cross slopes apply everywhere.";
    return;
  }
  if (!design) {
    host.textContent = "Fix the errors above to compute banking.";
    return;
  }
  const h = computeHorizontal(design.alignment);
  const rows: string[] = [];
  h.elements.forEach((report, i) => {
    if (report.type !== "arc" || report.curve === undefined) return;
    const authored = design.alignment.elements[i];
    const direction =
      authored !== undefined && "direction" in authored && authored.direction === "left"
        ? ("left" as const) : ("right" as const);
    const t = transitionFor({
      radiusFt: report.curve.radius, direction,
      pcStation: report.beginStation, ptStation: report.endStation,
    }, i, superelevation!);
    rows.push(
      `curve ${rows.length + 1} ${direction}  R=${t.radiusFt}  e=${t.fullSuperPercent}%  ` +
      `runoff ${t.runoffLengthFt} ft  runout ${t.tangentRunoutFt} ft`,
    );
  });
  if (rows.length === 0) {
    host.textContent = "No circular curves to bank.";
    return;
  }
  for (const r of rows) {
    const div = document.createElement("div");
    div.className = "sup-row";
    div.textContent = r;
    host.append(div);
  }
  const note = document.createElement("div");
  note.style.marginTop = "5px";
  note.textContent =
    "e is computed from each radius and the design speed; a curve flat enough for friction " +
    "alone stays at normal crown. Coefficients are inputs, not an adopted standard.";
  host.append(note);
}

for (const id of ["supEnabled", "supSpeed", "supEmax", "supNc", "supGrad"]) {
  const el = document.getElementById(id);
  el?.addEventListener(id === "supEnabled" ? "change" : "input", () => {
    superelevation = readSupControls();
    $("supFields").classList.toggle("on", $<HTMLInputElement>("supEnabled").checked);
    refresh();
  });
}


// --- restore on load ------------------------------------------------------
//
// A shared link wins over autosave: if someone sent you a design, that is what
// you meant to open. Neither is allowed to break boot -- a corrupt link should
// leave you in a working studio with the seeded road, not a blank page.
(() => {
  const fromLink = window.location.hash ? decodeFragment(window.location.hash) : undefined;
  const restored = fromLink?.ok === true ? fromLink : loadAutosave();
  if (!restored.ok) return;
  try {
    restoreForm(restored.form);
    const note = $("status");
    if (fromLink?.ok === true) {
      note.innerHTML = '<span class="ok">\u2713 opened a shared design</span>';
    }
  } catch {
    /* a bad restore must not take the app down; the seeded design stands */
  }
})();

// Parity: the agent has import_landxml, so the engineer has this.
$("importLandxml").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const status = $("status");
  void file.text().then((xml) => {
    const parsed = parseLandXML(xml);
    if (!parsed.ok) {
      status.innerHTML = `<span class="err">${parsed.code}: ${parsed.detail}</span>`;
      input.value = "";
      return;
    }
    if (parsed.surfaces.length > 0) setTerrain(parsed.surfaces[0]!);
    designSections = parsed.designSections;
    viewer?.setDesignSections(designSections);
    planFeatures = parsed.planFeatures;
    viewer?.setPlanFeatures(planFeatures);
    const a = parsed.alignments[0];
    if (!a) {
      status.innerHTML =
        `<span class="ok">\u2713 loaded ground surface "${parsed.surfaces[0]?.name ?? ""}" ` +
        `(${parsed.surfaces[0]?.faces.length ?? 0} triangles)</span>`;
      input.value = "";
      return;
    }
    const pvis = a.pvis.length >= 2
      ? a.pvis.map((v) => ({
          station: String(v.station), elevation: String(v.elevation),
          ...(v.curveLength !== undefined ? { curveLength: String(v.curveLength) } : {}),
        }))
      : [{ station: String(a.beginStation), elevation: "0" },
         { station: String(a.beginStation + 1), elevation: "0" }];
    restoreForm({
      name: a.name,
      beginStation: a.beginStation,
      startE: a.start.e,
      startN: a.start.n,
      startAzimuthDeg: a.startAzimuthDeg,
      elements: a.elements.map((el) =>
        el.type === "tangent"
          ? { kind: "tangent" as const, length: String(el.length) }
          : el.type === "arc"
            ? { kind: "arc" as const, radius: String(el.radius),
                deltaDeg: String(el.deltaDeg), direction: el.direction }
            : { kind: "deflection" as const, deflectionDeg: String(el.deflectionDeg),
                direction: el.direction }),
      pvis,
      templates,
      drops,
    });
    const extra = parsed.alignments.length > 1
      ? ` (${parsed.alignments.length} alignments in the file; took the first)` : "";
    status.innerHTML =
      `<span class="ok">\u2713 imported "${a.name}"${extra}</span>`;
    input.value = "";
  });
});

$("shareLink").addEventListener("click", () => {
  const url = shareUrl(readForm(), window.location.href);
  const status = $("status");
  void navigator.clipboard?.writeText(url)
    .then(() => {
      window.history.replaceState(null, "", url);
      status.innerHTML =
        '<span class="ok">\u2713 link copied \u2014 it carries the whole design</span>';
    })
    .catch(() => {
      window.history.replaceState(null, "", url);
      status.innerHTML = '<span class="ok">link is in the address bar \u2014 copy it</span>';
    });
});

syncSupControls();
renderAgentLog();
renderElements();
renderPvis();
renderTemplates();
renderDrops();
refresh();
