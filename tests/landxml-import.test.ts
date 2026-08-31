// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseLandXML } from "../src/importers/landxml";
import { toLandXML } from "../src/exporters/landxml";
import { parseRoadDesign } from "../src/schema/validate";
import { computeHorizontal } from "../src/kernel/horizontal";
import type { RoadDesign } from "../src/schema/road-design";

const design = (): RoadDesign =>
  parseRoadDesign({
    name: "Round Trip",
    alignment: {
      beginStation: 1000,
      start: { e: 2200000, n: 1350000 },
      startAzimuthDeg: 75,
      elements: [
        { type: "tangent", length: 1200 },
        { type: "arc", radius: 1500, deltaDeg: 45, direction: "right" },
        { type: "tangent", length: 800 },
        { type: "arc", radius: 2000, deltaDeg: 30, direction: "left" },
      ],
    },
    profile: {
      pvis: [
        { station: 1000, elevation: 850 },
        { station: 2500, elevation: 880, curveLength: 600 },
        { station: 5225.294839, elevation: 865 },
      ],
    },
    templates: {
      "2-lane": { name: "2-lane",
        left: [{ name: "lane", width: 12, slopePercent: -2 }],
        right: [{ name: "lane", width: 12, slopePercent: -2 }] },
    },
    drops: [{ template: "2-lane", fromStation: 1000, toStation: 5225.294839 }],
  });

const roundTrip = () => {
  const d = design();
  const xml = toLandXML({ name: d.name, alignment: d.alignment, profile: d.profile });
  return { d, result: parseLandXML(xml) };
};

describe("round-tripping our own export", () => {
  it("reads back what it wrote", () => {
    const { result } = roundTrip();
    expect(result.ok).toBe(true);
  });

  it("recovers every element, in order and by kind", () => {
    const { d, result } = roundTrip();
    if (!result.ok) throw new Error("import failed");
    const got = result.alignments[0]!;
    expect(got.elements.map((e) => e.type)).toEqual(
      d.alignment.elements.map((e) => e.type),
    );
  });

  it("recovers tangent lengths to a hundredth of a foot", () => {
    const { d, result } = roundTrip();
    if (!result.ok) throw new Error("import failed");
    const got = result.alignments[0]!.elements;
    d.alignment.elements.forEach((want, i) => {
      if (want.type !== "tangent") return;
      const have = got[i]!;
      expect(have.type).toBe("tangent");
      if (have.type === "tangent") expect(have.length).toBeCloseTo(want.length, 2);
    });
  });

  it("recovers curve radius, delta and hand", () => {
    const { d, result } = roundTrip();
    if (!result.ok) throw new Error("import failed");
    const got = result.alignments[0]!.elements;
    d.alignment.elements.forEach((want, i) => {
      if (want.type !== "arc") return;
      const have = got[i]!;
      expect(have.type).toBe("arc");
      if (have.type !== "arc") return;
      expect(have.radius).toBeCloseTo(want.radius, 2);
      expect(have.deltaDeg).toBeCloseTo(want.deltaDeg, 2);
      expect(have.direction).toBe(want.direction);
    });
  });

  it("recovers the start point and heading", () => {
    const { d, result } = roundTrip();
    if (!result.ok) throw new Error("import failed");
    const got = result.alignments[0]!;
    expect(got.start.e).toBeCloseTo(d.alignment.start.e, 2);
    expect(got.start.n).toBeCloseTo(d.alignment.start.n, 2);
    expect(got.startAzimuthDeg).toBeCloseTo(d.alignment.startAzimuthDeg, 3);
  });

  it("reproduces the same total length — the claim that actually matters", () => {
    const { d, result } = roundTrip();
    if (!result.ok) throw new Error("import failed");
    const want = computeHorizontal(d.alignment).length;
    const have = computeHorizontal({
      beginStation: result.alignments[0]!.beginStation,
      start: result.alignments[0]!.start,
      startAzimuthDeg: result.alignments[0]!.startAzimuthDeg,
      elements: result.alignments[0]!.elements,
    }).length;
    expect(have).toBeCloseTo(want, 2);
  });

  it("recovers the profile, and strips a curve from the end PVIs", () => {
    const { result } = roundTrip();
    if (!result.ok) throw new Error("import failed");
    const pvis = result.alignments[0]!.pvis;
    expect(pvis.length).toBeGreaterThanOrEqual(3);
    expect(pvis[0]!.curveLength).toBeUndefined();
    expect(pvis[pvis.length - 1]!.curveLength).toBeUndefined();
    expect(pvis[1]!.curveLength).toBeCloseTo(600, 2);
  });
});

describe("refusing what it cannot honestly read", () => {
  const wrap = (inner: string, ns = "http://www.landxml.org/schema/LandXML-1.2") =>
    `<?xml version="1.0"?><LandXML xmlns="${ns}"><Units><Imperial linearUnit="foot"/></Units>${inner}</LandXML>`;

  it("refuses a spiral rather than silently dropping it", () => {
    const r = parseLandXML(wrap(`<Alignments><Alignment name="A" staStart="0"><CoordGeom>
      <Line><Start>0 0</Start><End>100 0</End></Line>
      <Spiral><Start>100 0</Start><End>200 10</End></Spiral>
    </CoordGeom></Alignment></Alignments>`));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("SpiralsNotSupported");
    expect(r.measurements?.spiralCount).toBe(1);
    expect(r.detail).toContain("change the geometry");
  });

  it("says so when a file has no alignments at all", () => {
    const r = parseLandXML(wrap(`<Surfaces><Surface name="eg"/></Surfaces>`));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NoAlignments");
  });

  it("rejects a file that is not LandXML", () => {
    const r = parseLandXML(`<?xml version="1.0"?><SomethingElse/>`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NotLandXml");
  });

  it("rejects malformed XML without throwing", () => {
    const r = parseLandXML("<LandXML><unclosed>");
    expect(r.ok).toBe(false);
  });

  it("names an element missing its geometry", () => {
    const r = parseLandXML(wrap(`<Alignments><Alignment name="A"><CoordGeom>
      <Line><Start>0 0</Start></Line></CoordGeom></Alignment></Alignments>`));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("IncompleteGeometry");
  });
});

describe("real-world variation", () => {
  it("reads LandXML 1.1 as well as 1.2", () => {
    const xml = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.1">
      <Units><Imperial linearUnit="foot"/></Units>
      <Alignments><Alignment name="A" staStart="0"><CoordGeom>
        <Line><Start>0 0</Start><End>100 0</End></Line>
      </CoordGeom></Alignment></Alignments></LandXML>`;
    const r = parseLandXML(xml);
    expect(r.ok).toBe(true);
  });

  it("converts a metric file to US survey feet and says that it did", () => {
    const xml = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.1">
      <Units><Metric linearUnit="meter"/></Units>
      <Alignments><Alignment name="A" staStart="0"><CoordGeom>
        <Line><Start>0 0</Start><End>100 0</End></Line>
      </CoordGeom></Alignment></Alignments></LandXML>`;
    const r = parseLandXML(xml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.alignments[0]!;
    expect(a.sourceUnit).toBe("meter");
    const el = a.elements[0]!;
    if (el.type === "tangent") expect(el.length).toBeCloseTo(328.08, 1);
    expect(a.notes.join(" ")).toContain("metres");
  });

  it("reads coordinates as northing-then-easting, not the reverse", () => {
    // A line running due EAST: northing constant, easting increasing.
    const r = parseLandXML(`<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2">
      <Units><Imperial linearUnit="foot"/></Units>
      <Alignments><Alignment name="A" staStart="0"><CoordGeom>
        <Line><Start>5000 1000</Start><End>5000 1100</End></Line>
      </CoordGeom></Alignment></Alignments></LandXML>`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Due east is azimuth 90. Reading the pair backwards would give 0.
    expect(r.alignments[0]!.startAzimuthDeg).toBeCloseTo(90, 6);
  });

  it("takes a curve's radius from its centre point when one is given", () => {
    const r = parseLandXML(`<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2">
      <Units><Imperial linearUnit="foot"/></Units>
      <Alignments><Alignment name="A" staStart="0"><CoordGeom>
        <Curve rot="cw" radius="999"><Start>0 0</Start><Center>0 500</Center><End>500 500</End></Curve>
      </CoordGeom></Alignment></Alignments></LandXML>`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const el = r.alignments[0]!.elements[0]!;
    // The centre says 500, the stale attribute says 999. Geometry wins.
    if (el.type === "arc") expect(el.radius).toBeCloseTo(500, 6);
  });
});
