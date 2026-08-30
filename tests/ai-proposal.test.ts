import { describe, test, expect } from "vitest";
import { AiDesignProposal, proposalToForm } from "../src/studio/ai-design";

const proposal = {
  name: "SR-EXAMPLE",
  rationale: "Two-lane rural collector at 45 mph; min radius per GDOT DPM.",
  beginStation: 1000,
  startE: 2_200_000,
  startN: 1_350_000,
  startAzimuthDeg: 75,
  elements: [
    { type: "tangent", length: 1200 },
    { type: "arc", radius: 1500, deltaDeg: 45, direction: "right" },
  ],
  pvis: [
    { station: 1000, elevation: 850 },
    { station: 2500, elevation: 880, curveLength: 600 },
    { station: 3378.1, elevation: 870 },
  ],
};

describe("AiDesignProposal schema", () => {
  test("accepts a well-formed proposal", () => {
    const parsed = AiDesignProposal.parse(proposal);
    expect(parsed.name).toBe("SR-EXAMPLE");
    expect(parsed.elements).toHaveLength(2);
  });

  test("rejects an arc without a radius", () => {
    const bad = structuredClone(proposal) as any;
    delete bad.elements[1].radius;
    expect(() => AiDesignProposal.parse(bad)).toThrow();
  });
});

describe("proposalToForm", () => {
  const form = proposalToForm(AiDesignProposal.parse(proposal));

  test("maps header fields", () => {
    expect(form.name).toBe("SR-EXAMPLE");
    expect(form.beginStation).toBe(1000);
    expect(form.startE).toBe(2_200_000);
    expect(form.startAzimuthDeg).toBe(75);
  });

  test("stringifies element rows for the form inputs", () => {
    expect(form.elements[0]).toEqual({ kind: "tangent", length: "1200" });
    expect(form.elements[1]).toEqual({
      kind: "arc",
      radius: "1500",
      deltaDeg: "45",
      direction: "right",
    });
  });

  test("stringifies PVI rows and omits blank curve lengths", () => {
    expect(form.pvis[0]).toEqual({ station: "1000", elevation: "850", curveLength: "" });
    expect(form.pvis[1]).toEqual({ station: "2500", elevation: "880", curveLength: "600" });
  });

  test("strips curve lengths the model put on endpoint PVIs (they carry no VC)", () => {
    const sloppy = structuredClone(proposal) as any;
    sloppy.pvis[0].curveLength = 300;
    sloppy.pvis[2].curveLength = 400;
    const f = proposalToForm(AiDesignProposal.parse(sloppy));
    expect(f.pvis[0]!.curveLength).toBe("");
    expect(f.pvis[2]!.curveLength).toBe("");
  });
});
