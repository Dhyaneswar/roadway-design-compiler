import { describe, test, expect } from "vitest";
import { computeHorizontal } from "../src/kernel/horizontal";
import type { HorizontalAlignment } from "../src/schema/road-design";

// Angle points (deflections without curves) are standard urban practice for
// tiny bearing changes — discovered on GDOT PI 0000297 sheet 47 (dwg 13-0002),
// PI 113+23.00 deflects 0°18'45.6" LT with no curve.
const withDeflection: HorizontalAlignment = {
  beginStation: 0,
  start: { e: 1000, n: 2000 },
  startAzimuthDeg: 90,
  elements: [
    { type: "tangent", length: 100 },
    { type: "deflection", deflectionDeg: 30, direction: "left" },
    { type: "tangent", length: 100 },
  ],
};

describe("computeHorizontal: deflection (angle point)", () => {
  const r = computeHorizontal(withDeflection);

  test("deflection adds no length", () => {
    expect(r.length).toBeCloseTo(200, 9);
  });

  test("heading turns by the deflection at the angle point", () => {
    expect(r.azimuthAt(99.999)).toBeCloseTo(90, 6);
    expect(r.azimuthAt(100.001)).toBeCloseTo(60, 3); // left turn decreases azimuth
  });

  test("geometry continues from the angle point on the new bearing", () => {
    const end = r.pointAt(200);
    // 100 ft east, then 100 ft at azimuth 60°: ΔE=100·sin60=86.6025, ΔN=100·cos60=50
    expect(end.e).toBeCloseTo(1000 + 100 + 86.60254037844387, 6);
    expect(end.n).toBeCloseTo(2000 + 50, 6);
  });

  test("element report shows zero-length element at correct station", () => {
    const d = r.elements[1]!;
    expect(d.type).toBe("deflection");
    expect(d.beginStation).toBeCloseTo(100, 9);
    expect(d.endStation).toBeCloseTo(100, 9);
  });

  test("deflection report carries angle, direction, and both azimuths (UI table)", () => {
    const d = r.elements[1]!;
    expect(d.deflection).toEqual({
      deflectionDeg: 30,
      direction: "left",
      azimuthInDeg: 90,
      azimuthOutDeg: 60,
    });
  });
});
