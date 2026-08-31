// Planimetric features — the site that is already there.
//
// A survey LandXML carries what exists: buildings, sidewalks, lot lines, kerbs,
// fences. Measured on a real public file, sv_tutor.xml: 71 features named BLDG,
// SDWK and LOT, drawn from 408 lines and 68 curves.
//
// ⚠ Most of that geometry is written as POINT REFERENCES, not coordinates -- 1,470
// pntRef against 72 inline pairs on that file. A reader that only handles inline
// coordinates would import 5% of the site and look like it worked, which is worse
// than importing none.
//
// ⛔ Feature names are carried, never interpreted. "BLDG1|1094" is a building on
// this file and could be anything on the next; classifying by name prefix would be
// guessing at somebody else's coding scheme.

export interface PlanFeaturePoint {
  n: number;
  e: number;
  /** Absent where the survey gave no elevation. */
  z?: number;
}

export interface PlanFeatureLine {
  /** The feature's name exactly as the file wrote it. */
  name: string;
  /** One connected run of points. A feature may produce several. */
  points: PlanFeaturePoint[];
  /** True when every point carried an elevation, so it can be drawn in 3D. */
  hasElevation: boolean;
}

export interface PlanFeatureSet {
  features: PlanFeatureLine[];
  /** Points that could not be resolved -- reported, not hidden. */
  unresolvedRefs: number;
  bounds?: { minN: number; maxN: number; minE: number; maxE: number };
}

type Finder = (root: Element | Document, name: string) => Element[];

const defaultFind: Finder = (root, name) => {
  const ns = root.getElementsByTagNameNS("*", name);
  return Array.prototype.slice.call(ns.length > 0 ? ns : root.getElementsByTagName(name)) as Element[];
};

/** "northing easting [elevation]" in the file's own order. */
function parseTriple(text: string | null | undefined, toFt: number): PlanFeaturePoint | undefined {
  if (!text) return undefined;
  const p = text.trim().split(/\s+/).map(Number);
  if (p.length < 2 || !Number.isFinite(p[0]!) || !Number.isFinite(p[1]!)) return undefined;
  const out: PlanFeaturePoint = { n: p[0]! * toFt, e: p[1]! * toFt };
  if (p.length > 2 && Number.isFinite(p[2]!)) out.z = p[2]! * toFt;
  return out;
}

export function parsePlanFeatures(
  doc: Document,
  toFt = 1,
  byLocalName: Finder = defaultFind,
): PlanFeatureSet {
  // The point table first: most geometry refers to it rather than repeating itself.
  const points = new Map<string, PlanFeaturePoint>();
  for (const cg of byLocalName(doc, "CgPoint")) {
    const name = cg.getAttribute("name");
    const p = parseTriple(cg.textContent, toFt);
    if (name && p) points.set(name, p);
  }

  let unresolvedRefs = 0;
  const resolve = (el: Element | undefined): PlanFeaturePoint | undefined => {
    if (!el) return undefined;
    const ref = el.getAttribute("pntRef");
    if (ref !== null) {
      const hit = points.get(ref);
      if (!hit) unresolvedRefs += 1;
      return hit;
    }
    return parseTriple(el.textContent, toFt);
  };

  const features: PlanFeatureLine[] = [];
  for (const pf of byLocalName(doc, "PlanFeature")) {
    const name = pf.getAttribute("name") || "feature";
    // A feature's segments are consecutive; a break in continuity starts a new run
    // rather than drawing a line across the gap.
    let run: PlanFeaturePoint[] = [];
    const flush = (): void => {
      if (run.length >= 2) {
        features.push({
          name,
          points: run,
          hasElevation: run.every((p) => p.z !== undefined),
        });
      }
      run = [];
    };

    for (const geom of byLocalName(pf, "CoordGeom")) {
      for (let i = 0; i < geom.children.length; i += 1) {
        const seg = geom.children[i]!;
        const local = seg.localName ?? seg.nodeName.replace(/^.*:/, "");
        if (local !== "Line" && local !== "Curve") continue;
        const s = resolve(byLocalName(seg, "Start")[0]);
        const e = resolve(byLocalName(seg, "End")[0]);
        if (!s || !e) { flush(); continue; }

        const last = run[run.length - 1];
        const continues = last !== undefined
          && Math.abs(last.n - s.n) < 1e-6 && Math.abs(last.e - s.e) < 1e-6;
        if (!continues) { flush(); run.push(s); }
        // A curve is drawn as its chord. Stated plainly rather than silently: the
        // file gives Start/Center/End and the sag of a survey arc at this scale is
        // under the width of the line, but it IS an approximation.
        run.push(e);
      }
      flush();
    }
    flush();
  }

  let bounds: PlanFeatureSet["bounds"];
  if (features.length > 0) {
    let minN = Infinity, maxN = -Infinity, minE = Infinity, maxE = -Infinity;
    for (const f of features) {
      for (const p of f.points) {
        if (p.n < minN) minN = p.n;
        if (p.n > maxN) maxN = p.n;
        if (p.e < minE) minE = p.e;
        if (p.e > maxE) maxE = p.e;
      }
    }
    bounds = { minN, maxN, minE, maxE };
  }

  return { features, unresolvedRefs, bounds };
}

/** Group by the part of the name before a separator, for a legible summary. */
export function summarisePlanFeatures(
  set: PlanFeatureSet,
): { group: string; count: number; withElevation: number }[] {
  const byGroup = new Map<string, { count: number; withElevation: number }>();
  for (const f of set.features) {
    // Split on the file's own separator if there is one. This is a LABEL for the
    // summary, not a classification -- nothing downstream acts on it.
    const group = f.name.split(/[|:_\-\s]/)[0] || f.name;
    const row = byGroup.get(group) ?? { count: 0, withElevation: 0 };
    row.count += 1;
    if (f.hasElevation) row.withElevation += 1;
    byGroup.set(group, row);
  }
  return [...byGroup.entries()]
    .map(([group, v]) => ({ group, ...v }))
    .sort((a, b) => b.count - a.count);
}
