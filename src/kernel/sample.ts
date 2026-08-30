// Sampling utilities — turn kernel results into point series for previews
// (SVG plan/profile sketches, and later the 3D viewer). Pure functions.

import { computeHorizontal } from "./horizontal";
import { computeVertical } from "./vertical";
import type { HorizontalAlignment, PointEN, VerticalProfile } from "../schema/road-design";

export interface ProfilePoint {
  station: number;
  elevation: number;
}

/** Sample the alignment into `intervals + 1` plan-view points. */
export function sampleAlignment(a: HorizontalAlignment, intervals: number): PointEN[] {
  const h = computeHorizontal(a);
  const pts: PointEN[] = [];
  for (let i = 0; i <= intervals; i++) {
    pts.push(h.pointAt((h.length * i) / intervals));
  }
  return pts;
}

/** Sample the profile across its full PVI range into `intervals + 1` points. */
export function sampleProfile(p: VerticalProfile, intervals: number): ProfilePoint[] {
  const v = computeVertical(p);
  const from = p.pvis[0]!.station;
  const to = p.pvis[p.pvis.length - 1]!.station;
  const pts: ProfilePoint[] = [];
  for (let i = 0; i <= intervals; i++) {
    const station = from + ((to - from) * i) / intervals;
    pts.push({ station, elevation: v.elevationAt(station) });
  }
  return pts;
}
