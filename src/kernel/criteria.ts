// Design-criteria verdicts.
//
// The kernel computes geometry. This module JUDGES that geometry against a design
// speed and returns a verdict per check, with the governing value and the value
// that would comply. It is what turns "here is your curve table" into "curve 2 is
// 140 ft under the minimum radius for 45 mph".
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO LOOKUP TABLE HERE, AND WHY THAT IS THE RIGHT DESIGN
// ---------------------------------------------------------------------------
// Minimum-radius and K-value tables are published in the AASHTO Green Book, a
// copyrighted commercial standard. Transcribing them would make this repository
// a redistribution of protected values.
//
// So nothing is transcribed. Every criterion is COMPUTED from the underlying
// engineering relationship, and every coefficient those relationships need --
// side friction, driver reaction time, deceleration, eye and object heights --
// is an INPUT with a documented default. An agency that adopts different values
// supplies its own and gets its own answers.
//
// That is not a workaround. It is how a design tool should behave: it applies
// the engineering, and cites the authority, rather than shipping a copy of it.
// The defaults below are the widely published customary-units values used for
// illustration. ⛔ They are NOT an adopted agency standard, and this module
// never claims they are -- every verdict carries the basis it used.

import type { VerticalCurveReport } from "./vertical";

/** Coefficients a criteria check needs. All overridable per agency. */
export interface CriteriaBasis {
  /** Design speed, mph. */
  designSpeedMph: number;
  /** Maximum superelevation rate, as a decimal (0.06 = 6%). */
  emax: number;
  /**
   * Side friction factor at the design speed. Defaults follow the customary
   * published curve, which falls with speed.
   */
  sideFriction?: number;
  /** Driver perception-reaction time, seconds. */
  reactionTimeS?: number;
  /** Deceleration rate, ft/s^2. */
  decelerationFtS2?: number;
  /** Driver eye height, ft. */
  eyeHeightFt?: number;
  /** Object height, ft. */
  objectHeightFt?: number;
  /** Maximum grade, percent. */
  maxGradePercent?: number;
}

export interface Verdict {
  /** Machine-stable check id. */
  check: string;
  /** "pass" | "fail" | "not-evaluated" -- never a bare boolean. */
  status: "pass" | "fail" | "not-evaluated";
  /** What was measured. */
  subject: string;
  /** The value the design has. */
  actual: number;
  /** The value the criterion requires. */
  required: number;
  /** Units of both, so an agent never has to guess. */
  unit: string;
  /** One sentence. */
  detail: string;
  /** How `required` was arrived at -- the relationship, not a page reference. */
  basis: string;
}

/**
 * Side friction factor by design speed, customary units.
 * Interpolated from the published curve shape rather than a transcribed table:
 * f falls roughly linearly from 0.19 at 20 mph to 0.08 at 80 mph.
 */
export function defaultSideFriction(speedMph: number): number {
  const f = 0.19 - ((speedMph - 20) * (0.19 - 0.08)) / 60;
  return Math.max(0.08, Math.min(0.19, Number(f.toFixed(4))));
}

/**
 * Minimum radius from the point-mass relationship:
 *   R_min = V^2 / (15 * (e + f))
 * V in mph, e and f as decimals, R in feet. This is the governing equation, not
 * a table lookup, so it holds for any agency's e and f.
 */
export function minimumRadiusFt(basis: CriteriaBasis): number {
  const f = basis.sideFriction ?? defaultSideFriction(basis.designSpeedMph);
  const denom = 15 * (basis.emax + f);
  if (denom <= 0) return Number.POSITIVE_INFINITY;
  return (basis.designSpeedMph * basis.designSpeedMph) / denom;
}

/**
 * Stopping sight distance:
 *   SSD = 1.47*V*t + V^2 / (30 * (a/32.2))
 * on a level grade. V mph, t seconds, a ft/s^2, SSD feet.
 */
export function stoppingSightDistanceFt(basis: CriteriaBasis): number {
  const t = basis.reactionTimeS ?? 2.5;
  const a = basis.decelerationFtS2 ?? 11.2;
  const V = basis.designSpeedMph;
  return 1.47 * V * t + (V * V) / (30 * (a / 32.2));
}

/**
 * Minimum crest K for stopping sight distance, for the S < L case:
 *   K = S^2 / (100 * (sqrt(h1) + sqrt(h2))^2)
 */
export function minimumCrestK(basis: CriteriaBasis): number {
  const S = stoppingSightDistanceFt(basis);
  const h1 = basis.eyeHeightFt ?? 3.5;
  const h2 = basis.objectHeightFt ?? 2.0;
  const denom = 100 * Math.pow(Math.sqrt(h1) + Math.sqrt(h2), 2);
  return (S * S) / denom;
}

/**
 * Minimum sag K for headlight sight distance, for the S < L case:
 *   K = S^2 / (400 + 3.5*S)
 * (headlight height 2.0 ft, 1 degree upward divergence.)
 */
export function minimumSagK(basis: CriteriaBasis): number {
  const S = stoppingSightDistanceFt(basis);
  return (S * S) / (400 + 3.5 * S);
}

const round = (v: number, n = 2): number => Number(v.toFixed(n));

/** Judge one horizontal curve. */
export function judgeCurveRadius(
  radiusFt: number,
  subject: string,
  basis: CriteriaBasis,
): Verdict {
  const required = minimumRadiusFt(basis);
  const f = basis.sideFriction ?? defaultSideFriction(basis.designSpeedMph);
  return {
    check: "minimum-radius",
    status: radiusFt + 1e-9 >= required ? "pass" : "fail",
    subject,
    actual: round(radiusFt),
    required: round(required),
    unit: "ft",
    detail:
      radiusFt >= required
        ? `${subject} radius ${round(radiusFt)} ft meets the ${round(required)} ft minimum ` +
          `for ${basis.designSpeedMph} mph.`
        : `${subject} radius ${round(radiusFt)} ft is ${round(required - radiusFt)} ft BELOW the ` +
          `${round(required)} ft minimum for ${basis.designSpeedMph} mph.`,
    basis:
      `R = V^2 / (15(e + f)) with V=${basis.designSpeedMph} mph, e=${basis.emax}, f=${f}. ` +
      `Coefficients are inputs, not an adopted standard.`,
  };
}

/** Judge one vertical curve's K value. Crest and sag have different criteria. */
export function judgeVerticalCurveK(
  curve: VerticalCurveReport,
  subject: string,
  basis: CriteriaBasis,
): Verdict {
  const isCrest = curve.g2Percent < curve.g1Percent;
  const required = isCrest ? minimumCrestK(basis) : minimumSagK(basis);
  const S = stoppingSightDistanceFt(basis);
  const kind = isCrest ? "crest" : "sag";
  return {
    check: isCrest ? "minimum-crest-k" : "minimum-sag-k",
    status: curve.K + 1e-9 >= required ? "pass" : "fail",
    subject,
    actual: round(curve.K),
    required: round(required),
    unit: "K (ft per percent)",
    detail:
      curve.K >= required
        ? `${subject} ${kind} K=${round(curve.K)} meets the ${round(required)} minimum ` +
          `for ${basis.designSpeedMph} mph.`
        : `${subject} ${kind} K=${round(curve.K)} is below the ${round(required)} minimum ` +
          `for ${basis.designSpeedMph} mph; lengthen the curve to about ` +
          `${round(required * Math.abs(curve.g2Percent - curve.g1Percent))} ft.`,
    basis: isCrest
      ? `K = S^2 / (100(sqrt(h1)+sqrt(h2))^2) with SSD=${round(S)} ft, ` +
        `h1=${basis.eyeHeightFt ?? 3.5} ft, h2=${basis.objectHeightFt ?? 2.0} ft.`
      : `K = S^2 / (400 + 3.5S) with SSD=${round(S)} ft (headlight criterion).`,
  };
}

/** Judge a grade against the agency maximum. */
export function judgeGrade(gradePercent: number, subject: string, basis: CriteriaBasis): Verdict {
  const required = basis.maxGradePercent ?? 8;
  const actual = Math.abs(gradePercent);
  return {
    check: "maximum-grade",
    status: actual <= required + 1e-9 ? "pass" : "fail",
    subject,
    actual: round(actual),
    required: round(required),
    unit: "percent",
    detail:
      actual <= required
        ? `${subject} grade ${round(actual)}% is within the ${round(required)}% maximum.`
        : `${subject} grade ${round(actual)}% EXCEEDS the ${round(required)}% maximum.`,
    basis: `Agency maximum grade, supplied as an input (default ${required}%).`,
  };
}
