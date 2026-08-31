import { describe, expect, it } from "vitest";
import {
  TinSampler,
  makeTin,
  sampleGround,
  summariseEarthwork,
  tinBounds,
  type TinFace,
  type TinPoint,
} from "../src/kernel/terrain";

/** A 100x100 ft square tilted so elevation rises 10 ft across it, as 2 triangles. */
const ramp = () => {
  const points: TinPoint[] = [
    { n: 0, e: 0, z: 0 },
    { n: 0, e: 100, z: 0 },
    { n: 100, e: 100, z: 10 },
    { n: 100, e: 0, z: 10 },
  ];
  const faces: TinFace[] = [[0, 1, 2], [0, 2, 3]];
  return makeTin("ramp", points, faces);
};

describe("bounds", () => {
  it("covers every point", () => {
    const b = tinBounds(ramp().points);
    expect(b.minN).toBe(0); expect(b.maxN).toBe(100);
    expect(b.minE).toBe(0); expect(b.maxE).toBe(100);
    expect(b.minZ).toBe(0); expect(b.maxZ).toBe(10);
  });

  it("does not blow up on an empty surface", () => {
    expect(() => tinBounds([])).not.toThrow();
  });
});

describe("sampling ground elevation", () => {
  const s = new TinSampler(ramp());

  it("reads a vertex exactly", () => {
    expect(s.elevationAt(0, 0)).toBeCloseTo(0, 9);
    expect(s.elevationAt(100, 100)).toBeCloseTo(10, 9);
  });

  it("interpolates across a triangle", () => {
    // Elevation depends only on northing on this ramp.
    expect(s.elevationAt(50, 50)).toBeCloseTo(5, 6);
    expect(s.elevationAt(25, 75)).toBeCloseTo(2.5, 6);
  });

  it("returns undefined off the surface rather than inventing ground", () => {
    expect(s.elevationAt(-10, 50)).toBeUndefined();
    expect(s.elevationAt(50, 500)).toBeUndefined();
    expect(s.elevationAt(1e6, 1e6)).toBeUndefined();
  });

  it("survives a degenerate triangle instead of dividing by zero", () => {
    const flat = makeTin("degenerate", [
      { n: 0, e: 0, z: 1 }, { n: 0, e: 10, z: 1 }, { n: 0, e: 20, z: 1 },
    ], [[0, 1, 2]]);
    expect(() => new TinSampler(flat).elevationAt(0, 5)).not.toThrow();
  });

  it("indexes rather than scanning: a big surface stays fast", () => {
    // 40x40 grid = 3,200 triangles; 2,000 samples must not take seconds.
    const pts: TinPoint[] = [];
    for (let i = 0; i <= 40; i += 1) {
      for (let j = 0; j <= 40; j += 1) pts.push({ n: i * 10, e: j * 10, z: i + j });
    }
    const fs: TinFace[] = [];
    const idx = (i: number, j: number) => i * 41 + j;
    for (let i = 0; i < 40; i += 1) {
      for (let j = 0; j < 40; j += 1) {
        fs.push([idx(i, j), idx(i, j + 1), idx(i + 1, j + 1)]);
        fs.push([idx(i, j), idx(i + 1, j + 1), idx(i + 1, j)]);
      }
    }
    const big = new TinSampler(makeTin("grid", pts, fs));
    const t0 = Date.now();
    let hits = 0;
    for (let k = 0; k < 2000; k += 1) {
      if (big.elevationAt((k % 400) + 1, ((k * 7) % 400) + 1) !== undefined) hits += 1;
    }
    expect(hits).toBeGreaterThan(1900);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("cut and fill", () => {
  const s = new TinSampler(ramp());
  const along = (designZ: number) =>
    sampleGround(s, [0, 25, 50, 75, 100].map((n, i) => ({ station: i * 100, n, e: 50, designZ })));

  it("calls a road above ground FILL and below it CUT", () => {
    // Ground runs 0 to 10; a design at 5 is fill at the low end, cut at the high.
    const g = along(5);
    expect(g[0]!.cutFillFt!).toBeGreaterThan(0);   // ground 0, design 5 -> fill
    expect(g[4]!.cutFillFt!).toBeLessThan(0);      // ground 10, design 5 -> cut
  });

  it("carries no cut/fill where there is no ground", () => {
    const g = sampleGround(s, [{ station: 0, n: -500, e: -500, designZ: 5 }]);
    expect(g[0]!.groundZ).toBeUndefined();
    expect(g[0]!.cutFillFt).toBeUndefined();
  });

  it("summarises the extremes and counts what fell off the survey", () => {
    const g = [
      ...along(5),
      ...sampleGround(s, [{ station: 900, n: -900, e: 0, designZ: 5 }]),
    ];
    const sum = summariseEarthwork(g);
    expect(sum.sampled).toBe(6);
    expect(sum.offSurface).toBe(1);
    expect(sum.maxFillFt).toBeCloseTo(5, 3);
    expect(sum.maxCutFt).toBeCloseTo(5, 3);
  });

  it("finds where the road crosses ground level", () => {
    const sum = summariseEarthwork(along(5));
    expect(sum.balancePoints).toHaveLength(1);
    // Ground reaches 5 ft at n=50, which is the third sample, station 200.
    expect(sum.balancePoints[0]).toBeCloseTo(200, 0);
  });

  it("reports nothing rather than NaN when every sample is off the surface", () => {
    const sum = summariseEarthwork(
      sampleGround(s, [{ station: 0, n: -1e4, e: -1e4, designZ: 0 }]),
    );
    expect(sum.meanAbsFt).toBe(0);
    expect(sum.maxCutFt).toBe(0);
    expect(sum.balancePoints).toHaveLength(0);
  });
});
