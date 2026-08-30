import { describe, test, expect } from "vitest";
import { sectionOffsets } from "../src/kernel/template-section";
import type { TemplateSegment } from "../src/schema/road-design";

// Golden: GDOT-ish 2-lane half-section. lane 12 @ −2% → (12, −0.24);
// shoulder 6.5 @ −4% → (18.5, −0.24 − 0.26 = −0.50).
const half: TemplateSegment[] = [
  { name: "lane", width: 12, slopePercent: -2 },
  { name: "shoulder", width: 6.5, slopePercent: -4 },
];

describe("sectionOffsets", () => {
  test("accumulates offsets and elevation deltas outward from centerline", () => {
    const pts = sectionOffsets(half);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ name: "lane", offset: 12, dz: -0.24 });
    expect(pts[1]!.offset).toBeCloseTo(18.5, 9);
    expect(pts[1]!.dz).toBeCloseTo(-0.5, 9);
  });

  test("positive slopes rise", () => {
    const pts = sectionOffsets([{ name: "curb", width: 2, slopePercent: 25 }]);
    expect(pts[0]).toEqual({ name: "curb", offset: 2, dz: 0.5 });
  });

  test("empty side yields no points", () => {
    expect(sectionOffsets([])).toEqual([]);
  });
});
