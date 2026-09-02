// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { describeCodes, type CodedSurfaceCounts } from "../src/viewer/surface-appearance";

/**
 * The legend says what IS there, not what is absent.
 *
 * It read `no codes · 12 uncoded` — which states the absence twice and the
 * presence never, and reads like a sentence somebody stopped writing. And where
 * codes did exist it listed their names with one lump total, so a code marking
 * four points looked exactly like one marking four thousand.
 */

const surf = (o: Partial<CodedSurfaceCounts>): CodedSurfaceCounts => ({
  codes: [],
  codeCounts: {},
  codedPointCount: 0,
  uncodedPointCount: 0,
  ...o,
});

describe("a surface with no codes at all", () => {
  it("says how many points there are, not that codes are missing", () => {
    expect(describeCodes(surf({ uncodedPointCount: 12 }))).toBe("12 points, all uncoded");
  });

  it("never uses the old phrasing", () => {
    const s = describeCodes(surf({ uncodedPointCount: 12 }));
    expect(s).not.toContain("no codes");
    // "12 uncoded" alone was the half-sentence; the count must be attached to
    // a noun the reader can picture.
    expect(s).toContain("points");
  });

  it("handles a surface with no points at all rather than saying '0 points, all uncoded'", () => {
    expect(describeCodes(surf({}))).toBe("no points");
  });
});

describe("a surface whose points carry codes", () => {
  it("weighs each code instead of only naming it", () => {
    expect(describeCodes(surf({
      codes: ["CL", "EP"],
      codeCounts: { EP: 8, CL: 4 },
      codedPointCount: 12,
      uncodedPointCount: 2,
    }))).toBe("Codes: EP (8), CL (4) · 2 uncoded");
  });

  it("drops the uncoded clause when every point is coded", () => {
    expect(describeCodes(surf({
      codes: ["CL", "EP"],
      codeCounts: { EP: 8, CL: 4 },
      codedPointCount: 12,
    }))).toBe("Codes: EP (8), CL (4)");
  });

  it("puts the busiest code first, whatever order the file listed them", () => {
    const s = describeCodes(surf({
      codes: ["AAA", "ZZZ"],
      codeCounts: { AAA: 2, ZZZ: 900 },
      codedPointCount: 902,
    }));
    expect(s).toBe("Codes: ZZZ (900), AAA (2)");
  });

  it("breaks ties by name so the order does not wobble between renders", () => {
    const a = describeCodes(surf({
      codes: ["B", "A"], codeCounts: { B: 5, A: 5 }, codedPointCount: 10,
    }));
    const b = describeCodes(surf({
      codes: ["A", "B"], codeCounts: { A: 5, B: 5 }, codedPointCount: 10,
    }));
    expect(a).toBe("Codes: A (5), B (5)");
    expect(a).toBe(b);
  });

  it("truncates a long code list rather than stretching the legend", () => {
    // A survey file can carry dozens of codes; the legend is a key, not a report.
    const counts: Record<string, number> = {};
    for (let i = 0; i < 9; i += 1) counts[`C${i}`] = 100 - i;
    const s = describeCodes(surf({
      codes: Object.keys(counts), codeCounts: counts, codedPointCount: 800,
    }));
    expect(s).toBe("Codes: C0 (100), C1 (99), C2 (98), C3 (97), +5 more");
    // The reader is told something was withheld, never silently shown a subset.
    expect(s).toContain("+5 more");
  });
});

describe("the identity caveat is not repeated per row", () => {
  it("describeCodes never emits it", () => {
    // It belongs once, in the legend header's tooltip -- repeated on every row
    // it read as noise rather than as the warning it is.
    for (const s of [
      describeCodes(surf({ uncodedPointCount: 5 })),
      describeCodes(surf({ codes: ["EP"], codeCounts: { EP: 3 }, codedPointCount: 3 })),
    ]) {
      expect(s).not.toContain("identity");
    }
  });
});
