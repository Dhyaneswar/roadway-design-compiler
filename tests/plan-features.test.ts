// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parsePlanFeatures, summarisePlanFeatures } from "../src/importers/plan-features";

const doc = (inner: string): Document =>
  new DOMParser().parseFromString(
    `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2">${inner}</LandXML>`,
    "application/xml",
  );

const withPoints = (pts: string, features: string) =>
  doc(`<CgPoints>${pts}</CgPoints><PlanFeatures>${features}</PlanFeatures>`);

const pt = (name: string, body: string) => `<CgPoint name="${name}">${body}</CgPoint>`;
const line = (s: string, e: string) => `<Line><Start ${s}/><End ${e}/></Line>`;
const ref = (n: string) => `pntRef="${n}"`;

describe("resolving geometry", () => {
  it("resolves point references, which most survey geometry uses", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "5000 4000 100") + pt("2", "5100 4000 101"),
      `<PlanFeature name="SDWK1"><CoordGeom>${line(ref("1"), ref("2"))}</CoordGeom></PlanFeature>`,
    ));
    expect(set.features).toHaveLength(1);
    expect(set.unresolvedRefs).toBe(0);
    expect(set.features[0]!.points).toEqual([
      { n: 5000, e: 4000, z: 100 },
      { n: 5100, e: 4000, z: 101 },
    ]);
  });

  it("takes inline coordinates too, in the same file", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "5000 4000 100"),
      `<PlanFeature name="BLDG1"><CoordGeom>` +
        `<Line><Start pntRef="1"/><End>5050 4050 100</End></Line>` +
      `</CoordGeom></PlanFeature>`,
    ));
    expect(set.features[0]!.points[1]).toEqual({ n: 5050, e: 4050, z: 100 });
  });

  it("counts a reference it cannot resolve instead of dropping it silently", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "5000 4000"),
      `<PlanFeature name="X"><CoordGeom>${line(ref("1"), ref("999"))}</CoordGeom></PlanFeature>`,
    ));
    expect(set.unresolvedRefs).toBe(1);
    expect(set.features).toHaveLength(0);
  });

  it("joins consecutive segments into one run", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "0 0 1") + pt("2", "10 0 1") + pt("3", "10 10 1"),
      `<PlanFeature name="LOT1"><CoordGeom>` +
        line(ref("1"), ref("2")) + line(ref("2"), ref("3")) +
      `</CoordGeom></PlanFeature>`,
    ));
    expect(set.features).toHaveLength(1);
    expect(set.features[0]!.points).toHaveLength(3);
  });

  it("starts a new run rather than drawing across a gap", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "0 0 1") + pt("2", "10 0 1") + pt("3", "500 500 1") + pt("4", "510 500 1"),
      `<PlanFeature name="EP1"><CoordGeom>` +
        line(ref("1"), ref("2")) + line(ref("3"), ref("4")) +
      `</CoordGeom></PlanFeature>`,
    ));
    expect(set.features).toHaveLength(2);
    expect(set.features.every((f) => f.points.length === 2)).toBe(true);
  });

  it("converts a metric file", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "100 200 10") + pt("2", "110 200 10"),
      `<PlanFeature name="M"><CoordGeom>${line(ref("1"), ref("2"))}</CoordGeom></PlanFeature>`,
    ), 3.280833333333333);
    expect(set.features[0]!.points[0]!.n).toBeCloseTo(328.08, 2);
  });

  it("flags a feature whose survey gave no elevation, so it is not drawn at zero", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "0 0") + pt("2", "10 0"),
      `<PlanFeature name="BLDG9"><CoordGeom>${line(ref("1"), ref("2"))}</CoordGeom></PlanFeature>`,
    ));
    expect(set.features[0]!.hasElevation).toBe(false);
  });

  it("reports the site extent", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "100 200 1") + pt("2", "300 500 1"),
      `<PlanFeature name="A"><CoordGeom>${line(ref("1"), ref("2"))}</CoordGeom></PlanFeature>`,
    ));
    expect(set.bounds).toEqual({ minN: 100, maxN: 300, minE: 200, maxE: 500 });
  });

  it("returns nothing for a document with no features", () => {
    const set = parsePlanFeatures(doc("<Surfaces/>"));
    expect(set.features).toEqual([]);
    expect(set.bounds).toBeUndefined();
  });
});

describe("summarising", () => {
  it("groups on the file's own separator, as a label only", () => {
    const set = parsePlanFeatures(withPoints(
      pt("1", "0 0 1") + pt("2", "10 0 1"),
      [`<PlanFeature name="SDWK1|11"><CoordGeom>${line(ref("1"), ref("2"))}</CoordGeom></PlanFeature>`,
       `<PlanFeature name="SDWK1|12"><CoordGeom>${line(ref("1"), ref("2"))}</CoordGeom></PlanFeature>`,
       `<PlanFeature name="BLDG2|9"><CoordGeom>${line(ref("1"), ref("2"))}</CoordGeom></PlanFeature>`].join(""),
    ));
    const rows = summarisePlanFeatures(set);
    expect(rows[0]).toEqual({ group: "SDWK1", count: 2, withElevation: 2 });
    expect(rows.find((r) => r.group === "BLDG2")!.count).toBe(1);
  });
});
