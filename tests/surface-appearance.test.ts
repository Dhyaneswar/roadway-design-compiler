// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  assignSurfaceColors, codeCategories, codeColor, resolveSurfaceAppearance,
  stableSurfaceColor,
  UNCODED_COLOR, UNCODED_LABEL, type AuthoredMaterial,
} from "../src/viewer/surface-appearance";
import { parseMaterials, parseSurfaces } from "../src/importers/landxml";
import { parseDesignSections } from "../src/importers/design-sections";

/**
 * Three colour sources, kept apart, in the precedence independent QA signed off.
 *
 * The premise here was got wrong once: I reported that LandXML "has nothing to
 * colour by" after searching a 1.2 schema for the attribute NAMES I expected --
 * `color`, `style`, `layer` -- and never searching for the ELEMENTS that
 * actually carry appearance. `<Material>`, `<Boundary>`, `<Symbol>` and
 * `<TextureImage>` were there the whole time, and the sample files use them.
 * These tests exist so the corrected premise cannot quietly rot back.
 */

const parse = (xml: string): Document =>
  new DOMParser().parseFromString(xml, "application/xml");

/** A 2.0-shaped file: one surface, boundaries referencing a material table. */
const twoPointOh = (boundaries: string, materials: string) => `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-2.0" version="2.0">
  <Units><Imperial linearUnit="foot" areaUnit="squareFoot" volumeUnit="cubicFeet"
    angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>
  <Surfaces>
    <Surface name="Ground.tin">
      <SourceData><Boundaries>${boundaries}</Boundaries></SourceData>
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">0 0 10</P><P id="2">100 0 10</P><P id="3">0 100 10</P>
        </Pnts>
        <Faces><F>1 2 3</F></Faces>
      </Definition>
    </Surface>
  </Surfaces>
  <MaterialTable>${materials}</MaterialTable>
</LandXML>`;

const M_GREY = `<Material index="3" color="84,84,84" textureImageScale="35" textureImageRef="ashphalt_1" />`;
const M_CYAN = `<Material index="1" color="0,255,255" textureImageScale="15" textureImageRef="rock10" />`;
const M_SYMBOL = `<Material index="7" symbolRotation="0" symbolRef="OPPointSceneNode" />`;
const B = (m: number) => `<Boundary bndType="texture" m="${m}"><PntList3D>0 0 0</PntList3D></Boundary>`;

describe("surface identity is the neutral fallback", () => {
  it("gives a surface with no authored appearance a stable colour", () => {
    const a = resolveSurfaceAppearance("Slitlager", undefined, []);
    expect(a.source).toBe("surface-identity");
    expect(a.label).toContain("Slitlager");
    expect(a.colorHex).toBe(stableSurfaceColor("Slitlager"));
  });

  it("is stable across calls and across runs", () => {
    expect(stableSurfaceColor("Teoretisk")).toBe(stableSurfaceColor("Teoretisk"));
  });

  it("distinguishes near-anagram surface names", () => {
    // A plain character sum collides on these; real surface sets are close enough.
    const names = ["Berg", "Breg", "Gerb", "Jord", "Terrace", "Teoretisk", "Slitlager"];
    const colours = names.map(stableSurfaceColor);
    expect(new Set(colours).size).toBeGreaterThan(1);
    expect(stableSurfaceColor("Berg")).not.toBe(stableSurfaceColor("Breg"));
  });

  it("never claims an engineering meaning in its label", () => {
    const a = resolveSurfaceAppearance("Slitlager", undefined, []);
    expect(a.label.toLowerCase()).not.toMatch(/asphalt|concrete|gravel|pavement|wearing/);
  });
});

describe("authored 2.0 material colour is used exactly", () => {
  it("uses the referenced RGB when the boundaries agree on one material", () => {
    const doc = parse(twoPointOh(B(3) + B(3), M_GREY));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("authored-material");
    expect(tin!.appearance!.colorHex).toBe(0x545454); // 84,84,84
  });

  it("discloses a texture it cannot render rather than inventing one", () => {
    const doc = parse(twoPointOh(B(3), M_GREY));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.note).toContain("ashphalt_1");
    expect(tin!.appearance!.note).toContain("not rendered");
  });

  it("falls back visibly when regions reference SEVERAL materials", () => {
    // Painting the whole TIN with one of them would assert what the file does not.
    const doc = parse(twoPointOh(B(1) + B(3) + B(3), M_CYAN + M_GREY));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("surface-identity");
    expect(tin!.appearance!.note).toContain("3 authored material regions");
    expect(tin!.appearance!.note).toContain("2 materials");
  });

  it("falls back and says so when the reference does not resolve", () => {
    const doc = parse(twoPointOh(B(99), M_GREY));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("surface-identity");
    expect(tin!.appearance!.note).toContain("does not define");
  });

  it("falls back for a symbol-only material, preserving the symbol name", () => {
    const doc = parse(twoPointOh(B(7), M_SYMBOL));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("surface-identity");
    expect(tin!.appearance!.note).toContain("OPPointSceneNode");
    expect(tin!.appearance!.note).toContain("not rendered");
  });

  it("ignores a malformed colour rather than drawing a wrong one", () => {
    const bad = `<Material index="2" color="not,a,colour" />`;
    const doc = parse(twoPointOh(B(2), bad));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("surface-identity");
  });

  it("reads a material table with no boundaries at all", () => {
    const doc = parse(twoPointOh("", M_GREY + M_CYAN));
    expect(parseMaterials(doc)).toHaveLength(2);
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("surface-identity");
  });

  it("carries non-ASCII surface names through untouched", () => {
    const doc = parse(twoPointOh(B(3), M_GREY).replace("Ground.tin", "Côte d'Été 道路"));
    const [tin] = parseSurfaces(doc);
    expect(tin!.name).toBe("Côte d'Été 道路");
    expect(tin!.appearance!.label).toContain("Côte d'Été 道路");
  });
});

describe("code categories are a labelled view, never a meaning", () => {
  it("gives each distinct code its own colour and keeps the raw string", () => {
    const cats = codeCategories(["KS", "SR", "KS", "BUSS"]);
    expect(cats.map((c) => c.label)).toEqual(["BUSS", "KS", "SR"]);
    expect(cats.find((c) => c.label === "KS")!.count).toBe(2);
    expect(new Set(cats.map((c) => c.colorHex)).size).toBe(3);
  });

  it("puts uncoded points in their own visible bucket, last", () => {
    // The Slitlager case: 4,499 points and not one code.
    const cats = codeCategories(["KS", undefined, undefined, ""]);
    const last = cats[cats.length - 1]!;
    expect(last.label).toBe(UNCODED_LABEL);
    expect(last.colorHex).toBe(UNCODED_COLOR);
    expect(last.count).toBe(3);
    expect(last.source).toBe("uncoded");
  });

  it("an entirely uncoded surface is one honest bucket, not empty", () => {
    const cats = codeCategories([undefined, undefined]);
    expect(cats).toHaveLength(1);
    expect(cats[0]!.label).toBe(UNCODED_LABEL);
  });

  it("an unknown code falls to the uncoded colour rather than a random one", () => {
    expect(codeColor("NOPE", ["KS", "SR"])).toBe(UNCODED_COLOR);
  });

  it("code colours are distinct from the identity palette", () => {
    // A code view must not be mistakable for an identity view.
    const identity = new Set(["Teoretisk", "Slitlager", "Berg", "Jord", "Terrace"]
      .map(stableSurfaceColor));
    const codes = codeCategories(["KS", "SR", "GB", "CB"]).map((c) => c.colorHex);
    for (const c of codes) expect(identity.has(c)).toBe(false);
  });
});

describe("point codes survive the section importer", () => {
  const sections = `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.1" version="1.1">
  <Units><Imperial linearUnit="foot" areaUnit="squareFoot" volumeUnit="cubicFeet"
    angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>
  <CrossSects>
    <CrossSect sta="1000">
      <DesignCrossSectSurf name="Teoretisk" side="right">
        <CrossSectPnt code="KS">-12 100.5</CrossSectPnt>
        <CrossSectPnt code="SR">0 101</CrossSectPnt>
        <CrossSectPnt code="KS">12 100.5</CrossSectPnt>
      </DesignCrossSectSurf>
      <DesignCrossSectSurf name="Slitlager" side="right">
        <CrossSectPnt>-12 100.4</CrossSectPnt>
        <CrossSectPnt>12 100.4</CrossSectPnt>
      </DesignCrossSectSurf>
    </CrossSect>
  </CrossSects>
</LandXML>`;

  it("reads the codes and counts coded against uncoded", () => {
    const out = parseDesignSections(parse(sections), 1);
    const teo = out.find((s) => s.name === "Teoretisk")!;
    expect(teo.codes).toEqual(["KS", "SR"]);
    expect(teo.codedPointCount).toBe(3);
    expect(teo.uncodedPointCount).toBe(0);
  });

  it("an uncoded surface reports zero codes rather than none of anything", () => {
    const out = parseDesignSections(parse(sections), 1);
    const slit = out.find((s) => s.name === "Slitlager")!;
    expect(slit.codes).toEqual([]);
    expect(slit.codedPointCount).toBe(0);
    expect(slit.uncodedPointCount).toBe(2);
  });

  it("the two surfaces get different display colours", () => {
    expect(stableSurfaceColor("Teoretisk")).not.toBe(stableSurfaceColor("Slitlager"));
  });
});

describe("the material parser holds against a table it does not understand", () => {
  it("skips entries with no usable index", () => {
    const doc = parse(twoPointOh("", `<Material color="1,2,3" />` + M_GREY));
    const mats: AuthoredMaterial[] = parseMaterials(doc);
    expect(mats).toHaveLength(1);
    expect(mats[0]!.index).toBe(3);
  });

  it("returns nothing for a file with no material table", () => {
    const doc = parse(twoPointOh("", ""));
    expect(parseMaterials(doc)).toEqual([]);
  });
});

describe("a set of surfaces gets distinct colours, not just stable ones", () => {
  it("gives the real five-surface file five distinct colours", () => {
    // Measured on the Topocad file. At an 8-colour palette "Teoretisk" and
    // "Berg" hashed to the same slot and five surfaces rendered in four
    // colours; a legend that cannot tell two surfaces apart is worse than none.
    const set = assignSurfaceColors(["Teoretisk", "Slitlager", "Terrace", "Berg", "Jord"]);
    expect(new Set(set.values()).size).toBe(5);
  });

  it("independent hashing DOES collide, which is why the set form exists", () => {
    // Found by search rather than hardcoded: which names collide depends on the
    // palette size, but that some pair does is a pigeonhole certainty, and the
    // set form has to separate whichever pair it is.
    let first = "", second = "";
    search: for (let i = 0; i < 200; i += 1) {
      for (let j = i + 1; j < 200; j += 1) {
        if (stableSurfaceColor(`S${i}`) === stableSurfaceColor(`S${j}`)) {
          first = `S${i}`; second = `S${j}`; break search;
        }
      }
    }
    expect(first).not.toBe("");
    expect(stableSurfaceColor(first)).toBe(stableSurfaceColor(second));

    const set = assignSurfaceColors([first, second]);
    expect(set.get(first)).not.toBe(set.get(second));
  });

  it("is stable regardless of the order the surfaces arrived in", () => {
    const a = assignSurfaceColors(["Teoretisk", "Slitlager", "Terrace", "Berg", "Jord"]);
    const b = assignSurfaceColors(["Jord", "Berg", "Terrace", "Slitlager", "Teoretisk"]);
    for (const [name, colour] of a) expect(b.get(name)).toBe(colour);
  });

  it("ignores duplicate names rather than consuming two slots", () => {
    const set = assignSurfaceColors(["Berg", "Berg", "Jord"]);
    expect(set.size).toBe(2);
  });

  it("keeps going past the palette size instead of failing", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Surface ${i}`);
    const set = assignSurfaceColors(many);
    expect(set.size).toBe(40);
    for (const name of many) expect(typeof set.get(name)).toBe("number");
  });

  it("an empty set is an empty assignment", () => {
    expect(assignSurfaceColors([]).size).toBe(0);
  });
});

describe("F021 -- a missing boundary reference is not a reference to material 0", () => {
  const M_ZERO = `<Material index="0" color="9,8,7" />`;

  it("ignores a Boundary with no m attribute", () => {
    const doc = parse(twoPointOh(`<Boundary bndType="texture"><PntList3D>0 0 0</PntList3D></Boundary>`,
      M_ZERO));
    const [tin] = parseSurfaces(doc);
    // It used to be painted #090807 and labelled authored.
    expect(tin!.appearance!.source).toBe("surface-identity");
    expect(tin!.appearance!.colorHex).not.toBe(0x090807);
    expect(tin!.appearance!.note).toBeUndefined();
  });

  it("ignores a blank m attribute", () => {
    const doc = parse(twoPointOh(`<Boundary bndType="texture" m="  "><PntList3D>0 0 0</PntList3D></Boundary>`,
      M_ZERO));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("surface-identity");
  });

  it("ignores a non-numeric m attribute", () => {
    const doc = parse(twoPointOh(`<Boundary bndType="texture" m="grass"><PntList3D>0 0 0</PntList3D></Boundary>`,
      M_ZERO));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("surface-identity");
  });

  it("still honours a real m=0 reference when the file means it", () => {
    const doc = parse(twoPointOh(`<Boundary bndType="texture" m="0"><PntList3D>0 0 0</PntList3D></Boundary>`,
      M_ZERO));
    const [tin] = parseSurfaces(doc);
    expect(tin!.appearance!.source).toBe("authored-material");
    expect(tin!.appearance!.colorHex).toBe(0x090807);
  });
});

describe("F020 -- an imported name is never markup", () => {
  it("carries a hostile surface name through the parser as inert text", () => {
    // No double quotes: they would terminate the XML attribute this is placed
    // in, and the point is a name the PARSER accepts, not a malformed file.
    const hostile = `<em id=qaLegendInjection>x</em>`;
    const doc = parse(twoPointOh(B(3), M_GREY)
      .replace("Ground.tin", hostile.replace(/</g, "&lt;").replace(/>/g, "&gt;")));
    const [tin] = parseSurfaces(doc);
    // The parser decodes the entities, so the NAME really does contain markup.
    // That is fine and expected -- it must never reach the DOM as markup.
    expect(tin!.name).toBe(hostile);
    expect(tin!.appearance!.label).toContain(hostile);
  });

  it("a hostile point code survives as an opaque string", () => {
    const sections = `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.1" version="1.1">
  <CrossSects><CrossSect sta="1000">
    <DesignCrossSectSurf name="S" side="right">
      <CrossSectPnt code="&lt;img src=x onerror=1&gt;">-12 100</CrossSectPnt>
      <CrossSectPnt code="&lt;img src=x onerror=1&gt;">12 100</CrossSectPnt>
    </DesignCrossSectSurf>
  </CrossSect></CrossSects>
</LandXML>`;
    const [surf] = parseDesignSections(parse(sections), 1);
    expect(surf!.codes).toEqual(["<img src=x onerror=1>"]);
    // codeCategories must not transform or strip it -- it is data, not markup.
    const cats = codeCategories(surf!.runs.flatMap((r) => r.points.map((p) => p.code)));
    expect(cats[0]!.label).toBe("<img src=x onerror=1>");
  });
});
