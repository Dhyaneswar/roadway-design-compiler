import { describe, test, expect } from "vitest";
import { computeCorridor } from "../src/kernel/corridor";
import { buildCorridorMesh } from "../src/viewer/corridor-mesh";
import type { RoadDesign } from "../src/schema/road-design";

// Golden example M-1: straight road C-1 from corridor.test.ts, 50 ft interval.
// Tangent 200 ft due east from (1000, 2000), elev 100 flat.
// Template: lane 12 @ −2%, shoulder 6 @ −4% both sides.
// Three.js mapping (relative to origin = first centerline point):
//   x = e − origin.e, y = z − origin.z, z = −(n − origin.n)
// Section row order: outermost left → centerline → outermost right.
// At any station: shoulder edge offset 18, Δz −0.48; lane edge offset 12, Δz −0.24.
// Left is north (+n → three z negative); right is south.
const straight: RoadDesign = {
  name: "M-1",
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

/** Element-wise toBeCloseTo — corridor z accumulates FP error (~1e-13 ft). */
function expectVec(got: number[], want: number[], digits = 9): void {
  expect(got).toHaveLength(want.length);
  want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, digits));
}

describe("buildCorridorMesh: straight road M-1 at 50 ft", () => {
  const mesh = buildCorridorMesh(computeCorridor(straight, 50));

  test("origin is the first centerline point", () => {
    expect(mesh.origin).toEqual({ e: 1000, n: 2000, z: 100 });
  });

  test("5 sections × 5 points/row = 25 vertices, 75 position floats", () => {
    expect(mesh.positions).toHaveLength(75);
  });

  test("first row runs left shoulder → centerline → right shoulder in three.js coords", () => {
    // left shoulder edge: n=2018, z=99.52 → (0, −0.48, −18)
    expectVec(mesh.positions.slice(0, 3), [0, -0.48, -18]);
    // left lane edge: n=2012, z=99.76 → (0, −0.24, −12)
    expectVec(mesh.positions.slice(3, 6), [0, -0.24, -12]);
    // centerline → (0, 0, 0)
    expectVec(mesh.positions.slice(6, 9), [0, 0, 0]);
    // right lane edge: n=1988 → (0, −0.24, 12)
    expectVec(mesh.positions.slice(9, 12), [0, -0.24, 12]);
    // right shoulder edge: n=1982 → (0, −0.48, 18)
    expectVec(mesh.positions.slice(12, 15), [0, -0.48, 18]);
  });

  test("third row (station 100) sits 100 ft east", () => {
    // vertex 12 (third row centerline) = rows 0,1 (10 vertices) + 2 into row 2
    const cl = mesh.positions.slice((10 + 2) * 3, (10 + 2) * 3 + 3);
    expectVec(cl, [100, 0, 0]);
  });

  test("4 row pairs × 4 quads × 2 triangles = 96 indices", () => {
    expect(mesh.indices).toHaveLength(96);
  });

  test("first quad triangulates between rows 0 and 1", () => {
    // rows are 5 wide; row 0 base 0, row 1 base 5
    expect(mesh.indices.slice(0, 6)).toEqual([0, 5, 1, 1, 5, 6]);
  });

  test("per-vertex metadata: exact snap targets for the viewer", () => {
    // one entry per vertex
    expect(mesh.pointMeta).toHaveLength(25);
    // first row, outermost-left → outermost-right
    expect(mesh.pointMeta.slice(0, 5)).toEqual([
      { sectionIndex: 0, name: "shoulder", side: "L", offset: 18 },
      { sectionIndex: 0, name: "lane", side: "L", offset: 12 },
      { sectionIndex: 0, name: "CL", side: "CL", offset: 0 },
      { sectionIndex: 0, name: "lane", side: "R", offset: 12 },
      { sectionIndex: 0, name: "shoulder", side: "R", offset: 18 },
    ]);
    // third row belongs to section 2 (station 100)
    expect(mesh.pointMeta[12]).toEqual({ sectionIndex: 2, name: "CL", side: "CL", offset: 0 });
  });

  test("centerline polyline has one point per section, in three.js coords", () => {
    expect(mesh.centerline).toHaveLength(15);
    expectVec(mesh.centerline.slice(0, 3), [0, 0, 0]);
    expectVec(mesh.centerline.slice(6, 9), [100, 0, 0]);
    expectVec(mesh.centerline.slice(12, 15), [200, 0, 0]);
  });

  test("stations array carries one station per section (cursor readout)", () => {
    expect(mesh.stations).toEqual([0, 50, 100, 150, 200]);
  });

  test("one template → one index group covering all triangles", () => {
    expect(mesh.groups).toEqual([{ template: "2-lane", start: 0, count: 96 }]);
  });

  test("one template → no boundaries", () => {
    expect(mesh.boundaries).toEqual([]);
  });

  test("section templates parallel the stations (readout)", () => {
    expect(mesh.sectionTemplates).toEqual(["2-lane", "2-lane", "2-lane", "2-lane", "2-lane"]);
  });
});

describe("buildCorridorMesh: mismatched row widths never bridge", () => {
  // Two drops with different templates: 1 segment/side then 2 segments/side.
  const twoDrops: RoadDesign = {
    ...straight,
    name: "M-2",
    templates: {
      narrow: {
        name: "narrow",
        left: [{ name: "lane", width: 12, slopePercent: -2 }],
        right: [{ name: "lane", width: 12, slopePercent: -2 }],
      },
      wide: straight.templates["2-lane"]!,
    },
    drops: [
      { template: "narrow", fromStation: 0, toStation: 100 },
      { template: "wide", fromStation: 100, toStation: 200 },
    ],
  };
  const mesh = buildCorridorMesh(computeCorridor(twoDrops, 50));

  // Each drop sweeps with its own template, so the shared boundary station
  // (100) appears once per drop: 0, 50, 100 → narrow (3 pts);
  // 100, 150, 200 → wide (5 pts). The template change lands exactly at 100.
  test("vertex total = 3 narrow rows ×3 + 3 wide rows ×5", () => {
    expect(mesh.positions).toHaveLength((3 * 3 + 3 * 5) * 3);
  });

  test("quads exist only within equal-width runs", () => {
    // narrow run: 2 row pairs × 2 quads × 6 = 24; wide run: 2 × 4 × 6 = 48
    expect(mesh.indices).toHaveLength(72);
    // no triangle may cross the narrow/wide boundary:
    // narrow vertices are 0..8, wide are 9..23
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const tri = mesh.indices.slice(i, i + 3);
      const sides = new Set(tri.map((v) => (v! < 9 ? "narrow" : "wide")));
      expect(sides.size).toBe(1);
    }
  });

  test("index groups split per template for per-drop coloring", () => {
    expect(mesh.groups).toEqual([
      { template: "narrow", start: 0, count: 24 },
      { template: "wide", start: 24, count: 48 },
    ]);
  });

  test("template changes emit a boundary with the incoming section outline", () => {
    expect(mesh.boundaries).toHaveLength(1);
    const b = mesh.boundaries[0]!;
    expect(b.station).toBe(100);
    expect(b.template).toBe("wide");
    // incoming wide row: 5 points × 3 floats, leftmost shoulder first
    expect(b.loop).toHaveLength(15);
    // wide row at station 100: left shoulder offset 18 → three z = −18, x = 100
    expect(b.loop[0]).toBeCloseTo(100, 9);
    expect(b.loop[2]).toBeCloseTo(-18, 9);
  });
});

describe("buildCorridorMesh: empty corridor", () => {
  test("throws RangeError", () => {
    expect(() => buildCorridorMesh({ sections: [] })).toThrow(RangeError);
  });
});
