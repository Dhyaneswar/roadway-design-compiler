import { describe, expect, it } from "vitest";
import {
  crossSlopeAt,
  defaultMaxRelativeGradient,
  runoffLengthFt,
  superelevationRateFor,
  tangentRunoutFt,
  transitionFor,
  type SuperelevationBasis,
} from "../src/kernel/superelevation";

const basis: SuperelevationBasis = {
  designSpeedMph: 45,
  emax: 0.06,
  sideFriction: 0.15,
  normalCrownPercent: 2,
  laneWidthFt: 12,
  lanesRotated: 1,
  maxRelativeGradientPercent: 0.5,
};

describe("superelevation rate", () => {
  it("stays at normal crown for a curve flat enough not to need banking", () => {
    // Very large radius: V^2/(15R) - f goes negative.
    expect(superelevationRateFor(20000, basis)).toBe(2);
  });

  it("clamps to emax for a curve tighter than the minimum radius", () => {
    expect(superelevationRateFor(300, basis)).toBeCloseTo(6, 4);
  });

  it("returns an intermediate rate between those bounds", () => {
    // At V=45, f=0.15 the required e is zero at about R=900 (friction alone
    // carries the curve) and reaches emax at about R=643, so an intermediate
    // rate lives between those. R=700 gives e = 135/700 - 0.15 = 4.286%.
    const e = superelevationRateFor(700, basis);
    expect(e).toBeCloseTo(4.2857, 3);
    expect(e).toBeGreaterThan(2);
    expect(e).toBeLessThan(6);
  });

  it("falls back to normal crown when friction alone carries the curve", () => {
    // R=900 at 45 mph needs e = 0, which is below normal crown.
    expect(superelevationRateFor(900, basis)).toBe(2);
  });

  it("banks a tighter curve harder than a flatter one", () => {
    expect(superelevationRateFor(700, basis)).toBeGreaterThan(superelevationRateFor(1400, basis));
  });

  it("is defensive about a nonsense radius rather than returning NaN", () => {
    expect(superelevationRateFor(0, basis)).toBe(0);
    expect(superelevationRateFor(-500, basis)).toBe(0);
  });
});

describe("runoff and runout", () => {
  it("computes runoff from the relative-gradient relationship", () => {
    // Lr = (12 * 1 * 6) / 0.5 = 144
    expect(runoffLengthFt(6, basis)).toBeCloseTo(144, 3);
  });

  it("grows with the number of lanes rotated", () => {
    const one = runoffLengthFt(6, basis);
    const two = runoffLengthFt(6, { ...basis, lanesRotated: 2 });
    expect(two).toBeCloseTo(one * 2, 3);
  });

  it("derives runout as the normal-crown fraction of the runoff", () => {
    const lr = runoffLengthFt(6, basis);
    // Lt = (2/6) * 144 = 48
    expect(tangentRunoutFt(6, lr, basis)).toBeCloseTo(48, 3);
  });

  it("has no runout when there is no superelevation to reach", () => {
    expect(tangentRunoutFt(0, 100, basis)).toBe(0);
  });

  it("uses a maximum relative gradient that falls with speed", () => {
    expect(defaultMaxRelativeGradient(25)).toBeGreaterThan(defaultMaxRelativeGradient(70));
  });
});

describe("transition landmarks", () => {
  const t = transitionFor(
    { radiusFt: 500, direction: "right", pcStation: 2000, ptStation: 2600 },
    0, basis,
  );

  it("orders the landmarks monotonically", () => {
    expect(t.ncEndStation).toBeLessThan(t.runoffStartStation);
    expect(t.runoffStartStation).toBeLessThan(t.pcStation);
    expect(t.pcStation).toBeLessThan(t.ptStation);
    expect(t.ptStation).toBeLessThan(t.exitRunoffEndStation);
    expect(t.exitRunoffEndStation).toBeLessThan(t.ncResumeStation);
  });

  it("puts the runoff immediately before the PC", () => {
    expect(t.pcStation - t.runoffStartStation).toBeCloseTo(t.runoffLengthFt, 6);
  });
});

describe("cross slope through a right-hand curve", () => {
  const t = transitionFor(
    { radiusFt: 500, direction: "right", pcStation: 2000, ptStation: 2600 },
    0, basis,
  );
  const at = (s: number) => crossSlopeAt(s, [t], basis);

  it("is normal crown well before the transition", () => {
    const c = at(100);
    expect(c.phase).toBe("normal-crown");
    expect(c.leftPercent).toBe(-2);
    expect(c.rightPercent).toBe(-2);
  });

  it("banks with the LEFT side outside and rising on a right-hand curve", () => {
    const c = at(2300); // mid curve
    expect(c.phase).toBe("full-superelevation");
    expect(c.leftPercent).toBeGreaterThan(0);
    expect(c.rightPercent).toBeLessThan(0);
    expect(c.leftPercent).toBeCloseTo(6, 3);
    expect(c.rightPercent).toBeCloseTo(-6, 3);
  });

  it("mirrors the bank on a left-hand curve", () => {
    const left = transitionFor(
      { radiusFt: 500, direction: "left", pcStation: 2000, ptStation: 2600 }, 0, basis,
    );
    const c = crossSlopeAt(2300, [left], basis);
    expect(c.leftPercent).toBeCloseTo(-6, 3);
    expect(c.rightPercent).toBeCloseTo(6, 3);
  });

  it("holds the inside at normal crown through the tangent runout", () => {
    const mid = (t.ncEndStation + t.runoffStartStation) / 2;
    const c = at(mid);
    expect(c.phase).toBe("tangent-runout");
    expect(c.rightPercent).toBeCloseTo(-2, 6);
    expect(c.leftPercent).toBeGreaterThan(-2);
    expect(c.leftPercent).toBeLessThan(0);
  });

  it("passes through zero on the outside at the end of the runout", () => {
    const c = at(t.runoffStartStation - 1e-6);
    expect(c.leftPercent).toBeCloseTo(0, 3);
  });

  it("reaches full superelevation exactly at the PC", () => {
    const c = at(t.pcStation);
    expect(c.leftPercent).toBeCloseTo(6, 3);
  });

  it("returns to normal crown after the exit transition", () => {
    const c = at(t.ncResumeStation + 50);
    expect(c.phase).toBe("normal-crown");
    expect(c.leftPercent).toBe(-2);
  });

  it("is continuous: no step larger than the rotation rate between samples", () => {
    let prev = at(t.ncEndStation).leftPercent;
    for (let s = t.ncEndStation; s <= t.ncResumeStation; s += 5) {
      const now = at(s).leftPercent;
      expect(Math.abs(now - prev)).toBeLessThan(1.0);
      prev = now;
    }
  });
});
