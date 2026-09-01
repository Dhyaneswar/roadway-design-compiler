// Existing ground — the surface a road is actually built on.
//
// A design surface floating in space is a drawing. Tied to ground it becomes
// engineering: you can say how deep the cut is, how high the fill, and whether the
// profile you chose is buildable. This is the ground half of that.
//
// A TIN is a triangulated irregular network: measured points, joined into
// triangles. LandXML writes them as <Pnts> and <Faces>, and this reads them into a
// form the viewer can draw and the kernel can sample.
//
// Coordinates keep LandXML's own order at the boundary -- northing, easting,
// elevation -- and are converted to this project's { n, e, z } immediately, so the
// order never has to be remembered again.

import type { SurfaceAppearance } from "../viewer/surface-appearance";
export interface TinPoint {
  n: number;
  e: number;
  z: number;
}

/** Triangle by vertex index into `points`. */
export type TinFace = readonly [number, number, number];

export interface Tin {
  name: string;
  points: TinPoint[];
  faces: TinFace[];
  /** Bounding box, computed once -- every sample needs it. */
  bounds: { minN: number; maxN: number; minE: number; maxE: number; minZ: number; maxZ: number };
  /**
   * How this surface should be drawn, and why -- resolved at import from the
   * file's own MaterialTable, or a stable identity colour when it has none.
   *
   * Optional because a Tin can be built without a file behind it (tests, and
   * any future generated surface), and because appearance is presentation: the
   * kernel samples elevations and never reads this.
   */
  appearance?: SurfaceAppearance;
}

export function tinBounds(points: readonly TinPoint[]): Tin["bounds"] {
  if (points.length === 0) {
    return { minN: 0, maxN: 0, minE: 0, maxE: 0, minZ: 0, maxZ: 0 };
  }
  let minN = Infinity, maxN = -Infinity, minE = Infinity, maxE = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.n < minN) minN = p.n;
    if (p.n > maxN) maxN = p.n;
    if (p.e < minE) minE = p.e;
    if (p.e > maxE) maxE = p.e;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minN, maxN, minE, maxE, minZ, maxZ };
}

export function makeTin(name: string, points: TinPoint[], faces: TinFace[]): Tin {
  return { name, points, faces, bounds: tinBounds(points) };
}

/**
 * A uniform grid over the triangles, so sampling is not a scan of every face.
 *
 * A 15,000-triangle surface sampled at every station of a mile-long road is
 * ~350 million triangle tests without an index and a few thousand with one. The
 * grid is built once per surface and reused.
 */
export class TinSampler {
  private readonly cells = new Map<number, number[]>();
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellN: number;
  private readonly cellE: number;

  constructor(private readonly tin: Tin, targetCells = 64) {
    const { minN, maxN, minE, maxE } = tin.bounds;
    const spanN = Math.max(maxN - minN, 1e-9);
    const spanE = Math.max(maxE - minE, 1e-9);
    this.cols = Math.max(1, Math.min(targetCells, Math.ceil(Math.sqrt(tin.faces.length / 4)) || 1));
    this.rows = this.cols;
    this.cellN = spanN / this.rows;
    this.cellE = spanE / this.cols;

    tin.faces.forEach((f, i) => {
      const a = tin.points[f[0]], b = tin.points[f[1]], c = tin.points[f[2]];
      if (!a || !b || !c) return;
      const r0 = this.rowOf(Math.min(a.n, b.n, c.n));
      const r1 = this.rowOf(Math.max(a.n, b.n, c.n));
      const c0 = this.colOf(Math.min(a.e, b.e, c.e));
      const c1 = this.colOf(Math.max(a.e, b.e, c.e));
      for (let r = r0; r <= r1; r += 1) {
        for (let cc = c0; cc <= c1; cc += 1) {
          const key = r * this.cols + cc;
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    });
  }

  private rowOf(n: number): number {
    const r = Math.floor((n - this.tin.bounds.minN) / this.cellN);
    return Math.max(0, Math.min(this.rows - 1, r));
  }
  private colOf(e: number): number {
    const c = Math.floor((e - this.tin.bounds.minE) / this.cellE);
    return Math.max(0, Math.min(this.cols - 1, c));
  }

  /**
   * Ground elevation under a point, or undefined when the point is off the
   * surface. Undefined is a real answer: a road can run past the edge of a
   * survey, and inventing ground there is how a design gets built wrong.
   */
  elevationAt(n: number, e: number): number | undefined {
    const { bounds } = this.tin;
    if (n < bounds.minN || n > bounds.maxN || e < bounds.minE || e > bounds.maxE) return undefined;
    const candidates = this.cells.get(this.rowOf(n) * this.cols + this.colOf(e));
    if (!candidates) return undefined;
    for (const fi of candidates) {
      const f = this.tin.faces[fi]!;
      const a = this.tin.points[f[0]], b = this.tin.points[f[1]], c = this.tin.points[f[2]];
      if (!a || !b || !c) continue;
      const z = interpolate(a, b, c, n, e);
      if (z !== undefined) return z;
    }
    return undefined;
  }
}

/**
 * Barycentric interpolation. Returns undefined when the point is outside the
 * triangle, which is how the caller decides to keep looking.
 */
function interpolate(
  a: TinPoint, b: TinPoint, c: TinPoint, n: number, e: number,
): number | undefined {
  const v0n = b.n - a.n, v0e = b.e - a.e;
  const v1n = c.n - a.n, v1e = c.e - a.e;
  const den = v0n * v1e - v1n * v0e;
  if (Math.abs(den) < 1e-12) return undefined; // degenerate triangle
  const pn = n - a.n, pe = e - a.e;
  const w1 = (pn * v1e - v1n * pe) / den;
  const w2 = (v0n * pe - pn * v0e) / den;
  const w0 = 1 - w1 - w2;
  const EPS = -1e-9;
  if (w0 < EPS || w1 < EPS || w2 < EPS) return undefined;
  return w0 * a.z + w1 * b.z + w2 * c.z;
}

export interface GroundSample {
  station: number;
  /** Undefined where the alignment runs off the surveyed surface. */
  groundZ?: number;
  designZ: number;
  /** designZ - groundZ. Positive is FILL, negative is CUT. Undefined off-surface. */
  cutFillFt?: number;
}

/**
 * Sample ground against a design profile along the alignment.
 *
 * Sign convention stated because getting it backwards inverts an earthwork
 * estimate: POSITIVE is fill (the road sits above ground), NEGATIVE is cut (the
 * road is below it).
 */
export function sampleGround(
  sampler: TinSampler,
  stations: readonly { station: number; n: number; e: number; designZ: number }[],
): GroundSample[] {
  return stations.map((s) => {
    const groundZ = sampler.elevationAt(s.n, s.e);
    return groundZ === undefined
      ? { station: s.station, designZ: s.designZ }
      : {
          station: s.station,
          groundZ,
          designZ: s.designZ,
          cutFillFt: Number((s.designZ - groundZ).toFixed(4)),
        };
  });
}

export interface EarthworkSummary {
  sampled: number;
  /** Stations that fell outside the surveyed surface. */
  offSurface: number;
  maxCutFt: number;
  maxFillFt: number;
  /** Where the road crosses ground level -- the daylight points. */
  balancePoints: number[];
  /** Mean of |cut or fill|, a rough measure of how well the profile fits. */
  meanAbsFt: number;
}

export function summariseEarthwork(samples: readonly GroundSample[]): EarthworkSummary {
  const usable = samples.filter((s) => s.cutFillFt !== undefined);
  let maxCut = 0, maxFill = 0, total = 0;
  for (const s of usable) {
    const v = s.cutFillFt!;
    if (v < maxCut) maxCut = v;
    if (v > maxFill) maxFill = v;
    total += Math.abs(v);
  }
  const balance: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1]!.cutFillFt!, now = usable[i]!.cutFillFt!;
    if ((prev < 0 && now >= 0) || (prev > 0 && now <= 0)) {
      // Linear crossing between the two stations.
      const t = Math.abs(prev) / (Math.abs(prev) + Math.abs(now) || 1);
      const s0 = usable[i - 1]!.station, s1 = usable[i]!.station;
      balance.push(Number((s0 + t * (s1 - s0)).toFixed(2)));
    }
  }
  return {
    sampled: samples.length,
    offSurface: samples.length - usable.length,
    maxCutFt: Number(Math.abs(maxCut).toFixed(3)),
    maxFillFt: Number(maxFill.toFixed(3)),
    balancePoints: balance,
    meanAbsFt: usable.length > 0 ? Number((total / usable.length).toFixed(3)) : 0,
  };
}
