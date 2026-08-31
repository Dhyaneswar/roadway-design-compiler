// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseDesignSections } from "../src/importers/design-sections";

const doc = (inner: string): Document =>
  new DOMParser().parseFromString(
    `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2">${inner}</LandXML>`,
    "application/xml",
  );

const sections = (...rows: string[]) => doc(`<CrossSects>${rows.join("")}</CrossSects>`);

const cs = (sta: number, name: string, side: string, pts: [number, number][]) =>
  `<CrossSect sta="${sta}"><DesignCrossSectSurf name="${name}" side="${side}">` +
  pts.map(([o, e]) => `<CrossSectPnt code="">${o} ${e}</CrossSectPnt>`).join("") +
  `</DesignCrossSectSurf></CrossSect>`;

describe("reading as-designed cross sections", () => {
  it("groups runs by surface name across stations and sides", () => {
    const out = parseDesignSections(sections(
      cs(0, "Wearing", "left", [[-12, 100], [-2, 100.2]]),
      cs(0, "Wearing", "right", [[2, 100.2], [12, 100]]),
      cs(50, "Wearing", "left", [[-12, 101], [-2, 101.2]]),
    ));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Wearing");
    expect(out[0]!.runs).toHaveLength(3);
    expect(out[0]!.stationCount).toBe(2);
  });

  it("converts offsets and elevations by the document's unit", () => {
    const out = parseDesignSections(sections(
      cs(0, "W", "left", [[-10, 20], [0, 21]]),
    ), 3.280833333333333);
    const p = out[0]!.runs[0]!.points;
    expect(p[0]!.offsetFt).toBeCloseTo(-32.81, 2);
    expect(p[0]!.elevationFt).toBeCloseTo(65.62, 2);
    expect(out[0]!.runs[0]!.stationFt).toBe(0);
  });

  it("measures each surface's width, which is what separates pavement from ground", () => {
    const out = parseDesignSections(sections(
      cs(0, "Pavement", "left", [[-12, 100], [0, 100.2]]),
      cs(0, "Ground", "left", [[-800, 90], [800, 95]]),
    ));
    const pav = out.find((s) => s.name === "Pavement")!;
    const gnd = out.find((s) => s.name === "Ground")!;
    expect(pav.maxWidthFt).toBeCloseTo(12, 3);
    expect(gnd.maxWidthFt).toBeCloseTo(1600, 3);
  });

  it("sorts narrowest first, so the pavement surfaces come to hand", () => {
    const out = parseDesignSections(sections(
      cs(0, "Ground", "left", [[-900, 90], [900, 95]]),
      cs(0, "Pavement", "left", [[-12, 100], [0, 100.2]]),
    ));
    expect(out.map((s) => s.name)).toEqual(["Pavement", "Ground"]);
  });

  it("records the elevation range per surface", () => {
    const out = parseDesignSections(sections(
      cs(0, "W", "left", [[-12, 100], [0, 104]]),
      cs(50, "W", "left", [[-12, 96], [0, 99]]),
    ));
    expect(out[0]!.minElevationFt).toBe(96);
    expect(out[0]!.maxElevationFt).toBe(104);
  });

  it("skips a run with fewer than two points, which cannot be a surface", () => {
    const out = parseDesignSections(sections(cs(0, "W", "left", [[-12, 100]])));
    expect(out).toHaveLength(0);
  });

  it("ignores a section with no station rather than placing it at zero", () => {
    const out = parseDesignSections(doc(
      `<CrossSects><CrossSect><DesignCrossSectSurf name="W" side="left">` +
      `<CrossSectPnt>-12 100</CrossSectPnt><CrossSectPnt>0 100</CrossSectPnt>` +
      `</DesignCrossSectSurf></CrossSect></CrossSects>`));
    expect(out).toHaveLength(0);
  });

  it("defaults an unstated side to right rather than dropping the run", () => {
    const out = parseDesignSections(doc(
      `<CrossSects><CrossSect sta="10"><DesignCrossSectSurf name="W">` +
      `<CrossSectPnt>0 100</CrossSectPnt><CrossSectPnt>12 100</CrossSectPnt>` +
      `</DesignCrossSectSurf></CrossSect></CrossSects>`));
    expect(out[0]!.runs[0]!.side).toBe("right");
  });

  it("returns nothing for a document with no cross sections", () => {
    expect(parseDesignSections(doc("<Surfaces/>"))).toEqual([]);
  });
});
