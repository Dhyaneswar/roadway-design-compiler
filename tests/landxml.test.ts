import { describe, test, expect } from "vitest";
import { toLandXML } from "../src/exporters/landxml";
import type { HorizontalAlignment, VerticalProfile } from "../src/schema/road-design";

// Export golden example H-2 + V-1 and assert LandXML 1.2 structure.
// LandXML point text order is "northing easting".
const alignment: HorizontalAlignment = {
  beginStation: 1000,
  start: { e: 1_000_000, n: 500_000 },
  startAzimuthDeg: 90,
  elements: [
    { type: "tangent", length: 1000 },
    { type: "arc", radius: 1000, deltaDeg: 90, direction: "right" },
    { type: "tangent", length: 500 },
  ],
};

const profile: VerticalProfile = {
  pvis: [
    { station: 1000, elevation: 100 },
    { station: 2300, elevation: 126, curveLength: 600 },
    { station: 4070, elevation: 90.6 },
  ],
};

describe("toLandXML", () => {
  const xml = toLandXML({
    name: "SR-TEST",
    alignment,
    profile,
    crs: {
      zone: "GA-West",
      epsgCode: 2240,
      horizontalDatum: "NAD83 / Georgia Coordinate System of 1985, West Zone",
      verticalDatum: "NAVD88",
      coordinateBasis: "grid",
    },
  });

  test("emits CoordinateSystem with EPSG code for georeferencing", () => {
    expect(xml).toMatch(
      /<CoordinateSystem desc="NAD83 \/ Georgia Coordinate System of 1985, West Zone \| vertical: NAVD88 \| basis: grid" epsgCode="2240"\/>/,
    );
    // LandXML sequence: Units, then CoordinateSystem, then Project
    expect(xml.indexOf("<CoordinateSystem")).toBeGreaterThan(xml.indexOf("</Units>"));
    expect(xml.indexOf("<CoordinateSystem")).toBeLessThan(xml.indexOf("<Project"));
  });

  test("has LandXML 1.2 root and US survey foot units", () => {
    expect(xml).toContain('<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2"');
    expect(xml).toContain('version="1.2"');
    expect(xml).toContain('linearUnit="USSurveyFoot"');
  });

  test("units declare angular and direction conventions (ORD requires them)", () => {
    expect(xml).toContain('angularUnit="decimal degrees"');
    expect(xml).toContain('directionUnit="decimal degrees"');
  });

  test("includes a Project element", () => {
    expect(xml).toContain('<Project name="SR-TEST"/>');
  });

  test("lines carry dir attributes (azimuth, decimal degrees)", () => {
    expect(xml).toMatch(/<Line dir="90\.000000" length="1000\.000000">/);
  });

  test("curve carries crvType, dirStart/dirEnd, and a PI point", () => {
    expect(xml).toMatch(/<Curve[^>]*crvType="arc"/);
    expect(xml).toMatch(/<Curve[^>]*dirStart="90\.000000"/);
    expect(xml).toMatch(/<Curve[^>]*dirEnd="180\.000000"/);
    // PI = PC + T·(unit heading) = (1001000,500000) + 1000·east = (1002000, 500000)
    expect(xml).toContain("<PI>500000.000000 1002000.000000</PI>");
  });

  test("alignment carries name, length, and staStart", () => {
    expect(xml).toContain('<Alignment name="SR-TEST"');
    expect(xml).toContain('length="3070.796327"');
    expect(xml).toContain('staStart="1000.000000"');
  });

  test("entry tangent is a Line with northing-easting point order", () => {
    expect(xml).toContain("<Start>500000.000000 1000000.000000</Start>");
    expect(xml).toContain("<End>500000.000000 1001000.000000</End>");
  });

  test("arc is a Curve with rot=cw, radius, and center point", () => {
    expect(xml).toMatch(/<Curve[^>]*rot="cw"/);
    expect(xml).toMatch(/<Curve[^>]*radius="1000\.000000"/);
    expect(xml).toContain("<Center>499000.000000 1001000.000000</Center>");
  });

  test("profile carries PVIs and a ParaCurve with length", () => {
    expect(xml).toContain('<ProfAlign name="SR-TEST-profile">');
    expect(xml).toContain("<PVI>1000.000000 100.000000</PVI>");
    expect(xml).toContain('<ParaCurve length="600.000000">2300.000000 126.000000</ParaCurve>');
    expect(xml).toContain("<PVI>4070.000000 90.600000</PVI>");
  });
});
