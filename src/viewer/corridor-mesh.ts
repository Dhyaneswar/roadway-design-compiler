// Corridor → triangle mesh for the 3D viewer. Pure functions, no three.js
// dependency — output is plain position/index arrays the DOM layer feeds to
// BufferGeometry.
//
// Coordinate mapping (three.js is y-up, right-handed):
//   x = e − origin.e,  y = z − origin.z,  z = −(n − origin.n)
// Positions are relative to the first centerline point so state-plane
// magnitudes (~2.2M ft) survive Float32 on the GPU.
//
// Each cross section becomes one vertex row, outermost-left → centerline →
// outermost-right. Adjacent rows are stitched into quads (two triangles)
// only when they have the same width — template changes between drops must
// never bridge mismatched rows.

import type { Corridor, CrossSection, Point3 } from "../kernel/corridor";

export interface CorridorMesh {
  /** First centerline point (e/n/z, ft) — world offset of all positions */
  origin: Point3;
  /** Vertex positions in three.js coords, 3 floats per vertex */
  positions: number[];
  /** Triangle indices into positions */
  indices: number[];
  /** Centerline polyline in three.js coords, 3 floats per section */
  centerline: number[];
  /** Station at each section, ft — parallel to centerline points (readout) */
  stations: number[];
  /** Template name at each section — parallel to stations (readout) */
  sectionTemplates: string[];
  /**
   * Index ranges per SURFACE KIND, for per-material colouring.
   *
   * Keyed by the segment's authored material where one exists, and by the segment
   * name where it does not -- a project that never states materials still gets
   * lane and shoulder drawn apart, which is the useful half of the effect.
   *
   * ⚠ Triangles are bucketed by kind BEFORE being written, so an index range is
   * contiguous per kind rather than per row. Emitting row by row would interleave
   * kinds and make contiguous groups impossible.
   */
  groups: { kind: string; start: number; count: number }[];
  /**
   * Longitudinal lines along segment boundaries, for edge-of-pavement and the
   * centreline. Derived from authored geometry -- these are where the surfaces
   * actually meet, NOT an authored striping plan, and are labelled as such.
   */
  edgeLines: { kind: "centreline" | "edge-of-pavement" | "segment"; points: number[] }[];
  /** Template-change locations: station, incoming template, and the incoming
   *  section's outline (three.js coords) for drawing a boundary ring/label */
  boundaries: { station: number; template: string; loop: number[] }[];
  /** Per-vertex snap metadata — kernel-exact template point identities:
   *  which section (→ station/template), segment name, side, and offset. */
  pointMeta: PointMeta[];
}

export interface PointMeta {
  sectionIndex: number;
  name: string;
  side: "L" | "R" | "CL";
  /** Horizontal offset from centerline, ft (unsigned; side carries L/R) */
  offset: number;
}

interface RowPoint {
  point: Point3;
  name: string;
  material?: string;
  side: "L" | "R" | "CL";
  offset: number;
}

/** Materials that are a driving surface, so their outer edge is an edge of pavement. */
const PAVED = new Set(["asphalt", "concrete"]);

/**
 * The surface kind of the strip between two adjacent row points.
 *
 * A template point sits at its segment's OUTER edge, so on the right side the
 * strip belongs to the point further out, and on the (reversed) left side it
 * belongs to the point nearer the start of the row. Getting this backwards paints
 * every lane with its shoulder's material.
 */
function stripPoint(row: RowPoint[], j: number): RowPoint {
  return row[j]!.side === "L" ? row[j]! : row[j + 1]!;
}

function rowPoints(s: CrossSection): RowPoint[] {
  const left = [...s.left].reverse().map((p) => ({
    point: p.point, name: p.name, material: p.material, side: "L" as const, offset: p.offset,
  }));
  const right = s.right.map((p) => ({
    point: p.point,
    name: p.name,
    material: p.material,
    side: "R" as const,
    offset: p.offset,
  }));
  return [
    ...left,
    { point: s.centerline, name: "CL", side: "CL" as const, offset: 0 },
    ...right,
  ];
}

export function buildCorridorMesh(corridor: Corridor): CorridorMesh {
  const { sections } = corridor;
  if (sections.length === 0) throw new RangeError("corridor has no sections");

  const origin = sections[0]!.centerline;
  const toThree = (p: Point3): [number, number, number] => [
    p.e - origin.e,
    p.z - origin.z,
    -(p.n - origin.n),
  ];

  const positions: number[] = [];
  const indices: number[] = [];
  const centerline: number[] = [];
  const stations: number[] = [];
  const sectionTemplates: string[] = [];
  const groups: { kind: string; start: number; count: number }[] = [];
  const boundaries: { station: number; template: string; loop: number[] }[] = [];
  const pointMeta: PointMeta[] = [];

  // kind -> triangles, so each kind lands in one contiguous index range.
  const buckets = new Map<string, number[]>();
  // row-position -> polyline, for the longitudinal boundary lines. Keyed by
  // position rather than offset so a widening taper still yields one line.
  const rails = new Map<number, { kind: "centreline" | "edge-of-pavement" | "segment"; pts: number[] }>();

  let prevBase = 0;
  let prevWidth = 0;
  let prevTemplate = "";
  let prevRow: RowPoint[] = [];
  let base = 0;
  let sectionIndex = 0;
  for (const section of sections) {
    const row = rowPoints(section);
    const rowFloats = row.flatMap((p) => toThree(p.point));
    positions.push(...rowFloats);
    for (const p of row) {
      pointMeta.push({ sectionIndex, name: p.name, side: p.side, offset: p.offset });
    }
    centerline.push(...toThree(section.centerline));
    stations.push(section.station);
    sectionTemplates.push(section.template);

    if (prevTemplate !== "" && prevTemplate !== section.template) {
      boundaries.push({ station: section.station, template: section.template, loop: rowFloats });
    }

    // Stitch only within a run: same row width AND same template — template
    // changes are honest discontinuities and also color-group boundaries.
    if (prevWidth === row.length && prevTemplate === section.template && base > 0) {
      for (let j = 0; j < row.length - 1; j++) {
        const a = prevBase + j;
        const b = base + j;
        const p = stripPoint(row, j);
        const kind = p.material ?? p.name;
        let bucket = buckets.get(kind);
        if (!bucket) { bucket = []; buckets.set(kind, bucket); }
        bucket.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }

    // One longitudinal line per row position. The centreline and the outermost
    // paved edge are the two a driver would actually see painted.
    row.forEach((p, j) => {
      const prev = prevRow[j];
      const outerPaved = PAVED.has(p.material ?? "")
        && !PAVED.has(row[j + (p.side === "L" ? -1 : 1)]?.material ?? "");
      const kind = p.side === "CL" ? "centreline" as const
        : outerPaved ? "edge-of-pavement" as const : "segment" as const;
      let rail = rails.get(j);
      if (!rail || rail.kind !== kind) { rail = { kind, pts: [] }; rails.set(j, rail); }
      if (prev === undefined || prevWidth === row.length) rail.pts.push(...toThree(p.point));
    });
    prevRow = row;
    prevBase = base;
    prevWidth = row.length;
    prevTemplate = section.template;
    base += row.length;
    sectionIndex++;
  }

  // Flatten the buckets into one contiguous index array, recording each range.
  for (const [kind, tris] of buckets) {
    const start = indices.length;
    indices.push(...tris);
    groups.push({ kind, start, count: tris.length });
  }

  const edgeLines = [...rails.values()]
    .filter((r) => r.kind !== "segment" && r.pts.length >= 6)
    .map((r) => ({ kind: r.kind, points: r.pts }));

  return {
    edgeLines,
    origin,
    positions,
    indices,
    centerline,
    stations,
    sectionTemplates,
    groups,
    boundaries,
    pointMeta,
  };
}
