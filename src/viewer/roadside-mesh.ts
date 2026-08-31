// Roadside furniture → geometry for the 3D viewer.
//
// Each item is swept along the alignment between its authored stations, at its
// authored offset, and stood up to its authored height. Nothing is placed by
// inference: an item appears exactly where an engineer put it, and if none were
// placed, nothing is drawn.
//
// Same coordinate mapping as the corridor mesh, and the same origin, because two
// meshes about different origins land in different places.

import { computeHorizontal } from "../kernel/horizontal";
import { computeVertical } from "../kernel/vertical";
import { heightOf, type RoadsideItem } from "../schema/roadside";
import type { RoadDesign } from "../schema/road-design";
import type { Point3 } from "../kernel/corridor";

export interface RoadsideGeometry {
  id: string;
  kind: RoadsideItem["kind"];
  /** Triangles for a barrier or rail: a vertical ribbon. Empty for a marking. */
  positions: number[];
  indices: number[];
  /** Polyline for a marking, or the top rail of a barrier. */
  line: number[];
  /** Dashes are emitted as separate segments so the gaps are real. */
  dashed: boolean;
}

/** Station step when sweeping, ft. Fine enough to follow a curve without waste. */
const STEP_FT = 10;

export function buildRoadsideGeometry(
  design: RoadDesign,
  origin: Point3,
): RoadsideGeometry[] {
  const items = design.roadside ?? [];
  if (items.length === 0) return [];

  const h = computeHorizontal(design.alignment);
  const v = computeVertical(design.profile);
  const begin = design.alignment.beginStation;
  const toThree = (e: number, n: number, z: number): [number, number, number] =>
    [e - origin.e, z - origin.z, -(n - origin.n)];

  const out: RoadsideGeometry[] = [];
  for (const item of items) {
    const from = Math.max(begin, item.beginStation);
    const to = Math.min(begin + h.length, item.endStation);
    if (!(to > from)) continue;

    const steps = Math.max(1, Math.ceil((to - from) / STEP_FT));
    const height = heightOf(item);
    const dashed = item.kind === "pavement-marking" && item.pattern === "dashed";

    const positions: number[] = [];
    const indices: number[] = [];
    const line: number[] = [];

    for (let i = 0; i <= steps; i += 1) {
      const station = from + ((to - from) * i) / steps;
      const dist = station - begin;
      const p = h.pointAt(dist);
      const az = (h.azimuthAt(dist) + (item.side === "left" ? -90 : 90)) * (Math.PI / 180);
      const e = p.e + item.offsetFt * Math.sin(az);
      const n = p.n + item.offsetFt * Math.cos(az);
      const zBase = v.elevationAt(station);

      // A dash is 10 ft painted, 30 ft blank -- the ordinary broken-line cycle.
      // Emitting the gaps as real breaks means the pattern is visible rather than
      // implied by a texture nobody authored.
      const inDash = !dashed || (station - from) % 40 < 10;

      if (item.kind === "pavement-marking") {
        if (inDash) line.push(...toThree(e, n, zBase + 0.05));
        else if (line.length > 0) { out.push({ id: item.id, kind: item.kind, positions: [], indices: [], line: line.slice(), dashed }); line.length = 0; }
        continue;
      }

      const base = positions.length / 3;
      positions.push(...toThree(e, n, zBase), ...toThree(e, n, zBase + height));
      line.push(...toThree(e, n, zBase + height));
      if (i > 0) {
        const a = base - 2, b = base - 1, c = base, d = base + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    if (item.kind === "pavement-marking") {
      if (line.length >= 6) out.push({ id: item.id, kind: item.kind, positions: [], indices: [], line, dashed });
    } else {
      out.push({ id: item.id, kind: item.kind, positions, indices, line, dashed });
    }
  }
  return out;
}
