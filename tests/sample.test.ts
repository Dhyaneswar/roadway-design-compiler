import { describe, test, expect } from "vitest";
import { sampleAlignment, sampleProfile } from "../src/kernel/sample";
import type { HorizontalAlignment, VerticalProfile } from "../src/schema/road-design";

const alignment: HorizontalAlignment = {
  beginStation: 0,
  start: { e: 1000, n: 2000 },
  startAzimuthDeg: 90,
  elements: [
    { type: "tangent", length: 100 },
    { type: "arc", radius: 100, deltaDeg: 90, direction: "right" },
  ],
};

const profile: VerticalProfile = {
  pvis: [
    { station: 0, elevation: 100 },
    { station: 150, elevation: 103, curveLength: 60 },
    { station: 300, elevation: 100 },
  ],
};

describe("sampleAlignment", () => {
  const pts = sampleAlignment(alignment, 50);

  test("returns the requested number of points plus endpoints", () => {
    expect(pts.length).toBe(51); // 50 intervals → 51 points
  });

  test("first and last points are the alignment ends", () => {
    expect(pts[0]).toEqual({ e: 1000, n: 2000 });
    const last = pts[pts.length - 1]!;
    // tangent 100 east → (1100,2000); arc R=100 Δ=90 right → end (1200,1900)
    expect(last.e).toBeCloseTo(1200, 6);
    expect(last.n).toBeCloseTo(1900, 6);
  });

  test("mid-tangent point lies on the tangent", () => {
    const p = pts.find((q) => Math.abs(q.e - 1050) < 2)!;
    expect(p.n).toBeCloseTo(2000, 6);
  });
});

describe("sampleProfile", () => {
  const pts = sampleProfile(profile, 50);

  test("spans the full PVI range", () => {
    expect(pts[0]).toEqual({ station: 0, elevation: 100 });
    const last = pts[pts.length - 1]!;
    expect(last.station).toBeCloseTo(300, 9);
    expect(last.elevation).toBeCloseTo(100, 9);
  });

  test("elevation at the PVI station is below the PVI (crest)", () => {
    const atPvi = pts.find((q) => Math.abs(q.station - 150) < 4)!;
    expect(atPvi.elevation).toBeLessThan(103);
    expect(atPvi.elevation).toBeGreaterThan(102);
  });
});
