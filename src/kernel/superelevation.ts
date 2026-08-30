// Superelevation — banking the roadway through horizontal curves.
//
// A vehicle on a curve needs the pavement tilted toward the inside so that a
// component of gravity supplies part of the centripetal force. How much tilt,
// and how you get into and out of it, is one of the defining computations of
// roadway geometric design.
//
// Sign convention follows template-section.ts: slopePercent accumulates outward
// from the centreline, so a NEGATIVE slope falls away from the centreline. At
// normal crown both sides are negative. At full superelevation the whole section
// tilts toward the inside of the curve: the OUTSIDE side becomes positive
// (rising outward) and the INSIDE side stays negative and steepens.
//
// As in criteria.ts, nothing here is a transcribed table. The superelevation
// rate comes from the same point-mass relationship used for minimum radius, and
// the runoff length comes from the maximum-relative-gradient relationship. Every
// coefficient is an input with a documented, illustrative default.

import { defaultSideFriction } from "./criteria";

export interface SuperelevationBasis {
  /** Design speed, mph. */
  designSpeedMph: number;
  /** Maximum superelevation rate as a decimal, e.g. 0.06. */
  emax: number;
  /** Normal crown cross slope, percent, as a POSITIVE magnitude (2 = -2% each side). */
  normalCrownPercent?: number;
  /** Side friction factor; defaults to the fitted curve in criteria.ts. */
  sideFriction?: number;
  /** Width of one rotated lane, ft. */
  laneWidthFt?: number;
  /** Number of lanes rotated about the pivot on the critical side. */
  lanesRotated?: number;
  /**
   * Maximum relative gradient between the pavement edge and the axis of
   * rotation, percent. Falls with design speed; default is a fitted curve.
   */
  maxRelativeGradientPercent?: number;
  /** Adjustment factor for number of lanes rotated. */
  laneAdjustmentFactor?: number;
}

export type SuperPhase =
  | "normal-crown"
  | "tangent-runout"
  | "superelevation-runoff"
  | "full-superelevation";

export interface SuperelevationTransition {
  curveIndex: number;
  /** "left" or "right" — the direction the curve turns. */
  direction: "left" | "right";
  radiusFt: number;
  /** Full superelevation rate for this curve, percent. */
  fullSuperPercent: number;
  runoffLengthFt: number;
  tangentRunoutFt: number;
  /** Station landmarks, in increasing order. */
  ncEndStation: number;
  runoffStartStation: number;
  pcStation: number;
  ptStation: number;
  exitRunoffEndStation: number;
  ncResumeStation: number;
}

export interface CrossSlopeAtStation {
  station: number;
  phase: SuperPhase;
  /** Cross slope of the LEFT side, percent (outward-accumulating convention). */
  leftPercent: number;
  /** Cross slope of the RIGHT side, percent. */
  rightPercent: number;
  /** Which transition produced it, if any. */
  curveIndex?: number;
}


/**
 * Maximum relative gradient, percent, by design speed. Fitted to the published
 * shape (about 0.78% at 15 mph falling to about 0.35% at 80 mph) rather than
 * transcribed, and overridable.
 */
export function defaultMaxRelativeGradient(speedMph: number): number {
  const g = 0.78 - ((speedMph - 15) * (0.78 - 0.35)) / 65;
  return Math.max(0.35, Math.min(0.78, Number(g.toFixed(4))));
}

/**
 * Superelevation rate for a curve, percent.
 *
 * From the same point-mass relationship as the minimum radius:
 *   e = V^2 / (15 R) - f
 * clamped between normal crown (a flat curve needs no banking) and emax.
 */
export function superelevationRateFor(
  radiusFt: number,
  basis: SuperelevationBasis,
): number {
  if (!Number.isFinite(radiusFt) || radiusFt <= 0) return 0;
  const nc = basis.normalCrownPercent ?? 2;
  const f = basis.sideFriction ?? defaultSideFriction(basis.designSpeedMph);
  const V = basis.designSpeedMph;
  const eDecimal = (V * V) / (15 * radiusFt) - f;
  const ePercent = eDecimal * 100;
  if (ePercent <= nc) return nc; // flat enough to stay at normal crown
  return Number(Math.min(ePercent, basis.emax * 100).toFixed(4));
}

/**
 * Superelevation runoff length, ft:
 *   Lr = (w * n * ed) / delta * bw
 * w lane width, n lanes rotated, ed design rate (percent), delta maximum
 * relative gradient (percent), bw lane adjustment factor.
 */
export function runoffLengthFt(ePercent: number, basis: SuperelevationBasis): number {
  const w = basis.laneWidthFt ?? 12;
  const n = basis.lanesRotated ?? 1;
  const bw = basis.laneAdjustmentFactor ?? 1;
  const delta = basis.maxRelativeGradientPercent
    ?? defaultMaxRelativeGradient(basis.designSpeedMph);
  if (delta <= 0) return 0;
  return Number(((w * n * ePercent) / delta * bw).toFixed(3));
}

/**
 * Tangent runout, ft — the length to rotate the outside lane from normal crown
 * to zero cross slope, at the same relative gradient:
 *   Lt = (eNC / ed) * Lr
 */
export function tangentRunoutFt(
  ePercent: number,
  runoff: number,
  basis: SuperelevationBasis,
): number {
  const nc = basis.normalCrownPercent ?? 2;
  if (ePercent <= 0) return 0;
  return Number(((nc / ePercent) * runoff).toFixed(3));
}

export interface CurveGeometryForSuper {
  radiusFt: number;
  direction: "left" | "right";
  pcStation: number;
  ptStation: number;
}

/**
 * Build the transition for one curve.
 *
 * Placement convention, stated because it is a design choice and agencies
 * differ: full superelevation is achieved AT the PC and held to the PT, with
 * the runoff immediately preceding the PC and the runout preceding that. The
 * exit mirrors it.
 */
export function transitionFor(
  curve: CurveGeometryForSuper,
  curveIndex: number,
  basis: SuperelevationBasis,
): SuperelevationTransition {
  const e = superelevationRateFor(curve.radiusFt, basis);
  const lr = runoffLengthFt(e, basis);
  const lt = tangentRunoutFt(e, lr, basis);
  return {
    curveIndex,
    direction: curve.direction,
    radiusFt: curve.radiusFt,
    fullSuperPercent: e,
    runoffLengthFt: lr,
    tangentRunoutFt: lt,
    ncEndStation: curve.pcStation - lr - lt,
    runoffStartStation: curve.pcStation - lr,
    pcStation: curve.pcStation,
    ptStation: curve.ptStation,
    exitRunoffEndStation: curve.ptStation + lr,
    ncResumeStation: curve.ptStation + lr + lt,
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const round4 = (v: number): number => Number(v.toFixed(4));

/**
 * Cross slopes at a station, given the transitions.
 *
 * Outside/inside are assigned from the turn direction: a RIGHT-hand curve banks
 * with the LEFT side outside (rising) and the RIGHT side inside.
 */
export function crossSlopeAt(
  station: number,
  transitions: readonly SuperelevationTransition[],
  basis: SuperelevationBasis,
): CrossSlopeAtStation {
  const nc = basis.normalCrownPercent ?? 2;
  const normal: CrossSlopeAtStation = {
    station, phase: "normal-crown", leftPercent: -nc, rightPercent: -nc,
  };

  for (const t of transitions) {
    if (station < t.ncEndStation || station > t.ncResumeStation) continue;

    // How far through the rotation are we? 0 = normal crown, 1 = full super.
    let outsideSlope: number;
    let insideSlope: number;
    let phase: SuperPhase;

    const inRunout =
      (station >= t.ncEndStation && station < t.runoffStartStation) ||
      (station > t.exitRunoffEndStation && station <= t.ncResumeStation);
    const inRunoff =
      (station >= t.runoffStartStation && station < t.pcStation) ||
      (station > t.ptStation && station <= t.exitRunoffEndStation);

    if (station >= t.pcStation && station <= t.ptStation) {
      phase = "full-superelevation";
      outsideSlope = t.fullSuperPercent;
      insideSlope = -t.fullSuperPercent;
    } else if (inRunoff) {
      phase = "superelevation-runoff";
      // Outside rotates 0 -> +e; inside rotates -nc -> -e.
      const f =
        station < t.pcStation
          ? (station - t.runoffStartStation) / Math.max(t.runoffLengthFt, 1e-9)
          : 1 - (station - t.ptStation) / Math.max(t.runoffLengthFt, 1e-9);
      outsideSlope = lerp(0, t.fullSuperPercent, f);
      insideSlope = lerp(-nc, -t.fullSuperPercent, f);
    } else if (inRunout) {
      phase = "tangent-runout";
      // Outside rotates -nc -> 0; inside holds normal crown.
      const f =
        station < t.pcStation
          ? (station - t.ncEndStation) / Math.max(t.tangentRunoutFt, 1e-9)
          : 1 - (station - t.exitRunoffEndStation) / Math.max(t.tangentRunoutFt, 1e-9);
      outsideSlope = lerp(-nc, 0, f);
      insideSlope = -nc;
    } else {
      continue;
    }

    const left = t.direction === "right" ? outsideSlope : insideSlope;
    const right = t.direction === "right" ? insideSlope : outsideSlope;
    return {
      station, phase,
      leftPercent: round4(left),
      rightPercent: round4(right),
      curveIndex: t.curveIndex,
    };
  }
  return normal;
}
