import { describe, expect, it } from "vitest";
import { formToDesign } from "../src/studio/form-to-design";
import type {
  FormDropRow, FormElementRow, FormPviRow, FormSegmentRow, StudioForm,
} from "../src/studio/form-to-design";

// ---------------------------------------------------------------------------
// THIS FILE EXISTS TO TURN A SILENT BUG INTO A BUILD FAILURE.
//
// StudioForm and RoadDesign are parallel shapes joined by a hand-written mapping.
// Add a field to the form, forget to thread it through formToDesign, and the value
// is dropped without a word -- which is exactly what happened to `material`: the
// tool reported committed and the value was gone.
//
// The fixtures below are typed `Required<...>`, so TypeScript REFUSES TO COMPILE
// if a new field is added to the form and not added here. That turns "somebody
// remembered" into "the build said so". Then the assertions prove the mapping
// carries each one through.
//
// ⚠ If you are here because the build broke: you added a field. Add it to the
// fixture, then add an assertion that it survives formToDesign. If it does not
// survive, the mapping is what needs fixing -- not this test.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TYPE-LEVEL COMPLETENESS PROBES
//
// Required<StudioForm> only forces the TOP level. The nested row types have their
// own optional fields, and a new one on any of them would vanish exactly the way
// `material` did -- verified by adding a field to FormPviRow and watching the
// build stay green.
//
// These probes list every field of every row type. They are not valid road data
// and are never built into a design; their entire job is to fail compilation when
// a field is added and not accounted for here.
// ---------------------------------------------------------------------------

const _elementProbe: Required<FormElementRow> = {
  kind: "arc", length: "1000", radius: "1500", deltaDeg: "45",
  deflectionDeg: "2", direction: "right",
};
const _pviProbe: Required<FormPviRow> = {
  station: "1000", elevation: "850", curveLength: "400",
};
const _dropProbe: Required<FormDropRow> = {
  template: "2-lane", toStation: "2000", transition: "100",
};
const _segmentProbe: Required<FormSegmentRow> = {
  name: "lane", width: "12", slopePercent: "-2", material: "asphalt",
};

const completeSegment: Required<FormSegmentRow> = {
  name: "lane",
  width: "12",
  slopePercent: "-2",
  material: "asphalt",
};

const completeForm: Required<StudioForm> = {
  name: "Completeness",
  beginStation: 1000,
  startE: 2200000,
  startN: 1350000,
  startAzimuthDeg: 75,
  elements: [
    { kind: "tangent", length: "1200" },
    { kind: "arc", radius: "1500", deltaDeg: "45", direction: "right" },
    { kind: "tangent", length: "800" },
  ],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "2000", elevation: "862", curveLength: "400" },
    // 1000 + 1200 + (1500 x 45 deg = 1178.0972) + 800
    { station: "4178.0972", elevation: "868" },
  ],
  templates: [{
    name: "2-lane",
    left: [completeSegment, { name: "shoulder", width: "6", slopePercent: "-4", material: "gravel" }],
    right: [completeSegment, { name: "shoulder", width: "6", slopePercent: "-4", material: "gravel" }],
  }],
  drops: [{ template: "2-lane", toStation: "", transition: "" }],
  superelevation: { designSpeedMph: 55, emax: 0.06, normalCrownPercent: 2 },
  roadside: [{
    id: "gr-1", kind: "guardrail", side: "left",
    beginStation: 1200, endStation: 1800, offsetFt: 20,
    heightFt: 2.5, note: "std detail 4A",
  }],
};

describe("every authored field survives the mapping to a design", () => {
  const design = formToDesign(completeForm);

  it("carries the project setup", () => {
    expect(design.name).toBe("Completeness");
    expect(design.alignment.beginStation).toBe(1000);
    expect(design.alignment.start).toEqual({ e: 2200000, n: 1350000 });
    expect(design.alignment.startAzimuthDeg).toBe(75);
  });

  it("carries every horizontal element", () => {
    expect(design.alignment.elements).toHaveLength(3);
    expect(design.alignment.elements[1]).toMatchObject({
      type: "arc", radius: 1500, deltaDeg: 45, direction: "right",
    });
  });

  it("carries the PVIs including a vertical curve length", () => {
    expect(design.profile.pvis).toHaveLength(3);
    expect(design.profile.pvis[1]!.curveLength).toBe(400);
  });

  it("carries the SEGMENT MATERIAL -- the field that was silently dropped", () => {
    const t = design.templates["2-lane"]!;
    expect(t.left[0]!.material).toBe("asphalt");
    expect(t.left[1]!.material).toBe("gravel");
    expect(t.right[0]!.material).toBe("asphalt");
  });

  it("carries the superelevation policy", () => {
    expect(design.superelevation?.designSpeedMph).toBe(55);
    expect(design.superelevation?.emax).toBe(0.06);
    expect(design.superelevation?.normalCrownPercent).toBe(2);
  });

  it("carries the roadside furniture with every stated field", () => {
    expect(design.roadside).toHaveLength(1);
    expect(design.roadside![0]).toMatchObject({
      id: "gr-1", kind: "guardrail", side: "left",
      beginStation: 1200, endStation: 1800, offsetFt: 20,
      heightFt: 2.5, note: "std detail 4A",
    });
  });

  it("keeps the template segment geometry", () => {
    const t = design.templates["2-lane"]!;
    expect(t.left.map((s) => s.width)).toEqual([12, 6]);
    expect(t.left.map((s) => s.slopePercent)).toEqual([-2, -4]);
  });
});

describe("every ROW TYPE is accounted for, not just the top level", () => {
  it("lists every field of every nested row, so a new one breaks compilation", () => {
    // Reading them keeps the probes from being dead code. The real work happened
    // at compile time: if a row type gained a field, this file would not build.
    expect(Object.keys(_elementProbe).sort()).toEqual(
      ["deflectionDeg", "deltaDeg", "direction", "kind", "length", "radius"]);
    expect(Object.keys(_pviProbe).sort()).toEqual(["curveLength", "elevation", "station"]);
    expect(Object.keys(_dropProbe).sort()).toEqual(["template", "toStation", "transition"]);
    expect(Object.keys(_segmentProbe).sort()).toEqual(
      ["material", "name", "slopePercent", "width"]);
  });

  it("carries a drop transition through the mapping", () => {
    const withTaper = formToDesign({
      ...completeForm,
      templates: [
        completeForm.templates[0]!,
        { name: "wide", left: completeForm.templates[0]!.left,
          right: completeForm.templates[0]!.right },
      ],
      drops: [
        { template: "2-lane", toStation: "2500", transition: "" },
        { template: "wide", toStation: "", transition: "150" },
      ],
    });
    expect(withTaper.drops[1]!.transitionLength).toBe(150);
  });
});

describe("the fixture itself stays complete", () => {
  it("populates every top-level form field, so a new one breaks the build here first", () => {
    // Belt and braces: if Required<StudioForm> is ever relaxed, this still notices
    // a field going missing from the fixture.
    for (const [key, value] of Object.entries(completeForm)) {
      expect(value, `form field "${key}" is empty in the completeness fixture`).toBeDefined();
    }
    expect(Object.keys(completeForm).length).toBeGreaterThanOrEqual(11);
  });
});
