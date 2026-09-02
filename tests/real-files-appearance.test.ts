// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectUnit, FT_PER_M, parseMaterials, parseSurfaces } from "../src/importers/landxml";
import { parseDesignSections } from "../src/importers/design-sections";
import { assignSurfaceColors, codeCategories, UNCODED_LABEL,
  type AuthoredMaterial, type SurfaceAppearance } from "../src/viewer/surface-appearance";

/**
 * Appearance against the REAL sample files, as part of `npm test`.
 *
 * This replaced a standalone oracle that needed a runner nobody had declared.
 *
 * ⚠ EACH FILE IS PARSED ONCE, and only small derived values are kept.
 *
 * The first version reparsed the 3.3 MB Topocad document inside every `it`,
 * seven times in one Happy DOM worker, and the accumulated DOMs plus section
 * models walked V8 into its ~4 GB heap ceiling: the default `npm test` exited 1
 * with a worker error while every assertion in it passed. A test file that
 * cannot run alongside the suite is not a test, and needing an 8 GB override to
 * see it pass is not a fix.
 *
 * So the heavy objects live inside beforeAll and die with it. Nothing below
 * holds a Document, a Tin, or a section's point runs.
 *
 * ⚠ SKIPS when the samples are absent. They are third-party files from
 * LandXML.org that this repository does not redistribute, so a fresh clone has
 * no copy. Skipping is honest; asserting on files that are not there would fail
 * for the wrong reason.
 */

/**
 * Where the samples live, if you have them.
 *
 * ⛔ NOT a hardcoded absolute path any more. It named one developer's drive, so
 * on every other machine these tests skipped silently and the skip looked like
 * a deliberate exclusion rather than a missing directory.
 *
 * Download the files from the links in the README's "Try a terrain import"
 * section, put them in one directory, and point this at it:
 *
 *   ROADWAY_LANDXML_SAMPLE_DIR=/path/to/samples npm test
 */
const SAMPLE_DIR = process.env.ROADWAY_LANDXML_SAMPLE_DIR;

const FILES = {
  allDrives: "ALL-DRIVES AND ROADS-2.0.xml",
  olympus: "Olympus_Subdivision-2.0.xml",
  topocad: "Surface and alignments.xml",
};

/** Resolve a sample by name, or undefined when the corpus is not configured. */
const sample = (name: string): string | undefined =>
  SAMPLE_DIR ? join(SAMPLE_DIR, name) : undefined;

const have = (name: string): boolean => {
  const p = sample(name);
  return p !== undefined && existsSync(p);
};

if (!SAMPLE_DIR) {
  // Said once, out loud. A silent skip is indistinguishable from a pass.
  console.info(
    "real-files-appearance: skipping — set ROADWAY_LANDXML_SAMPLE_DIR to the " +
    "directory holding the LandXML.org samples (see README, 'Try a terrain import'). " +
    "These are third-party files this repository does not redistribute.",
  );
}

/** Everything the assertions need, and nothing that costs megabytes. */
interface SurfaceFacts {
  materialCount: number;
  allHaveColour: boolean;
  materials: AuthoredMaterial[];
  appearance: SurfaceAppearance;
}
interface SectionFacts {
  unit: string;
  names: string[];
  widthFt: Record<string, number>;
  codes: Record<string, string[]>;
  coded: Record<string, number>;
  uncoded: Record<string, number>;
  categories: Record<string, { label: string; count: number }[]>;
  displayed: string[];
  colourCount: number;
}

let allDrives: SurfaceFacts | undefined;
let olympus: SurfaceFacts | undefined;
let topocad: SectionFacts | undefined;

function surfaceFacts(path: string): SurfaceFacts {
  const doc = new DOMParser().parseFromString(readFileSync(path, "utf8"), "application/xml");
  const materials = parseMaterials(doc);
  const [tin] = parseSurfaces(doc);
  // Only the appearance and the material list escape this scope. The Tin --
  // points, faces, the whole mesh -- is unreachable the moment we return.
  return {
    materialCount: materials.length,
    allHaveColour: materials.every((m) => !!m.color),
    materials,
    appearance: tin!.appearance!,
  };
}

function sectionFacts(path: string): SectionFacts {
  const doc = new DOMParser().parseFromString(readFileSync(path, "utf8"), "application/xml");
  const unit = detectUnit(doc);
  const surfaces = parseDesignSections(doc, unit === "meter" ? FT_PER_M : 1);

  const facts: SectionFacts = {
    unit,
    names: surfaces.map((s) => s.name),
    widthFt: {}, codes: {}, coded: {}, uncoded: {}, categories: {},
    displayed: surfaces.filter((s) => s.maxWidthFt < 200).map((s) => s.name).sort(),
    colourCount: new Set(assignSurfaceColors(surfaces.map((s) => s.name)).values()).size,
  };
  for (const s of surfaces) {
    facts.widthFt[s.name] = s.maxWidthFt;
    facts.codes[s.name] = s.codes;
    facts.coded[s.name] = s.codedPointCount;
    facts.uncoded[s.name] = s.uncodedPointCount;
    // Reduced to label+count here; the point runs never leave this function.
    facts.categories[s.name] = codeCategories(
      s.runs.flatMap((r) => r.points.map((p) => p.code)),
    ).map((c) => ({ label: c.label, count: c.count }));
  }
  return facts;
}

beforeAll(() => {
  if (have(FILES.allDrives)) allDrives = surfaceFacts(sample(FILES.allDrives)!);
  if (have(FILES.olympus)) olympus = surfaceFacts(sample(FILES.olympus)!);
  if (have(FILES.topocad)) topocad = sectionFacts(sample(FILES.topocad)!);
});

describe.skipIf(!have(FILES.allDrives))("ALL-DRIVES 2.0 — 24 materials, 71 regions", () => {
  it("reads the whole material table with RGB", () => {
    expect(allDrives!.materialCount).toBe(24);
    expect(allDrives!.allHaveColour).toBe(true);
  });

  it("falls back to identity across many materials, and says why", () => {
    const a = allDrives!.appearance;
    // One colour for 24 authored materials would assert what the file does not.
    expect(a.source).toBe("surface-identity");
    expect(a.regionCount).toBe(71);
    expect(a.note).toContain("authored material regions");
    expect(a.declaredMaterials).toHaveLength(24);
  });
});

describe.skipIf(!have(FILES.olympus))("Olympus 2.0 — colour, texture and symbol", () => {
  it("keeps the authored grey and its texture reference", () => {
    const grey = olympus!.materials.find((m) => m.index === 3)!;
    expect(grey.color).toEqual([84, 84, 84]);
    expect(grey.textureImageRef).toBe("ashphalt_1");
  });

  it("returns OPPointSceneNode even though no boundary references it", () => {
    // The symbol-only material 1 is declared but unreferenced -- Olympus's
    // boundaries use 2 and 3. Reporting only the referenced subset dropped it,
    // while the app claimed to preserve symbols.
    const a = olympus!.appearance;
    const declared = a.declaredMaterials ?? [];
    const referenced = a.authoredMaterials ?? [];

    expect(declared.some((m) => m.symbolRef === "OPPointSceneNode")).toBe(true);
    expect(referenced.some((m) => m.symbolRef === "OPPointSceneNode")).toBe(false);
    expect(declared.length).toBeGreaterThan(referenced.length);
  });

  it("substitutes nothing for what it cannot render", () => {
    expect(olympus!.appearance.note ?? "")
      .not.toMatch(/substitut|approximat|asphalt colour/i);
  });
});

describe.skipIf(!have(FILES.topocad))("Topocad 1.1 — codes, uncoded, and honest units", () => {
  it("is a metric file, and the conversion is applied", () => {
    // ⚠ Reading it with toFt = 1 and labelling the result feet reported 11.8 m
    // as "11.8 ft" -- plausible-looking and wrong by 3.28.
    expect(topocad!.unit).toBe("meter");
    expect(topocad!.widthFt["Teoretisk"]).toBeGreaterThan(38);
    expect(topocad!.widthFt["Teoretisk"]).toBeLessThan(39);
  });

  it("the wide surfaces are thousands of feet, not thousands of metres", () => {
    expect(topocad!.widthFt["Berg"]).toBeGreaterThan(5000);
    expect(topocad!.widthFt["Jord"]).toBeGreaterThan(10000);
  });

  it("carries the coded points and the uncoded ones", () => {
    expect(topocad!.codes["Teoretisk"])
      .toEqual(["BUSS", "CB", "DB", "GB", "KS", "SR", "VK", "VM"]);
    expect(topocad!.coded["Teoretisk"]).toBe(2873);
    expect(topocad!.uncoded["Teoretisk"]).toBe(221);
    expect(topocad!.codes["Slitlager"]).toEqual([]);
    expect(topocad!.uncoded["Slitlager"]).toBe(4499);
  });

  it("an entirely uncoded surface is one honest bucket", () => {
    const cats = topocad!.categories["Slitlager"]!;
    expect(cats).toHaveLength(1);
    expect(cats[0]!.label).toBe(UNCODED_LABEL);
    expect(cats[0]!.count).toBe(4499);
  });

  it("no category label was rewritten into an engineering meaning", () => {
    const codes = topocad!.codes["Teoretisk"]!;
    for (const c of topocad!.categories["Teoretisk"]!) {
      expect(c.label === UNCODED_LABEL || codes.includes(c.label)).toBe(true);
    }
  });

  it("FIVE surfaces are assigned colours; THREE are displayed", () => {
    // Berg and Jord are 5,591 ft and 10,208 ft wide and are filtered from the
    // viewer -- drawing them would bury the road. "Five rendered" was wrong.
    expect(topocad!.names).toHaveLength(5);
    expect(topocad!.colourCount).toBe(5);
    expect(topocad!.displayed).toEqual(["Slitlager", "Teoretisk", "Terrace"]);
  });
});
