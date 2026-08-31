// As-designed cross sections → mesh.
//
// The file's own sections are (station, offset, elevation) triples. Placing them
// in the world needs the alignment: station gives a point and a bearing, offset
// steps perpendicular from it. That is the same conversion the roadside furniture
// uses, and the same origin as the corridor, because meshes about different
// origins land in different places.
//
// ⚠ Left and right runs are separate in the file and stay separate here. Bridging
// them would invent a centreline the file never stated.

import { computeHorizontal } from "../kernel/horizontal";
import type { DesignSectionSurface } from "../importers/design-sections";
import type { HorizontalAlignment } from "../schema/road-design";
import type { Point3 } from "../kernel/corridor";

export interface DesignSectionMesh {
  name: string;
  positions: number[];
  indices: number[];
}

export function buildDesignSectionMesh(
  surface: DesignSectionSurface,
  alignment: HorizontalAlignment,
  origin: Point3,
): DesignSectionMesh {
  const h = computeHorizontal(alignment);
  const begin = alignment.beginStation;
  const positions: number[] = [];
  const indices: number[] = [];

  // One strip per side, stitched only between consecutive stations that carry the
  // same number of points -- a section that gains a point is a real discontinuity.
  for (const side of ["left", "right"] as const) {
    const runs = surface.runs
      .filter((r) => r.side === side)
      .sort((a, b) => a.stationFt - b.stationFt);

    let prevBase = -1;
    let prevCount = -1;
    for (const run of runs) {
      const dist = run.stationFt - begin;
      if (dist < 0 || dist > h.length) { prevBase = -1; prevCount = -1; continue; }
      const p = h.pointAt(dist);
      const az = h.azimuthAt(dist) * (Math.PI / 180);
      // Perpendicular: +90 deg from the bearing. The file's offset carries its own
      // sign, so one perpendicular serves both sides.
      const ue = Math.sin(az + Math.PI / 2);
      const un = Math.cos(az + Math.PI / 2);

      const base = positions.length / 3;
      for (const pt of run.points) {
        const e = p.e + pt.offsetFt * ue;
        const n = p.n + pt.offsetFt * un;
        positions.push(e - origin.e, pt.elevationFt - origin.z, -(n - origin.n));
      }
      if (prevBase >= 0 && prevCount === run.points.length) {
        for (let j = 0; j < run.points.length - 1; j += 1) {
          const a = prevBase + j, b = base + j;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      prevBase = base;
      prevCount = run.points.length;
    }
  }
  return { name: surface.name, positions, indices };
}
