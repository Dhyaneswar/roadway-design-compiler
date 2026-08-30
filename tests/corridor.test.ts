import { describe, test, expect } from "vitest";
import { computeCorridor, crossSectionAt } from "../src/kernel/corridor";
import type { RoadDesign } from "../src/schema/road-design";

// Golden example C-1 (hand-computed): straight road, flat grade.
// Tangent 200 ft due east from (1000, 2000), station 0+00, elev 100.00 flat.
// Template "2-lane": lane 12 ft @ −2%, shoulder 6 ft @ −4%, both sides.
// At any station: lane edge offset 12, Δz = −0.24 → z 99.76;
//                 shoulder edge offset 18, Δz = −0.24 − 0.24 = −0.48 → z 99.52.
// Right of an eastbound road is south (n decreases); left is north.
const straight: RoadDesign = {
  name: "C-1",
  alignment: {
    beginStation: 0,
    start: { e: 1000, n: 2000 },
    startAzimuthDeg: 90,
    elements: [{ type: "tangent", length: 200 }],
  },
  profile: {
    pvis: [
      { station: 0, elevation: 100 },
      { station: 200, elevation: 100 },
    ],
  },
  templates: {
    "2-lane": {
      name: "2-lane",
      left: [
        { name: "lane", width: 12, slopePercent: -2 },
        { name: "shoulder", width: 6, slopePercent: -4 },
      ],
      right: [
        { name: "lane", width: 12, slopePercent: -2 },
        { name: "shoulder", width: 6, slopePercent: -4 },
      ],
    },
  },
  drops: [{ template: "2-lane", fromStation: 0, toStation: 200 }],
};

describe("crossSectionAt: straight road C-1", () => {
  test("centerline point carries profile elevation", () => {
    const xs = crossSectionAt(straight, 100);
    expect(xs.centerline.e).toBeCloseTo(1100, 6);
    expect(xs.centerline.n).toBeCloseTo(2000, 6);
    expect(xs.centerline.z).toBeCloseTo(100, 9);
  });

  test("section carries the template name that produced it", () => {
    expect(crossSectionAt(straight, 100).template).toBe("2-lane");
  });

  test("right side points step south and down per template", () => {
    const xs = crossSectionAt(straight, 100);
    expect(xs.right).toHaveLength(2);
    const [lane, shoulder] = xs.right;
    expect(lane!.offset).toBeCloseTo(12, 9);
    expect(lane!.point.n).toBeCloseTo(1988, 6);
    expect(lane!.point.z).toBeCloseTo(99.76, 9);
    expect(shoulder!.offset).toBeCloseTo(18, 9);
    expect(shoulder!.point.n).toBeCloseTo(1982, 6);
    expect(shoulder!.point.z).toBeCloseTo(99.52, 9);
  });

  test("left side mirrors to the north at same elevations", () => {
    const xs = crossSectionAt(straight, 100);
    const [lane, shoulder] = xs.left;
    expect(lane!.point.n).toBeCloseTo(2012, 6);
    expect(lane!.point.z).toBeCloseTo(99.76, 9);
    expect(shoulder!.point.n).toBeCloseTo(2018, 6);
    expect(shoulder!.point.z).toBeCloseTo(99.52, 9);
  });
});

describe("computeCorridor: sweep C-1 at 50 ft", () => {
  test("produces sections at begin, interval steps, and end", () => {
    const corridor = computeCorridor(straight, 50);
    const stations = corridor.sections.map((s) => s.station);
    expect(stations).toEqual([0, 50, 100, 150, 200]);
  });

  test("every section carries both side point sets", () => {
    const corridor = computeCorridor(straight, 50);
    for (const s of corridor.sections) {
      expect(s.left).toHaveLength(2);
      expect(s.right).toHaveLength(2);
    }
  });
});

// Golden example C-2 (hand-computed): cross-section on a curve.
// Alignment H-2: tangent 1000 + arc R=1000 Δ=90 right, begin station 10+00.
// At mid-arc (station 1000+1000+785.3981633974483 = 2785.3981633974483):
//   centerline (1,001,707.1067811865, 499,707.1067811866), heading az 135°.
//   Right offset direction az 225°: unit (−√2/2, −√2/2).
//   Lane edge 12 ft → (1,001,698.6215, 499,698.6215), z = 99.76 on flat 100 profile.
const curved: RoadDesign = {
  name: "C-2",
  alignment: {
    beginStation: 1000,
    start: { e: 1_000_000, n: 500_000 },
    startAzimuthDeg: 90,
    elements: [
      { type: "tangent", length: 1000 },
      { type: "arc", radius: 1000, deltaDeg: 90, direction: "right" },
    ],
  },
  profile: {
    pvis: [
      { station: 1000, elevation: 100 },
      { station: 3570.7963267948966, elevation: 100 },
    ],
  },
  templates: {
    lane: { name: "lane", left: [{ name: "lane", width: 12, slopePercent: -2 }], right: [{ name: "lane", width: 12, slopePercent: -2 }] },
  },
  drops: [{ template: "lane", fromStation: 1000, toStation: 3570.7963267948966 }],
};

describe("crossSectionAt: on a curve, offset follows the radial", () => {
  test("right lane edge at mid-arc matches hand calc", () => {
    const xs = crossSectionAt(curved, 2785.3981633974483);
    const lane = xs.right[0]!;
    expect(lane.point.e).toBeCloseTo(1_001_698.6214574322, 4);
    expect(lane.point.n).toBeCloseTo(499_698.62145743234, 4);
    expect(lane.point.z).toBeCloseTo(99.76, 9);
  });
});

// Golden example C-3 (hand-computed): template transition (taper).
// Straight east 200 ft, flat 100. narrow lane 12 @ −2% → wide lane 24 @ −2%,
// drops [0..100 narrow][100..200 wide, transitionLength 50].
// Width along the taper: sta 100 → 12, sta 125 → 18, sta 150 → 24, sta 175 → 24.
const tapered: RoadDesign = {
  name: "C-3",
  alignment: {
    beginStation: 0,
    start: { e: 1000, n: 2000 },
    startAzimuthDeg: 90,
    elements: [{ type: "tangent", length: 200 }],
  },
  profile: {
    pvis: [
      { station: 0, elevation: 100 },
      { station: 200, elevation: 100 },
    ],
  },
  templates: {
    narrow: { name: "narrow", left: [{ name: "lane", width: 12, slopePercent: -2 }], right: [{ name: "lane", width: 12, slopePercent: -2 }] },
    wide: { name: "wide", left: [{ name: "lane", width: 24, slopePercent: -2 }], right: [{ name: "lane", width: 24, slopePercent: -2 }] },
  },
  drops: [
    { template: "narrow", fromStation: 0, toStation: 100 },
    { template: "wide", fromStation: 100, toStation: 200, transitionLength: 50 },
  ],
};

describe("computeCorridor: template transition tapers linearly", () => {
  const corridor = computeCorridor(tapered, 25);
  const widthAt = (station: number, template: string) => {
    const s = corridor.sections.find((x) => x.station === station && x.template === template)!;
    return s.right[s.right.length - 1]!.offset;
  };

  test("taper start matches the outgoing template exactly", () => {
    expect(widthAt(100, "wide")).toBeCloseTo(12, 9);
  });

  test("mid-taper is the linear blend", () => {
    expect(widthAt(125, "wide")).toBeCloseTo(18, 9);
  });

  test("taper end reaches the incoming template", () => {
    expect(widthAt(150, "wide")).toBeCloseTo(24, 9);
  });

  test("past the taper the full template applies", () => {
    expect(widthAt(175, "wide")).toBeCloseTo(24, 9);
  });

  test("elevations blend too (same slope here → same dz)", () => {
    const s = corridor.sections.find((x) => x.station === 125 && x.template === "wide")!;
    expect(s.right[0]!.point.z).toBeCloseTo(100 - 0.02 * 18, 9);
  });
});
