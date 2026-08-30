import { describe, test, expect } from "vitest";
import { dmsToDegrees } from "../../src/util/angle";
import { computeHorizontal } from "../../src/kernel/horizontal";
import type { HorizontalAlignment } from "../../src/schema/road-design";

// RoadBench #1 — PI 762380, SR 400/I-85 Connector Ramps (GDOT sealed as-built).
// Printed curve data from sheet 19 (dwg 13-00B); begin alignment from sheet 18.
// See corpus/762380-sr400-i85/README.md for provenance and cross-checks.
// The kernel must reproduce the sealed T, L, E and PC/PT stations within the
// print rounding (±0.01 ft).

const delta501 = dmsToDegrees(7, 50, 10.1); // LT
const delta502 = dmsToDegrees(5, 14, 26.1); // LT

// ℄ RAMP STRIPING: begin 590+50.00, tangent 63.18 → PC(501) 591+13.18,
// curve 501 (R 4312), tangent 47.13 → PC(502) 597+50.05, curve 502 (R 4475).
const rampStriping: HorizontalAlignment = {
  beginStation: 59050.0,
  start: { e: 2_237_764.39, n: 1_393_656.43 },
  // S 9°20'23.5" W → azimuth = 180° + 9°20'23.5"
  startAzimuthDeg: 180 + dmsToDegrees(9, 20, 23.5),
  elements: [
    { type: "tangent", length: 63.18 },
    { type: "arc", radius: 4312.0, deltaDeg: delta501, direction: "left" },
    { type: "tangent", length: 47.13 },
    { type: "arc", radius: 4475.0, deltaDeg: delta502, direction: "left" },
  ],
};

describe("RoadBench #1: dms conversion", () => {
  test("converts printed DELTA to decimal degrees", () => {
    expect(delta501).toBeCloseTo(7.836138888888889, 12);
    expect(delta502).toBeCloseTo(5.240583333333333, 12);
  });
});

describe("RoadBench #1: curve 501 reproduces sealed plan values", () => {
  const h = computeHorizontal(rampStriping);
  const arc = h.elements[1]!;

  test("PC station 591+13.18", () => {
    expect(arc.beginStation).toBeCloseTo(59113.18, 2);
  });

  test("arc length L = 589.74", () => {
    expect(Math.abs(arc.curve!.length - 589.74)).toBeLessThan(0.01);
  });

  test("tangent distance T = 295.33", () => {
    expect(Math.abs(arc.curve!.tangentDistance - 295.33)).toBeLessThan(0.01);
  });

  test("external E = 10.10", () => {
    expect(Math.abs(arc.curve!.external - 10.1)).toBeLessThan(0.01);
  });

  test("PT station 597+02.92 (printed on sheet 19)", () => {
    expect(Math.abs(arc.endStation - 59702.92)).toBeLessThan(0.01);
  });
});

describe("RoadBench #1: curve 502 reproduces sealed plan values", () => {
  const h = computeHorizontal(rampStriping);
  const arc = h.elements[3]!;

  test("PC station 597+50.05 = PI 599+54.85 − T", () => {
    expect(Math.abs(arc.beginStation - 59750.05)).toBeLessThan(0.02);
  });

  test("arc length L = 409.31", () => {
    expect(Math.abs(arc.curve!.length - 409.31)).toBeLessThan(0.01);
  });

  test("tangent distance T = 204.80", () => {
    expect(Math.abs(arc.curve!.tangentDistance - 204.8)).toBeLessThan(0.01);
  });

  test("external E = 4.68", () => {
    expect(Math.abs(arc.curve!.external - 4.68)).toBeLessThan(0.01);
  });
});
