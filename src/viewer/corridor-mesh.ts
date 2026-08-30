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
  /** Index ranges per template run, for per-drop materials/colors */
  groups: { template: string; start: number; count: number }[];
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
  side: "L" | "R" | "CL";
  offset: number;
}

function rowPoints(s: CrossSection): RowPoint[] {
  const left = [...s.left]
    .reverse()
    .map((p) => ({ point: p.point, name: p.name, side: "L" as const, offset: p.offset }));
  const right = s.right.map((p) => ({
    point: p.point,
    name: p.name,
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
  const groups: { template: string; start: number; count: number }[] = [];
  const boundaries: { station: number; template: string; loop: number[] }[] = [];
  const pointMeta: PointMeta[] = [];

  let prevBase = 0;
  let prevWidth = 0;
  let prevTemplate = "";
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
      const start = indices.length;
      for (let j = 0; j < row.length - 1; j++) {
        const a = prevBase + j;
        const b = base + j;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
      const last = groups[groups.length - 1];
      if (last && last.template === section.template && last.start + last.count === start) {
        last.count += indices.length - start;
      } else {
        groups.push({ template: section.template, start, count: indices.length - start });
      }
    }
    prevBase = base;
    prevWidth = row.length;
    prevTemplate = section.template;
    base += row.length;
    sectionIndex++;
  }

  return {
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
