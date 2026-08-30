import { describe, test, expect } from "vitest";
import { computeVertical } from "../../src/kernel/vertical";
import type { VerticalProfile } from "../../src/schema/road-design";

// RoadBench #2 (vertical) — PI 0000297 sheet 76 (dwg 15-0002), sealed profile.
// Printed: +1.1291% grade → crest VC 430.00', PVC 119+72.00 EL 766.34,
//   PVI 121+87.00 EL 768.76, PVT 124+02.00 EL 767.68, K=263.35,
//   HIGH POINT 122+69.50 EL 768.02, then −0.5028% → sag VC 200.00',
//   PVC 127+50.00 EL 765.93, PVI 128+50.00 EL 765.43, K=170.37,
//   LOW POINT 128+35.67 EL 765.72.
// Note: printed grades are rounded to 4 decimals and elevations to 0.01 ft,
// so derived quantities carry small rounding chains — tolerances documented
// per assertion. Sag exit grade derived from printed K (the +1.4364% printed
// further right belongs to a later grade segment beyond this sheet).

const sagA = 200 / 170.37; // |g2 − g1| from printed K
const sagG2 = sagA - 0.5028; // ≈ +0.6716%

const profile: VerticalProfile = {
  pvis: [
    // entry point 315 ft before the crest PVI, ON the printed +1.1291% grade
    // (anchor through the PVI, not the 0.01-rounded PVC elevation)
    { station: 11_872.0, elevation: 768.76 - 0.011291 * 315 },
    { station: 12_187.0, elevation: 768.76, curveLength: 430 }, // crest PVI (printed)
    { station: 12_850.0, elevation: 765.43, curveLength: 200 }, // sag PVI (printed)
    // exit point 200 ft past the sag PVI on the K-derived exit grade
    { station: 13_050.0, elevation: 765.43 + (sagG2 / 100) * 200 },
  ],
};

describe("RoadBench #2 vertical: crest VC 430' at PVI 121+87.00", () => {
  const v = computeVertical(profile);
  const crest = v.curves[0]!;

  test("PVC/PVT stations match the printed 119+72.00 / 124+02.00", () => {
    expect(crest.pvcStation).toBeCloseTo(11_972.0, 6);
    expect(crest.pvtStation).toBeCloseTo(12_402.0, 6);
  });

  test("PVT elevation reproduces the printed 767.68 (genuine cross-check)", () => {
    // not used in construction: PVI elev + back-grade × L/2 must land on print
    expect(Math.abs(crest.pvtElevation - 767.68)).toBeLessThan(0.015);
  });

  test("high point reproduces the printed 122+69.50 / EL 768.02", () => {
    const hp = v.highLowPoints.find((p) => p.kind === "high")!;
    expect(Math.abs(hp.station - 12_269.5)).toBeLessThan(0.25); // grade-rounding chain
    expect(Math.abs(hp.elevation - 768.02)).toBeLessThan(0.015);
  });

  test("K reproduces the printed 263.35 within grade-rounding", () => {
    expect(Math.abs(crest.K - 263.35)).toBeLessThan(0.3);
  });
});

describe("RoadBench #2 vertical: sag VC 200' at PVI 128+50.00", () => {
  const v = computeVertical(profile);
  const sag = v.curves[1]!;

  test("PVC station and elevation match the printed 127+50.00 / 765.93", () => {
    expect(sag.pvcStation).toBeCloseTo(12_750.0, 6);
    expect(Math.abs(sag.pvcElevation - 765.93)).toBeLessThan(0.015);
  });

  test("K reproduces the printed 170.37 (g2 derived from it — consistency)", () => {
    // back-grade comes from printed PVI elevations (0.01 ft rounding over 663 ft
    // ≈ ±0.0015% grade), which moves K by up to ~0.1 — tolerance reflects that
    expect(Math.abs(sag.K - 170.37)).toBeLessThan(0.12);
  });

  test("low point reproduces the printed 128+35.67 / EL 765.72", () => {
    const lp = v.highLowPoints.find((p) => p.kind === "low")!;
    expect(Math.abs(lp.station - 12_835.67)).toBeLessThan(0.25);
    expect(Math.abs(lp.elevation - 765.72)).toBeLessThan(0.015);
  });
});
