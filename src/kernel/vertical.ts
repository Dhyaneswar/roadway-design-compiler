// Vertical profile kernel — pure functions, no I/O.
// Symmetric parabolic vertical curves through PVIs.
// Curve elevation: y(x) = yPVC + (g1/100)·x + ((g2−g1)/100)/(2L)·x², x from PVC.

import type { VerticalProfile } from "../schema/road-design";

export interface VerticalCurveReport {
  pviStation: number;
  pviElevation: number;
  length: number;
  pvcStation: number;
  pvcElevation: number;
  pvtStation: number;
  pvtElevation: number;
  /** Entry grade, percent */
  g1Percent: number;
  /** Exit grade, percent */
  g2Percent: number;
  /** Rate of vertical curvature K = L/|A|, ft per percent grade change */
  K: number;
}

export interface HighLowPoint {
  station: number;
  elevation: number;
  kind: "high" | "low";
}

export interface VerticalResult {
  curves: VerticalCurveReport[];
  highLowPoints: HighLowPoint[];
  elevationAt(station: number): number;
  /** Instantaneous grade, percent */
  gradeAt(station: number): number;
}

export function computeVertical(p: VerticalProfile): VerticalResult {
  const pvis = p.pvis;
  if (pvis.length < 2) throw new Error("profile needs at least 2 PVIs");
  for (let i = 1; i < pvis.length; i++) {
    if (pvis[i]!.station <= pvis[i - 1]!.station) {
      throw new Error("PVIs must be in increasing station order");
    }
  }

  // Grade (percent) of the tangent leaving PVI i toward PVI i+1.
  const grade = (i: number) => {
    const a = pvis[i]!;
    const b = pvis[i + 1]!;
    return ((b.elevation - a.elevation) / (b.station - a.station)) * 100;
  };

  const curves: VerticalCurveReport[] = [];
  for (let i = 1; i < pvis.length - 1; i++) {
    const pvi = pvis[i]!;
    const L = pvi.curveLength ?? 0;
    if (L <= 0) continue;
    const g1 = grade(i - 1);
    const g2 = grade(i);
    const pvcStation = pvi.station - L / 2;
    const pvtStation = pvi.station + L / 2;
    curves.push({
      pviStation: pvi.station,
      pviElevation: pvi.elevation,
      length: L,
      pvcStation,
      pvcElevation: pvi.elevation - (g1 / 100) * (L / 2),
      pvtStation,
      pvtElevation: pvi.elevation + (g2 / 100) * (L / 2),
      g1Percent: g1,
      g2Percent: g2,
      K: g1 === g2 ? Infinity : L / Math.abs(g2 - g1),
    });
  }

  function curveElevation(c: VerticalCurveReport, station: number): number {
    const x = station - c.pvcStation;
    const r = (c.g2Percent - c.g1Percent) / 100 / (2 * c.length);
    return c.pvcElevation + (c.g1Percent / 100) * x + r * x * x;
  }

  function curveGrade(c: VerticalCurveReport, station: number): number {
    const x = station - c.pvcStation;
    return c.g1Percent + ((c.g2Percent - c.g1Percent) / c.length) * x;
  }

  function elevationAt(station: number): number {
    for (const c of curves) {
      if (station >= c.pvcStation && station <= c.pvtStation) {
        return curveElevation(c, station);
      }
    }
    // On a tangent: interpolate between bounding PVIs.
    for (let i = 0; i < pvis.length - 1; i++) {
      const a = pvis[i]!;
      const b = pvis[i + 1]!;
      if (station >= a.station && station <= b.station) {
        return a.elevation + ((grade(i) / 100) * (station - a.station));
      }
    }
    throw new RangeError(`station ${station} outside profile`);
  }

  function gradeAt(station: number): number {
    for (const c of curves) {
      if (station >= c.pvcStation && station <= c.pvtStation) {
        return curveGrade(c, station);
      }
    }
    for (let i = 0; i < pvis.length - 1; i++) {
      if (station >= pvis[i]!.station && station <= pvis[i + 1]!.station) {
        return grade(i);
      }
    }
    throw new RangeError(`station ${station} outside profile`);
  }

  const highLowPoints: HighLowPoint[] = [];
  for (const c of curves) {
    // Grade crosses zero inside the curve only when g1 and g2 oppose signs.
    if (c.g1Percent * c.g2Percent < 0) {
      const x = (c.g1Percent * c.length) / (c.g1Percent - c.g2Percent);
      const station = c.pvcStation + x;
      highLowPoints.push({
        station,
        elevation: curveElevation(c, station),
        kind: c.g1Percent > 0 ? "high" : "low",
      });
    }
  }

  return { curves, highLowPoints, elevationAt, gradeAt };
}
