import { describe, test, expect } from "vitest";
import { dmsToDegrees } from "../../src/util/angle";
import { computeHorizontal } from "../../src/kernel/horizontal";
import type { HorizontalAlignment } from "../../src/schema/road-design";

// RoadBench #2 — PI 0000297, SR 3/US 19 Widening (Upson Co., FINAL 09/06/18).
// Sheet 47 (dwg 13-0002) printed values:
//   PI 113+23.00 at N=1,065,374.3530 E=2,245,256.3790
//   bearing in  N 0°34'50.1" E, bearing out N 0°16'04.5" E (angle point, no curve)
//   Denham St ℄: N 88°37'59.0" W; intersection at mainline STA 114+23.93
//   printed intersection angle: 88°54'04"
// See corpus/0000297-sr3-us19/README.md.

const azIn = dmsToDegrees(0, 34, 50.1); // N..E → azimuth = bearing
const azOutPrinted = dmsToDegrees(0, 16, 4.5);
const deflection = azIn - azOutPrinted; // left turn (azimuth decreases)

const DEG = Math.PI / 180;
const pi = { e: 2_245_256.379, n: 1_065_374.353 };
const backDist = 100;
const start = {
  e: pi.e - backDist * Math.sin(azIn * DEG),
  n: pi.n - backDist * Math.cos(azIn * DEG),
};

const mainline: HorizontalAlignment = {
  beginStation: 11_323.0 - backDist,
  start,
  startAzimuthDeg: azIn,
  elements: [
    { type: "tangent", length: backDist },
    { type: "deflection", deflectionDeg: deflection, direction: "left" },
    { type: "tangent", length: 11_423.93 - 11_323.0 }, // to Denham St ℄
  ],
};

describe("RoadBench #2: SR 3/US 19 angle point at PI 113+23.00", () => {
  const h = computeHorizontal(mainline);

  test("deflection between printed bearings is 0°18'45.6\"", () => {
    expect(deflection).toBeCloseTo(dmsToDegrees(0, 18, 45.6), 9);
  });

  test("angle point sits at station 113+23.00", () => {
    const d = h.elements[1]!;
    expect(d.type).toBe("deflection");
    expect(d.beginStation).toBeCloseTo(11_323.0, 6);
  });

  test("outgoing bearing matches the printed N 0°16'04.5\" E", () => {
    expect(h.azimuthAt(backDist + 0.001)).toBeCloseTo(azOutPrinted, 3);
  });

  test("intersection angle with Denham St reproduces the printed 88°54'04\"", () => {
    // Denham ℄ bearing N 88°37'59.0" W → azimuth 360° − 88°37'59"
    const denhamAz = 360 - dmsToDegrees(88, 37, 59.0);
    const mainlineAzAtIntersection = h.azimuthAt(backDist + (11_423.93 - 11_323.0));
    const angle = 360 - (denhamAz - mainlineAzAtIntersection);
    // printed value rounds to the nearest second
    expect(angle).toBeCloseTo(dmsToDegrees(88, 54, 4), 3);
  });

  test("alignment end lands on the new bearing from the printed PI", () => {
    const end = h.pointAt(h.length);
    const t2 = 11_423.93 - 11_323.0;
    expect(end.e).toBeCloseTo(pi.e + t2 * Math.sin(azOutPrinted * DEG), 4);
    expect(end.n).toBeCloseTo(pi.n + t2 * Math.cos(azOutPrinted * DEG), 4);
  });
});
