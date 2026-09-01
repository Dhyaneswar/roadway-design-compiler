// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseRoadDesign } from "../src/schema/validate";
import { computeHorizontal } from "../src/kernel/horizontal";
import { AiDesignProposal } from "../src/studio/ai-design";
import { buildTools, type StudioHost } from "../src/studio/webmcp-bridge";
import type { StudioForm } from "../src/studio/form-to-design";

/**
 * A circular curve must deflect LESS THAN 180 degrees.
 *
 * At exactly 180 the two tangents are parallel and never meet, so the tangent
 * distance R·tan(Δ/2) and the external distance R·(sec(Δ/2)−1) are undefined.
 * The schema said `.max(180)`, which is inclusive, and a live preview accepted
 * it and reported a tangent distance of 6.53e18 ft.
 *
 * ⚠ WHY IT SURVIVED EVERY GUARD. IEEE 754 cannot represent π/2 exactly, so
 * Math.tan(π/2) is 1.633e16 rather than Infinity. The result is enormous,
 * meaningless, and FINITE -- so `Number.isFinite` returns true and every
 * finiteness check in the stack waves it through. A value that is merely absurd
 * is harder to catch than one that is formally invalid, which is the whole
 * reason this bound has to be enforced at the edge rather than detected later.
 *
 * The LandXML importer already rejected >= 180. The authored path did not.
 * Four places expressed this bound and only one of them was right.
 */

const R = 400;
/**
 * ⚠ The profile is stationed BY the alignment, so the end station has to be
 * derived from delta -- 500 + R·Δ·π/180 + 500. A fixed end station makes every
 * case fail on the profile range instead, and a test that refuses 180 for the
 * wrong reason proves nothing about the bound under test.
 */
const endOf = (deltaDeg: number) => 1000 + 1000 + R * deltaDeg * (Math.PI / 180);

const design = (deltaDeg: number) => {
  const end = endOf(deltaDeg);
  return {
    name: "Delta Bound",
    alignment: {
      beginStation: 1000,
      start: { e: 2200000, n: 1350000 },
      startAzimuthDeg: 75,
      elements: [
        { type: "tangent", length: 500 },
        { type: "arc", radius: R, deltaDeg, direction: "right" },
        { type: "tangent", length: 500 },
      ],
    },
    profile: { pvis: [
      { station: 1000, elevation: 850 },
      { station: end, elevation: 860 },
    ] },
    templates: { "2-lane": {
      name: "2-lane",
      left: [{ name: "lane", width: 12, slopePercent: -2 }],
      right: [{ name: "lane", width: 12, slopePercent: -2 }],
    } },
    drops: [{ template: "2-lane", fromStation: 1000, toStation: end }],
  };
};

describe("the schema refuses a 180 degree curve", () => {
  it("rejects exactly 180", () => {
    expect(() => parseRoadDesign(design(180))).toThrow();
  });

  it("explains why, rather than just failing a bound", () => {
    try {
      parseRoadDesign(design(180));
      throw new Error("should have refused");
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/less than 180|parallel|undefined/i);
    }
  });

  it("rejects above 180 too", () => {
    for (const d of [180.0001, 270, 360]) {
      expect(() => parseRoadDesign(design(d)), `delta ${d}`).toThrow();
    }
  });

  it("rejects zero and negative", () => {
    for (const d of [0, -45]) {
      expect(() => parseRoadDesign(design(d)), `delta ${d}`).toThrow();
    }
  });

  it("still accepts everything below 180, right up to the edge", () => {
    for (const d of [0.001, 45, 90, 179, 179.999]) {
      expect(() => parseRoadDesign(design(d)), `delta ${d}`).not.toThrow();
    }
  });
});

describe("the values a legal curve produces stay physical", () => {
  const curveOf = (deltaDeg: number) => {
    const d = parseRoadDesign(design(deltaDeg));
    const h = computeHorizontal(d.alignment);
    return h.elements.find((e) => e.type === "arc")!.curve!;
  };

  it("grows without ever reaching the singularity", () => {
    // R = 400. These are the real numbers, not a smoke test.
    expect(curveOf(90).tangentDistance).toBeCloseTo(R, 6);
    expect(curveOf(120).tangentDistance).toBeCloseTo(692.82, 2);
    expect(curveOf(179).tangentDistance).toBeCloseTo(45835.4601, 3);
  });

  it("never returns the 6.5e18 the bug produced", () => {
    // 179.999 is legal and its tangent distance is genuinely enormous -- that is
    // real geometry, not a defect. What must never appear is the 1e18 magnitude,
    // which is the signature of tan(π/2) rather than of a sharp curve.
    for (const d of [90, 170, 179, 179.999]) {
      const t = curveOf(d).tangentDistance;
      expect(Number.isFinite(t), `delta ${d}`).toBe(true);
      expect(t, `delta ${d}`).toBeLessThan(1e12);
    }
  });

  it("keeps chord and middle ordinate inside the circle at every legal delta", () => {
    for (const d of [1, 45, 90, 179, 179.999]) {
      const c = curveOf(d);
      expect(c.chord, `delta ${d}`).toBeLessThanOrEqual(2 * 400 + 1e-9);
      expect(c.middleOrdinate, `delta ${d}`).toBeLessThanOrEqual(400 + 1e-9);
    }
  });
});

describe("the kernel refuses it directly, not only behind the schema", () => {
  // computeHorizontal is exported and alignmentRangeFromForm calls it on raw
  // form values before zod ever sees them.
  const raw = (deltaDeg: number) => ({
    beginStation: 1000,
    start: { e: 0, n: 0 },
    startAzimuthDeg: 0,
    elements: [{ type: "arc" as const, radius: 400, deltaDeg, direction: "right" as const }],
  });

  it("throws at exactly 180 instead of returning 6.5e18", () => {
    expect(() => computeHorizontal(raw(180))).toThrow(/less than 180/);
  });

  it("throws above 180 and at zero", () => {
    expect(() => computeHorizontal(raw(200))).toThrow();
    expect(() => computeHorizontal(raw(0))).toThrow();
  });

  it("computes normally below 180", () => {
    expect(computeHorizontal(raw(90)).elements[0]!.curve!.tangentDistance).toBeCloseTo(400, 6);
  });
});

describe("every authored path agrees on the bound", () => {
  it("the AI proposal schema rejects 180", () => {
    const proposal = {
      name: "p", rationale: "r", beginStation: 1000,
      startE: 2200000, startN: 1350000, startAzimuthDeg: 75,
      elements: [{ type: "arc", radius: 400, deltaDeg: 180, direction: "right" }],
      pvis: [{ station: 1000, elevation: 850 }, { station: 2000, elevation: 860 }],
    };
    expect(AiDesignProposal.safeParse(proposal).success).toBe(false);
  });

  it("the tool contract states the exclusive bound an agent must honour", () => {
    const host = {
      readForm: () => ({}) as StudioForm, writeForm: () => {}, pendingChanges: () => [],
      undoLastAgentChange: () => ({ ok: false as const, reason: "nothing-to-undo" as const }),
      offerAlternatives: () => 0, shareLink: () => "", setCrs: () => true, crsZones: () => [],
      readCrs: () => undefined, planFeatures: () => undefined, setPlanFeatures: () => {},
      designSections: () => [], setDesignSections: () => {}, terrain: () => undefined,
      setTerrain: () => {}, groundProfile: () => undefined,
    } as unknown as StudioHost;

    const tool = buildTools(host).find((t) => t.name === "add_horizontal_element")!;
    const schema = tool.inputSchema as { properties: Record<string, { description: string }> };
    const text = schema.properties.deltaDeg!.description;
    // It used to read "0 to 180", which invited exactly the value that breaks.
    expect(text).not.toMatch(/0 to 180/);
    expect(text).toMatch(/less than 180/i);
  });
});
