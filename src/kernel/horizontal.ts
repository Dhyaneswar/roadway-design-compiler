// Horizontal alignment kernel — pure functions, no I/O.
// Azimuth convention: degrees clockwise from north. de = sin(az), dn = cos(az).
// Arc geometry: for a RIGHT turn the center sits at heading+90°, the radial
// (center→point) sweeps clockwise; LEFT mirrors both.

import type { HorizontalAlignment, PointEN } from "../schema/road-design";

export interface CurveData {
  radius: number;
  deltaDeg: number;
  /** Arc length L = R·Δ, ft */
  length: number;
  /** Tangent distance T = R·tan(Δ/2), ft */
  tangentDistance: number;
  /** Long chord C = 2R·sin(Δ/2), ft */
  chord: number;
  /** External distance E = R·(sec(Δ/2) − 1), ft */
  external: number;
  /** Middle ordinate M = R·(1 − cos(Δ/2)), ft */
  middleOrdinate: number;
}

export interface ElementReport {
  type: "tangent" | "arc" | "deflection";
  /** Absolute station at element begin (beginStation + distance), ft */
  beginStation: number;
  /** Absolute station at element end, ft */
  endStation: number;
  /** Point at element begin */
  beginPoint: PointEN;
  /** Heading azimuth at element begin, deg */
  beginAzimuthDeg: number;
  /** Curve data for arcs */
  curve?: CurveData;
  /** Angle-point data for deflections */
  deflection?: {
    deflectionDeg: number;
    direction: "left" | "right";
    azimuthInDeg: number;
    azimuthOutDeg: number;
  };
}

export interface HorizontalResult {
  /** Total length along the alignment, ft */
  length: number;
  elements: ElementReport[];
  /** Point at a distance from the alignment start (not absolute station), ft */
  pointAt(distance: number): PointEN;
  /** Heading azimuth (deg clockwise from north) at a distance from the start */
  azimuthAt(distance: number): number;
}

const DEG = Math.PI / 180;

function ahead(p: PointEN, azDeg: number, dist: number): PointEN {
  const az = azDeg * DEG;
  return { e: p.e + dist * Math.sin(az), n: p.n + dist * Math.cos(az) };
}

interface Segment {
  report: ElementReport;
  length: number;
  pointAt(s: number): PointEN; // s = distance into this segment
  azimuthAt(s: number): number;
}

export function computeHorizontal(a: HorizontalAlignment): HorizontalResult {
  const segments: Segment[] = [];
  let point = { ...a.start };
  let azDeg = a.startAzimuthDeg;
  let distance = 0;

  for (const el of a.elements) {
    const begin = { ...point };
    const beginAz = azDeg;
    const beginStation = a.beginStation + distance;

    if (el.type === "deflection") {
      const sign = el.direction === "right" ? 1 : -1;
      const newAz = beginAz + sign * el.deflectionDeg;
      segments.push({
        length: 0,
        report: {
          type: "deflection",
          beginStation,
          endStation: beginStation,
          beginPoint: begin,
          beginAzimuthDeg: beginAz,
          deflection: {
            deflectionDeg: el.deflectionDeg,
            direction: el.direction,
            azimuthInDeg: beginAz,
            azimuthOutDeg: newAz,
          },
        },
        pointAt: () => begin,
        azimuthAt: () => newAz,
      });
      azDeg = newAz;
    } else if (el.type === "tangent") {
      const len = el.length;
      segments.push({
        length: len,
        report: {
          type: "tangent",
          beginStation,
          endStation: beginStation + len,
          beginPoint: begin,
          beginAzimuthDeg: beginAz,
        },
        pointAt: (s) => ahead(begin, beginAz, s),
        azimuthAt: () => beginAz,
      });
      point = ahead(begin, beginAz, len);
      distance += len;
    } else {
      const { radius, deltaDeg, direction } = el;
      const sign = direction === "right" ? 1 : -1;
      const len = radius * deltaDeg * DEG;
      // Center is perpendicular to the heading: +90° for right, −90° for left.
      const center = ahead(begin, beginAz + sign * 90, radius);
      // Radial from center back to the begin point.
      const radialAz0 = beginAz - sign * 90;
      // ⛔ Refuse rather than return a number nobody can use. The schema is the
      // gate for authored designs, but this function is exported and
      // alignmentRangeFromForm calls it on raw form values before validation.
      if (!(deltaDeg > 0) || deltaDeg >= 180) {
        throw new Error(
          `a circular curve must deflect more than 0 and less than 180 degrees ` +
          `(got ${deltaDeg}). At 180 the tangents are parallel and never meet.`,
        );
      }
      const half = (deltaDeg / 2) * DEG;
      const curve: CurveData = {
        radius,
        deltaDeg,
        length: len,
        tangentDistance: radius * Math.tan(half),
        chord: 2 * radius * Math.sin(half),
        external: radius * (1 / Math.cos(half) - 1),
        middleOrdinate: radius * (1 - Math.cos(half)),
      };
      segments.push({
        length: len,
        report: {
          type: "arc",
          beginStation,
          endStation: beginStation + len,
          beginPoint: begin,
          beginAzimuthDeg: beginAz,
          curve,
        },
        pointAt: (s) => {
          const sweptDeg = (s / radius) / DEG;
          return ahead(center, radialAz0 + sign * sweptDeg, radius);
        },
        azimuthAt: (s) => beginAz + sign * ((s / radius) / DEG),
      });
      point = ahead(center, radialAz0 + sign * deltaDeg, radius);
      azDeg = beginAz + sign * deltaDeg;
      distance += len;
    }
  }

  const total = distance;
  const EPS = 1e-9;

  function locate(d: number): { seg: Segment; s: number } {
    if (d < -EPS || d > total + EPS) {
      throw new RangeError(`distance ${d} outside alignment [0, ${total}]`);
    }
    let acc = 0;
    for (const seg of segments) {
      if (d <= acc + seg.length + EPS) return { seg, s: Math.max(0, d - acc) };
      acc += seg.length;
    }
    const last = segments[segments.length - 1]!;
    return { seg: last, s: last.length };
  }

  return {
    length: total,
    elements: segments.map((s) => s.report),
    pointAt: (d) => {
      const { seg, s } = locate(d);
      return seg.pointAt(s);
    },
    azimuthAt: (d) => {
      const { seg, s } = locate(d);
      return seg.azimuthAt(s);
    },
  };
}
