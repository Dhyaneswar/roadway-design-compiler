import { describe, expect, it } from "vitest";
import {
  defaultSideFriction,
  judgeCurveRadius,
  judgeGrade,
  judgeVerticalCurveK,
  minimumCrestK,
  minimumRadiusFt,
  minimumSagK,
  stoppingSightDistanceFt,
} from "../src/kernel/criteria";
import type { VerticalCurveReport } from "../src/kernel/vertical";

// The point of these tests is to prove the RELATIONSHIPS are right, using
// externally known results, without transcribing anyone's table into the repo.

describe("minimum radius", () => {
  it("reproduces the well-known 45 mph / e=6% / f=0.15 result of ~643 ft", () => {
    // R = V^2 / (15(e+f)) = 2025 / (15 * 0.21) = 642.857...
    const r = minimumRadiusFt({ designSpeedMph: 45, emax: 0.06, sideFriction: 0.15 });
    expect(r).toBeCloseTo(642.86, 1);
  });

  it("reproduces 55 mph / e=6% / f=0.13 as ~1061 ft", () => {
    const r = minimumRadiusFt({ designSpeedMph: 55, emax: 0.06, sideFriction: 0.13 });
    expect(r).toBeCloseTo(1061.0, 0);
  });

  it("is agency-configurable: a higher emax permits a tighter curve", () => {
    const at6 = minimumRadiusFt({ designSpeedMph: 60, emax: 0.06, sideFriction: 0.12 });
    const at8 = minimumRadiusFt({ designSpeedMph: 60, emax: 0.08, sideFriction: 0.12 });
    expect(at8).toBeLessThan(at6);
  });

  it("returns Infinity rather than a negative radius when e+f is non-positive", () => {
    expect(minimumRadiusFt({ designSpeedMph: 45, emax: -0.2, sideFriction: 0.1 })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("default side friction", () => {
  it("falls with speed and stays inside the published envelope", () => {
    const slow = defaultSideFriction(25);
    const fast = defaultSideFriction(70);
    expect(slow).toBeGreaterThan(fast);
    expect(fast).toBeGreaterThanOrEqual(0.08);
    expect(slow).toBeLessThanOrEqual(0.19);
  });

  it("clamps outside its fitted range instead of extrapolating nonsense", () => {
    expect(defaultSideFriction(5)).toBeLessThanOrEqual(0.19);
    expect(defaultSideFriction(200)).toBeGreaterThanOrEqual(0.08);
  });
});

describe("stopping sight distance", () => {
  it("reproduces the standard 60 mph value of about 570 ft", () => {
    // 1.47*60*2.5 + 3600/(30*(11.2/32.2)) = 220.5 + 345.1
    const s = stoppingSightDistanceFt({ designSpeedMph: 60, emax: 0.06 });
    expect(s).toBeCloseTo(565.6, 0);
  });

  it("grows with reaction time", () => {
    const base = stoppingSightDistanceFt({ designSpeedMph: 50, emax: 0.06 });
    const slow = stoppingSightDistanceFt({ designSpeedMph: 50, emax: 0.06, reactionTimeS: 3.5 });
    expect(slow).toBeGreaterThan(base);
  });
});

describe("K criteria", () => {
  it("requires a longer crest than sag curve at the same speed", () => {
    const basis = { designSpeedMph: 55, emax: 0.06 };
    expect(minimumCrestK(basis)).toBeGreaterThan(minimumSagK(basis));
  });

  it("scales with the square of sight distance", () => {
    const slow = minimumCrestK({ designSpeedMph: 30, emax: 0.06 });
    const fast = minimumCrestK({ designSpeedMph: 60, emax: 0.06 });
    expect(fast).toBeGreaterThan(slow * 2);
  });
});

const curve = (over: Partial<VerticalCurveReport>): VerticalCurveReport => ({
  pviStation: 2500, pviElevation: 880, length: 600,
  pvcStation: 2200, pvcElevation: 874, pvtStation: 2800, pvtElevation: 874,
  g1Percent: 2, g2Percent: -2, K: 150,
  ...over,
});

describe("verdicts", () => {
  it("passes a generous radius and names the basis it used", () => {
    const v = judgeCurveRadius(1500, "curve 1", { designSpeedMph: 45, emax: 0.06, sideFriction: 0.15 });
    expect(v.status).toBe("pass");
    expect(v.required).toBeCloseTo(642.86, 1);
    expect(v.basis).toContain("R = V^2");
  });

  it("fails a tight radius and reports how far short it is", () => {
    const v = judgeCurveRadius(400, "curve 2", { designSpeedMph: 45, emax: 0.06, sideFriction: 0.15 });
    expect(v.status).toBe("fail");
    expect(v.detail).toContain("BELOW");
    expect(v.required - v.actual).toBeCloseTo(242.86, 1);
  });

  it("classifies a falling grade change as a crest", () => {
    const v = judgeVerticalCurveK(curve({ g1Percent: 2, g2Percent: -2 }), "PVI 2",
      { designSpeedMph: 45, emax: 0.06 });
    expect(v.check).toBe("minimum-crest-k");
  });

  it("classifies a rising grade change as a sag", () => {
    const v = judgeVerticalCurveK(curve({ g1Percent: -2, g2Percent: 1 }), "PVI 3",
      { designSpeedMph: 45, emax: 0.06 });
    expect(v.check).toBe("minimum-sag-k");
  });

  it("tells the agent the curve length that would comply", () => {
    const v = judgeVerticalCurveK(curve({ K: 5, g1Percent: 3, g2Percent: -3 }), "PVI 2",
      { designSpeedMph: 55, emax: 0.06 });
    expect(v.status).toBe("fail");
    expect(v.detail).toMatch(/lengthen the curve to about [\d.]+ ft/);
  });

  it("judges grade against a supplied maximum, not a hardcoded one", () => {
    const strict = judgeGrade(7, "PVI 2", { designSpeedMph: 45, emax: 0.06, maxGradePercent: 6 });
    const lax = judgeGrade(7, "PVI 2", { designSpeedMph: 45, emax: 0.06, maxGradePercent: 8 });
    expect(strict.status).toBe("fail");
    expect(lax.status).toBe("pass");
  });

  it("treats a negative grade by magnitude", () => {
    const v = judgeGrade(-9, "PVI 4", { designSpeedMph: 45, emax: 0.06, maxGradePercent: 8 });
    expect(v.status).toBe("fail");
    expect(v.actual).toBe(9);
  });
});
