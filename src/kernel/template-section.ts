// Template cross-section math — pure. One side of a typical section as
// cumulative (offset, Δz) points outward from the centerline. Used by the
// corridor sweep and by the studio's template preview.

import type { TemplateSegment } from "../schema/road-design";

export interface SectionOffset {
  name: string;
  /** Horizontal offset from centerline, ft (positive outward) */
  offset: number;
  /** Elevation delta from the centerline point, ft */
  dz: number;
}

export function sectionOffsets(segments: TemplateSegment[]): SectionOffset[] {
  const out: SectionOffset[] = [];
  let offset = 0;
  let dz = 0;
  for (const seg of segments) {
    offset += seg.width;
    dz += (seg.slopePercent / 100) * seg.width;
    out.push({ name: seg.name, offset, dz });
  }
  return out;
}
