import { describe, test, expect } from "vitest";
import { computeVertical } from "../src/kernel/vertical";
import type { VerticalProfile } from "../src/schema/road-design";

// Golden example V-1 (hand-computed, classic crest curve):
// PVI list: (8+00, 96.00) → (13+00, 106.00, L=600) → (17+00, 94.00)
// g1 = (106−96)/500 = +2.00%; g2 = (94−106)/400 = −3.00%; A = −5.
// PVC = 10+00 @ 100.00; PVT = 16+00 @ 97.00.
// Curve elev: y(x) = 100 + 0.02x − (0.05/1200)x², x from PVC.
//   y(300) = 102.25 (under the PVI).
//   High point at x = g1·L/(g1−g2) = 0.02·600/0.05 = 240 → sta 12+40, elev 102.40.
// K = L/|A| = 600/5 = 120.
const crest: VerticalProfile = {
  pvis: [
    { station: 800, elevation: 96 },
    { station: 1300, elevation: 106, curveLength: 600 },
    { station: 1700, elevation: 94 },
  ],
};

describe("computeVertical: crest curve V-1", () => {
  const v = computeVertical(crest);

  test("elevation on entry grade before the curve", () => {
    expect(v.elevationAt(900)).toBeCloseTo(98.0, 9);
  });

  test("elevation at PVC is on the entry grade", () => {
    expect(v.elevationAt(1000)).toBeCloseTo(100.0, 9);
  });

  test("elevation at PVI station is below the PVI by E", () => {
    expect(v.elevationAt(1300)).toBeCloseTo(102.25, 9);
  });

  test("elevation at PVT returns to the exit grade", () => {
    expect(v.elevationAt(1600)).toBeCloseTo(97.0, 9);
  });

  test("elevation on exit grade after the curve", () => {
    expect(v.elevationAt(1700)).toBeCloseTo(94.0, 9);
  });

  test("high point station and elevation", () => {
    expect(v.highLowPoints).toHaveLength(1);
    expect(v.highLowPoints[0]!.station).toBeCloseTo(1240, 6);
    expect(v.highLowPoints[0]!.elevation).toBeCloseTo(102.4, 9);
    expect(v.highLowPoints[0]!.kind).toBe("high");
  });

  test("grade is +2% before and −3% after the curve", () => {
    expect(v.gradeAt(900)).toBeCloseTo(2.0, 9);
    expect(v.gradeAt(1650)).toBeCloseTo(-3.0, 9);
  });

  test("curve report carries K = L/|A| = 120", () => {
    const curve = v.curves[0]!;
    expect(curve.K).toBeCloseTo(120, 9);
    expect(curve.pvcStation).toBeCloseTo(1000, 9);
    expect(curve.pvtStation).toBeCloseTo(1600, 9);
    expect(curve.g1Percent).toBeCloseTo(2, 9);
    expect(curve.g2Percent).toBeCloseTo(-3, 9);
  });
});
