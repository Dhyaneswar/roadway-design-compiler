import { describe, expect, it } from "vitest";
import { AlternativeSet, evaluateAlternatives, type AlternativeInput } from "../src/studio/alternatives";
import type { StudioForm } from "../src/studio/form-to-design";

const form = (radius: string): StudioForm => ({
  name: "Alt",
  beginStation: 1000,
  startE: 2200000,
  startN: 1350000,
  startAzimuthDeg: 75,
  elements: [
    { kind: "tangent", length: "1200" },
    { kind: "arc", radius, deltaDeg: "45", direction: "right" },
    { kind: "tangent", length: "800" },
  ],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "2500", elevation: "880", curveLength: "600" },
    { station: "9999", elevation: "865" },
  ],
  templates: [{
    name: "2-lane",
    left: [{ name: "lane", width: "12", slopePercent: "-2" }],
    right: [{ name: "lane", width: "12", slopePercent: "-2" }],
  }],
  drops: [{ template: "2-lane", toStation: "" }],
});

const alt = (label: string, radius: string): AlternativeInput => ({
  label, rationale: `radius ${radius}`, form: form(radius),
});

describe("evaluating alternatives", () => {
  it("measures each one without touching the others", () => {
    const out = evaluateAlternatives([alt("tight", "800"), alt("gentle", "3000")]);
    expect(out).toHaveLength(2);
    expect(out[0]!.minRadiusFt).toBe(800);
    expect(out[1]!.minRadiusFt).toBe(3000);
  });

  it("never mutates the caller's forms", () => {
    const a = alt("tight", "800");
    const snapshot = JSON.stringify(a.form);
    evaluateAlternatives([a, alt("gentle", "3000")]);
    expect(JSON.stringify(a.form)).toBe(snapshot);
  });

  it("reports a longer alignment for a gentler curve", () => {
    const out = evaluateAlternatives([alt("tight", "800"), alt("gentle", "3000")]);
    expect(out[1]!.alignmentLengthFt!).toBeGreaterThan(out[0]!.alignmentLengthFt!);
  });

  it("judges each against a design speed when one is given", () => {
    const out = evaluateAlternatives([alt("tight", "800"), alt("gentle", "3000")], 70, 0.06);
    // The gentle option has fewer problems, but not zero: its radius clears the
    // 70 mph minimum while its crest curve does not clear the required K. The
    // check covers vertical geometry too, which is the whole point of running it.
    expect(out[0]!.criteriaFailed!).toBeGreaterThan(out[1]!.criteriaFailed!);
    const radiusVerdicts = (label: string) =>
      out.find((o) => o.label === label)!.failures!.filter((f) => f.check === "minimum-radius");
    expect(radiusVerdicts("tight")).toHaveLength(1);
    expect(radiusVerdicts("gentle")).toHaveLength(0);
  });

  it("explains the failures rather than only counting them", () => {
    const out = evaluateAlternatives([alt("tight", "800"), alt("gentle", "3000")], 70);
    expect(out[0]!.failures![0]!.detail).toContain("BELOW");
  });

  it("skips criteria when no design speed is supplied", () => {
    const out = evaluateAlternatives([alt("a", "800"), alt("b", "3000")]);
    expect(out[0]!.criteriaChecked).toBeUndefined();
  });

  it("keeps an invalid alternative in the list, marked, rather than dropping it", () => {
    const broken = alt("broken", "800");
    broken.form.elements = [];
    const out = evaluateAlternatives([broken, alt("ok", "3000")]);
    expect(out).toHaveLength(2);
    expect(out[0]!.refusal).toBeDefined();
    expect(out[1]!.refusal).toBeUndefined();
  });
});

describe("the alternative set", () => {
  it("holds what was offered and hands back the form only by index", () => {
    const set = new AlternativeSet();
    const alts = [alt("a", "800"), alt("b", "3000")];
    set.offer("which curve?", alts, evaluateAlternatives(alts));
    expect(set.count()).toBe(2);
    expect(set.prompt).toBe("which curve?");
    expect(set.formAt(1)!.elements[1]!.radius).toBe("3000");
    expect(set.formAt(9)).toBeUndefined();
  });

  it("clears completely once a choice is made", () => {
    const set = new AlternativeSet();
    const alts = [alt("a", "800"), alt("b", "3000")];
    set.offer("q", alts, evaluateAlternatives(alts));
    set.clear();
    expect(set.count()).toBe(0);
    expect(set.formAt(0)).toBeUndefined();
  });
});
