import { describe, test, expect } from "vitest";
import { alignmentRangeFromForm, formToDesign, type StudioForm } from "../src/studio/form-to-design";

// Alignment: 1200 tangent + arc R1500 Δ45° (L = 1500·π/4 = 1178.0972) +
// zero-length deflection → end station 1000 + 2378.0972450961724.
const END = 1000 + 1200 + (1500 * Math.PI) / 4;

const form: StudioForm = {
  name: "Test Road",
  beginStation: 1000,
  startE: 2_200_000,
  startN: 1_350_000,
  startAzimuthDeg: 75,
  elements: [
    { kind: "tangent", length: "1200" },
    { kind: "arc", radius: "1500", deltaDeg: "45", direction: "right" },
    { kind: "deflection", deflectionDeg: "0.5", direction: "left" },
  ],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "2500", elevation: "880", curveLength: "600" },
    { station: String(END), elevation: "860" },
  ],
  templates: [
    {
      name: "2-lane",
      left: [
        { name: "lane", width: "12", slopePercent: "-2" },
        { name: "shoulder", width: "6.5", slopePercent: "-4" },
      ],
      right: [
        { name: "lane", width: "12", slopePercent: "-2" },
        { name: "shoulder", width: "6.5", slopePercent: "-4" },
      ],
    },
  ],
  // Boundary model: row i ends at its toStation; the last row's toStation is
  // derived (alignment end) — coverage is contiguous by construction.
  drops: [{ template: "2-lane", toStation: "" }],
};

describe("alignmentRangeFromForm", () => {
  test("derives begin and end station from the horizontal elements", () => {
    const range = alignmentRangeFromForm(form);
    expect(range.begin).toBe(1000);
    expect(range.end).toBeCloseTo(END, 9);
  });

  test("throws the element-specific error on bad input", () => {
    const bad = structuredClone(form);
    bad.elements[1] = { kind: "arc", radius: "abc", deltaDeg: "45", direction: "right" };
    expect(() => alignmentRangeFromForm(bad)).toThrow(/element 2.*radius/i);
  });
});

describe("formToDesign", () => {
  test("maps form rows to a valid RoadDesign document", () => {
    const design = formToDesign(form);
    expect(design.name).toBe("Test Road");
    expect(design.alignment.elements).toEqual([
      { type: "tangent", length: 1200 },
      { type: "arc", radius: 1500, deltaDeg: 45, direction: "right" },
      { type: "deflection", deflectionDeg: 0.5, direction: "left" },
    ]);
    expect(design.profile.pvis[1]).toEqual({
      station: 2500,
      elevation: 880,
      curveLength: 600,
    });
  });

  test("derives the template drop from the alignment range, not the PVIs", () => {
    const design = formToDesign(form);
    expect(design.drops).toHaveLength(1);
    expect(design.drops[0]!.template).toBe("2-lane");
    expect(design.drops[0]!.fromStation).toBe(1000);
    expect(design.drops[0]!.toStation).toBeCloseTo(END, 9);
  });

  test("maps the template editor rows into the templates record", () => {
    const design = formToDesign(form);
    expect(Object.keys(design.templates)).toEqual(["2-lane"]);
    expect(design.templates["2-lane"]!.left).toEqual([
      { name: "lane", width: 12, slopePercent: -2 },
      { name: "shoulder", width: 6.5, slopePercent: -4 },
    ]);
  });

  test("maps a drop taper to transitionLength", () => {
    const f = structuredClone(form);
    f.templates.push({
      name: "4-lane",
      left: [
        { name: "lane", width: "24", slopePercent: "-2" },
        { name: "shoulder", width: "6.5", slopePercent: "-4" },
      ],
      right: [
        { name: "lane", width: "24", slopePercent: "-2" },
        { name: "shoulder", width: "6.5", slopePercent: "-4" },
      ],
    });
    f.drops = [
      { template: "2-lane", toStation: "2500" },
      { template: "4-lane", toStation: "", transition: "150" },
    ];
    const design = formToDesign(f);
    expect(design.drops[1]!.transitionLength).toBe(150);
    expect("transitionLength" in design.drops[0]!).toBe(false);
  });

  test("two drops tile the alignment at the typed boundary", () => {
    const f = structuredClone(form);
    f.templates.push({
      name: "4-lane",
      left: [{ name: "lane", width: "24", slopePercent: "-2" }],
      right: [{ name: "lane", width: "24", slopePercent: "-2" }],
    });
    f.drops = [
      { template: "2-lane", toStation: "2500" },
      { template: "4-lane", toStation: "" },
    ];
    const design = formToDesign(f);
    expect(design.drops).toEqual([
      { template: "2-lane", fromStation: 1000, toStation: 2500 },
      { template: "4-lane", fromStation: 2500, toStation: expect.closeTo(END, 9) },
    ]);
  });

  test("rejects a drop boundary outside the alignment range", () => {
    const f = structuredClone(form);
    f.drops = [
      { template: "2-lane", toStation: "9999" },
      { template: "2-lane", toStation: "" },
    ];
    expect(() => formToDesign(f)).toThrow(/drop 1.*boundary/i);
  });

  test("rejects non-increasing drop boundaries", () => {
    const f = structuredClone(form);
    f.drops = [
      { template: "2-lane", toStation: "3000" },
      { template: "2-lane", toStation: "2000" },
      { template: "2-lane", toStation: "" },
    ];
    expect(() => formToDesign(f)).toThrow(/drop 2.*boundary/i);
  });

  test("rejects duplicate template names", () => {
    const f = structuredClone(form);
    f.templates.push(structuredClone(f.templates[0]!));
    expect(() => formToDesign(f)).toThrow(/template.*name/i);
  });

  test("rejects a non-numeric segment width with a field-specific message", () => {
    const f = structuredClone(form);
    f.templates[0]!.left[1]!.width = "abc";
    expect(() => formToDesign(f)).toThrow(/template 1.*left segment 2.*width/i);
  });

  test("rejects a profile that does not span the alignment", () => {
    const bad = structuredClone(form);
    bad.pvis[2]!.station = "4000";
    expect(() => formToDesign(bad)).toThrow(/end station/i);
  });

  test("rejects non-numeric input with a field-specific message", () => {
    const bad = structuredClone(form);
    bad.elements[0] = { kind: "tangent", length: "abc" };
    expect(() => formToDesign(bad)).toThrow(/element 1.*length/i);
  });

  test("rejects empty PVI station", () => {
    const bad = structuredClone(form);
    bad.pvis[0]!.station = "";
    expect(() => formToDesign(bad)).toThrow(/pvi 1.*station/i);
  });

  test("omits curveLength when blank", () => {
    const design = formToDesign(form);
    expect(design.profile.pvis[0]).toEqual({ station: 1000, elevation: 850 });
    expect("curveLength" in design.profile.pvis[0]!).toBe(false);
  });
});
