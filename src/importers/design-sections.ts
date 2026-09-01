// As-designed cross sections from LandXML.
//
// A LandXML that came out of real design software often carries the sections the
// designer actually produced -- not a template to sweep, but the finished surfaces
// station by station, each named and sided. Measured on a real public file: 442
// stations carrying Slitlager (the wearing course), Terrace, Teoretisk, Jord and
// Berg, left and right.
//
// That is the original designer's road. This app builds a corridor by sweeping a
// template, which is a different and coarser thing, so these are imported as a
// separate REFERENCE overlay rather than being merged into the design. Merging
// them would quietly replace the engineer's model with somebody else's and make
// the two impossible to tell apart.
//
// ⚠ Not every named surface is roadway. On the file above, Slitlager spans 7.25 m
// and Jord spans 413 m -- the first is pavement, the second is a ground section
// sampled far past the road. Width is reported so a caller can tell them apart
// rather than being told which is which by a guess.

export interface SectionPointRaw {
  /** Offset from the alignment centreline, ft. Sign as the file gave it. */
  offsetFt: number;
  elevationFt: number;
  /**
   * The designer's own point code, EXACTLY as written -- "KS", "SR", "BUSS".
   *
   * ⛔ Never interpreted. These are project abbreviations: they mean one thing
   * on the file they were measured on and something else on the next, so they
   * are carried through as opaque strings for grouping and shown verbatim in a
   * legend. Undefined where the file gave no code, which is common -- on the
   * measured file one surface has 2,873 coded points and another has 4,499
   * with none at all.
   */
  code?: string;
}

export interface DesignSectionAtStation {
  stationFt: number;
  side: "left" | "right";
  points: SectionPointRaw[];
}

export interface DesignSectionSurface {
  name: string;
  /** Every station/side run for this surface, in document order. */
  runs: DesignSectionAtStation[];
  /** Stations covered. */
  stationCount: number;
  /** Widest offset span seen, ft — pavement is narrow, ground is not. */
  maxWidthFt: number;
  minOffsetFt: number;
  maxOffsetFt: number;
  minElevationFt: number;
  maxElevationFt: number;
  /** Distinct point codes on this surface, sorted. Empty when none are coded. */
  codes: string[];
  codedPointCount: number;
  uncodedPointCount: number;
}

const num = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Read every DesignCrossSectSurf in the document, grouped by surface name.
 *
 * `toFt` converts the file's linear unit, and is supplied by the caller because
 * the same document's Units block governs the alignment too -- deciding it twice
 * is how the two end up on different scales.
 */
export function parseDesignSections(
  doc: Document,
  toFt = 1,
  byLocalName?: (root: Element | Document, name: string) => Element[],
): DesignSectionSurface[] {
  const find = byLocalName ?? ((root: Element | Document, name: string) => {
    const ns = root.getElementsByTagNameNS("*", name);
    return Array.prototype.slice.call(ns.length > 0 ? ns : root.getElementsByTagName(name)) as Element[];
  });

  const bySurface = new Map<string, DesignSectionAtStation[]>();

  for (const cs of find(doc, "CrossSect")) {
    const sta = num(cs.getAttribute("sta"));
    if (sta === undefined) continue;
    for (const surf of find(cs, "DesignCrossSectSurf")) {
      const name = surf.getAttribute("name");
      if (!name) continue;
      const side = surf.getAttribute("side") === "left" ? "left" as const : "right" as const;

      const points: SectionPointRaw[] = [];
      for (const p of find(surf, "CrossSectPnt")) {
        const parts = (p.textContent ?? "").trim().split(/\s+/).map(Number);
        if (parts.length < 2 || !Number.isFinite(parts[0]!) || !Number.isFinite(parts[1]!)) continue;
        const code = (p.getAttribute("code") ?? "").trim();
        points.push({
          offsetFt: parts[0]! * toFt,
          elevationFt: parts[1]! * toFt,
          ...(code !== "" ? { code } : {}),
        });
      }
      if (points.length < 2) continue;

      const runs = bySurface.get(name) ?? [];
      runs.push({ stationFt: sta * toFt, side, points });
      bySurface.set(name, runs);
    }
  }

  const out: DesignSectionSurface[] = [];
  for (const [name, runs] of bySurface) {
    let minO = Infinity, maxO = -Infinity, minE = Infinity, maxE = -Infinity, maxW = 0;
    const stations = new Set<number>();
    for (const run of runs) {
      stations.add(run.stationFt);
      let lo = Infinity, hi = -Infinity;
      for (const p of run.points) {
        if (p.offsetFt < lo) lo = p.offsetFt;
        if (p.offsetFt > hi) hi = p.offsetFt;
        if (p.offsetFt < minO) minO = p.offsetFt;
        if (p.offsetFt > maxO) maxO = p.offsetFt;
        if (p.elevationFt < minE) minE = p.elevationFt;
        if (p.elevationFt > maxE) maxE = p.elevationFt;
      }
      if (hi - lo > maxW) maxW = hi - lo;
    }
    // Codes are counted across the WHOLE surface, coded and uncoded alike: a
    // surface where most points carry no code has to be able to say so.
    const codeSet = new Set<string>();
    let coded = 0, uncoded = 0;
    for (const run of runs) {
      for (const p of run.points) {
        if (p.code === undefined) uncoded += 1;
        else { coded += 1; codeSet.add(p.code); }
      }
    }
    out.push({
      name,
      runs,
      codes: [...codeSet].sort(),
      codedPointCount: coded,
      uncodedPointCount: uncoded,
      stationCount: stations.size,
      maxWidthFt: Number(maxW.toFixed(3)),
      minOffsetFt: Number(minO.toFixed(3)),
      maxOffsetFt: Number(maxO.toFixed(3)),
      minElevationFt: Number(minE.toFixed(3)),
      maxElevationFt: Number(maxE.toFixed(3)),
    });
  }
  // Narrowest first: the pavement surfaces are the ones a roadway engineer wants.
  out.sort((a, b) => a.maxWidthFt - b.maxWidthFt);
  return out;
}
