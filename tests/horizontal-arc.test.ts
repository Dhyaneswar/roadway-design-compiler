import { describe, test, expect } from "vitest";
import { computeHorizontal } from "../src/kernel/horizontal";
import type { HorizontalAlignment } from "../src/schema/road-design";

// Golden example H-2 (hand-computed):
// Start (1,000,000 E, 500,000 N), azimuth 90° (due east).
// Tangent 1000.00 ft → PC (1,001,000, 500,000).
// Arc: R = 1000 ft, Δ = 90°, RIGHT (curving toward south).
//   Center = PC + R toward az 180° = (1,001,000, 499,000).
//   L = R·Δ = 1000·π/2 = 1570.7963267948966 ft.
//   PT = center + R toward az 90° = (1,002,000, 499,000); heading at PT = 180°.
// Tangent 500.00 ft due south → end (1,002,000, 498,500).
// Total length = 3070.7963267948966 ft.
const tangentArcTangent: HorizontalAlignment = {
  beginStation: 1000, // 10+00 at the start point
  start: { e: 1_000_000, n: 500_000 },
  startAzimuthDeg: 90,
  elements: [
    { type: "tangent", length: 1000 },
    { type: "arc", radius: 1000, deltaDeg: 90, direction: "right" },
    { type: "tangent", length: 500 },
  ],
};

describe("computeHorizontal: tangent-arc-tangent (right turn)", () => {
  const r = computeHorizontal(tangentArcTangent);

  test("total length includes arc length R·Δ", () => {
    expect(r.length).toBeCloseTo(3070.7963267948966, 6);
  });

  test("PC is at the end of the entry tangent", () => {
    const pc = r.pointAt(1000);
    expect(pc.e).toBeCloseTo(1_001_000, 6);
    expect(pc.n).toBeCloseTo(500_000, 6);
  });

  test("mid-arc point (45° swept) matches hand calc", () => {
    const p = r.pointAt(1000 + 785.3981633974483);
    expect(p.e).toBeCloseTo(1_001_707.1067811865, 5);
    expect(p.n).toBeCloseTo(499_707.1067811866, 5);
  });

  test("heading at mid-arc is 135° (east turned right 45°)", () => {
    expect(r.azimuthAt(1000 + 785.3981633974483)).toBeCloseTo(135, 9);
  });

  test("PT matches hand calc and heading is due south", () => {
    const pt = r.pointAt(1000 + 1570.7963267948966);
    expect(pt.e).toBeCloseTo(1_002_000, 5);
    expect(pt.n).toBeCloseTo(499_000, 5);
    expect(r.azimuthAt(1000 + 1570.7963267948966)).toBeCloseTo(180, 9);
  });

  test("end of alignment is 500 ft south of PT", () => {
    const end = r.pointAt(r.length);
    expect(end.e).toBeCloseTo(1_002_000, 5);
    expect(end.n).toBeCloseTo(498_500, 5);
  });

  test("element report carries absolute PC/PT stations and curve data", () => {
    const arc = r.elements[1]!;
    expect(arc.beginStation).toBeCloseTo(2000, 6); // 10+00 begin + 1000 tangent
    expect(arc.endStation).toBeCloseTo(2000 + 1570.7963267948966, 6);
    expect(arc.curve).toBeDefined();
    expect(arc.curve!.tangentDistance).toBeCloseTo(1000, 6); // T = R·tan(Δ/2)
    expect(arc.curve!.chord).toBeCloseTo(1414.2135623730951, 6); // C = 2R·sin(Δ/2)
    expect(arc.curve!.external).toBeCloseTo(414.21356237309515, 6); // E = R(sec−1)
    expect(arc.curve!.middleOrdinate).toBeCloseTo(292.89321881345245, 6); // M = R(1−cos)
  });
});

// Golden example H-3 (hand-computed): LEFT turn.
// Start (1,000,000, 500,000), az 90°. Arc R = 500, Δ = 60°, LEFT.
//   Center = start + R toward az 0° = (1,000,000, 500,500).
//   L = 500·60·π/180 = 523.5987755982989.
//   End radial az = 180° − 60° = 120° → end = center + 500·(sin120°, cos120°)
//       = (1,000,433.0127018922, 500,250).
//   Heading at end = 90° − 60° = 30°.
describe("computeHorizontal: left-turning arc", () => {
  const r = computeHorizontal({
    beginStation: 0,
    start: { e: 1_000_000, n: 500_000 },
    startAzimuthDeg: 90,
    elements: [{ type: "arc", radius: 500, deltaDeg: 60, direction: "left" }],
  });

  test("end point matches hand calc", () => {
    const end = r.pointAt(r.length);
    expect(end.e).toBeCloseTo(1_000_433.0127018922, 5);
    expect(end.n).toBeCloseTo(500_250, 5);
  });

  test("heading decreases by Δ on a left turn", () => {
    expect(r.azimuthAt(r.length)).toBeCloseTo(30, 9);
  });
});
