// Corridor kernel — sweeps cross-section templates along the alignment/profile
// over station ranges (template drops). Pure functions, no I/O.
// Offset convention: right of increasing stations = heading azimuth + 90°.

import { computeHorizontal } from "./horizontal";
import { computeVertical } from "./vertical";
import { sectionOffsets } from "./template-section";
import type { RoadDesign, SegmentMaterial, TemplateSegment } from "../schema/road-design";
import { crossSlopeAt, transitionFor,
  type SuperelevationTransition } from "./superelevation";

export interface Point3 {
  e: number;
  n: number;
  z: number;
}

export interface SectionPoint {
  /** Segment name from the template */
  name: string;
  /** Segment material, when the engineer stated one. */
  material?: SegmentMaterial;
  /** Horizontal offset from centerline, ft (positive outward) */
  offset: number;
  point: Point3;
}

export interface CrossSection {
  station: number;
  /** Name of the template that produced this section (drop lookup) */
  template: string;
  centerline: Point3;
  left: SectionPoint[];
  right: SectionPoint[];
}

export interface Corridor {
  sections: CrossSection[];
}

const DEG = Math.PI / 180;

function sidePoints(
  segments: TemplateSegment[],
  centerline: Point3,
  offsetAzimuthDeg: number,
): SectionPoint[] {
  const az = offsetAzimuthDeg * DEG;
  const ue = Math.sin(az);
  const un = Math.cos(az);
  return sectionOffsets(segments).map(({ name, offset, dz, material }) => ({
    name,
    ...(material ? { material } : {}),
    offset,
    point: {
      e: centerline.e + offset * ue,
      n: centerline.n + offset * un,
      z: centerline.z + dz,
    },
  }));
}

interface Solvers {
  h: ReturnType<typeof computeHorizontal>;
  v: ReturnType<typeof computeVertical>;
  /** Banking transitions, empty when the design declares no superelevation. */
  sup: readonly SuperelevationTransition[];
}

function lerpSegments(
  from: TemplateSegment[],
  to: TemplateSegment[],
  t: number,
): TemplateSegment[] {
  // Material does not interpolate -- it is a category, not a quantity. The
  // segment being tapered TO owns it, which is what a drop transition means.
  return to.map((seg, i) => ({
    name: seg.name,
    ...(seg.material ? { material: seg.material } : {}),
    width: from[i]!.width + (seg.width - from[i]!.width) * t,
    slopePercent: from[i]!.slopePercent + (seg.slopePercent - from[i]!.slopePercent) * t,
  }));
}

/** Effective section segments at a station within a drop — handles the taper
 *  (linear point-wise blend from the previous drop's template over the first
 *  transitionLength ft; validated by the schema to be adjacent + matching). */
function segmentsAt(
  design: RoadDesign,
  dropIndex: number,
  station: number,
): { left: TemplateSegment[]; right: TemplateSegment[] } {
  const drop = design.drops[dropIndex]!;
  const template = design.templates[drop.template];
  if (!template) throw new Error(`unknown template "${drop.template}"`);
  const L = drop.transitionLength ?? 0;
  if (L > 0 && station < drop.fromStation + L && dropIndex > 0) {
    const prev = design.templates[design.drops[dropIndex - 1]!.template]!;
    const t = (station - drop.fromStation) / L;
    return {
      left: lerpSegments(prev.left, template.left, t),
      right: lerpSegments(prev.right, template.right, t),
    };
  }
  return { left: template.left, right: template.right };
}


/** Superelevation transitions for every circular curve, or [] when the design
 *  declares no superelevation policy. Direction lives on the AUTHORED element
 *  (the computed report carries only curve magnitudes), so the two are zipped. */
function superTransitions(
  design: RoadDesign,
  h: ReturnType<typeof computeHorizontal>,
): SuperelevationTransition[] {
  const spec = design.superelevation;
  if (!spec) return [];
  const out: SuperelevationTransition[] = [];
  h.elements.forEach((report, i) => {
    if (report.type !== "arc" || report.curve === undefined) return;
    const authored = design.alignment.elements[i];
    const direction =
      authored !== undefined && "direction" in authored && authored.direction === "left"
        ? "left" as const
        : "right" as const;
    out.push(transitionFor({
      radiusFt: report.curve.radius,
      direction,
      pcStation: report.beginStation,
      ptStation: report.endStation,
    }, i, spec));
  });
  return out;
}

/** Apply the banked cross slopes to a section's segments. The whole section
 *  rotates (crown rotation about the centreline), which is what the 3D view
 *  and the cross-section readback both show. */
function bankSegments(
  segs: { left: TemplateSegment[]; right: TemplateSegment[] },
  design: RoadDesign,
  sup: readonly SuperelevationTransition[],
  station: number,
): { left: TemplateSegment[]; right: TemplateSegment[] } {
  const spec = design.superelevation;
  if (!spec || sup.length === 0) return segs;
  const cs = crossSlopeAt(station, sup, spec);
  return {
    left: segs.left.map((sg) => ({ ...sg, slopePercent: cs.leftPercent })),
    right: segs.right.map((sg) => ({ ...sg, slopePercent: cs.rightPercent })),
  };
}

function sectionFor(
  design: RoadDesign,
  { h, v, sup }: Solvers,
  dropIndex: number,
  station: number,
): CrossSection {
  const drop = design.drops[dropIndex]!;
  const segs = bankSegments(segmentsAt(design, dropIndex, station), design, sup, station);
  const distance = station - design.alignment.beginStation;
  const p = h.pointAt(distance);
  const azDeg = h.azimuthAt(distance);
  const centerline: Point3 = { e: p.e, n: p.n, z: v.elevationAt(station) };
  return {
    station,
    template: drop.template,
    centerline,
    left: sidePoints(segs.left, centerline, azDeg - 90),
    right: sidePoints(segs.right, centerline, azDeg + 90),
  };
}

export function crossSectionAt(design: RoadDesign, station: number): CrossSection {
  const index = design.drops.findIndex(
    (d) => station >= d.fromStation && station <= d.toStation,
  );
  if (index < 0) throw new RangeError(`no template drop covers station ${station}`);
  const h = computeHorizontal(design.alignment);
  const solvers: Solvers = { h, v: computeVertical(design.profile), sup: superTransitions(design, h) };
  return sectionFor(design, solvers, index, station);
}

export function computeCorridor(design: RoadDesign, intervalFt: number): Corridor {
  if (intervalFt <= 0) throw new RangeError("interval must be positive");
  // Each drop sweeps with ITS OWN template — a station shared by two drops
  // belongs to both, once per template, so the change lands exactly at the
  // drop boundary. (Solvers computed once: pointAt/elevationAt are pure.)
  const h = computeHorizontal(design.alignment);
  const solvers: Solvers = { h, v: computeVertical(design.profile), sup: superTransitions(design, h) };
  const sections: CrossSection[] = [];
  const EPS = 1e-9;
  design.drops.forEach((drop, i) => {
    let station = drop.fromStation;
    while (station < drop.toStation - EPS) {
      sections.push(sectionFor(design, solvers, i, station));
      station += intervalFt;
    }
    sections.push(sectionFor(design, solvers, i, drop.toStation));
  });
  return { sections };
}
