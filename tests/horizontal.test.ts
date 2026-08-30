import { describe, test, expect } from "vitest";
import { computeHorizontal } from "../src/kernel/horizontal";
import type { HorizontalAlignment } from "../src/schema/road-design";

// Golden example H-1: single tangent, due east.
// Start (1,000,000.00 E, 500,000.00 N), azimuth 90° (due east), length 1000.00 ft.
// Hand-computed: end point (1,001,000.00, 500,000.00); station at end = begin + 1000.
const tangentOnly: HorizontalAlignment = {
  beginStation: 0,
  start: { e: 1_000_000, n: 500_000 },
  startAzimuthDeg: 90,
  elements: [{ type: "tangent", length: 1000 }],
};

describe("computeHorizontal: tangent", () => {
  test("total length equals tangent length", () => {
    const result = computeHorizontal(tangentOnly);
    expect(result.length).toBeCloseTo(1000, 6);
  });

  test("point at end station is 1000 ft due east of start", () => {
    const result = computeHorizontal(tangentOnly);
    const p = result.pointAt(1000);
    expect(p.e).toBeCloseTo(1_001_000, 6);
    expect(p.n).toBeCloseTo(500_000, 6);
  });

  test("point at mid station is halfway along the tangent", () => {
    const result = computeHorizontal(tangentOnly);
    const p = result.pointAt(500);
    expect(p.e).toBeCloseTo(1_000_500, 6);
    expect(p.n).toBeCloseTo(500_000, 6);
  });

  test("bearing along a tangent is constant", () => {
    const result = computeHorizontal(tangentOnly);
    expect(result.azimuthAt(0)).toBeCloseTo(90, 9);
    expect(result.azimuthAt(999.99)).toBeCloseTo(90, 9);
  });
});
