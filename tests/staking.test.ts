import { describe, expect, it } from "vitest";
import { stakingRows, toStakingCsv } from "../src/exporters/staking";
import { parseRoadDesign } from "../src/schema/validate";
import type { RoadDesign } from "../src/schema/road-design";

const design = (): RoadDesign =>
  parseRoadDesign({
    name: "Staking Test",
    alignment: {
      beginStation: 1000,
      start: { e: 2200000, n: 1350000 },
      startAzimuthDeg: 90,
      elements: [{ type: "tangent", length: 400 }],
    },
    profile: { pvis: [{ station: 1000, elevation: 100 }, { station: 1400, elevation: 108 }] },
    templates: {
      "2-lane": {
        name: "2-lane",
        left: [{ name: "lane", width: 12, slopePercent: -2 }],
        right: [{ name: "lane", width: 12, slopePercent: -2 }],
      },
    },
    drops: [{ template: "2-lane", fromStation: 1000, toStation: 1400 }],
  });

describe("staking rows", () => {
  it("emits the centreline and both template points at each station", () => {
    const rows = stakingRows(design(), { intervalFt: 100 });
    // stations 1000,1100,1200,1300,1400 → 5 sections × 3 points
    expect(rows).toHaveLength(15);
    expect(rows.filter((r) => r.pointName === "CL")).toHaveLength(5);
  });

  it("signs offsets left-negative, right-positive, so a crew is not misled", () => {
    const rows = stakingRows(design(), { intervalFt: 200 });
    const at1000 = rows.filter((r) => r.stationFt === 1000);
    const offsets = at1000.map((r) => r.offsetFt).sort((a, b) => a - b);
    expect(offsets).toEqual([-12, 0, 12]);
  });

  it("can emit the centreline alone", () => {
    const rows = stakingRows(design(), { intervalFt: 100, includeOffsets: false });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.pointName === "CL")).toBe(true);
  });

  it("carries the profile elevation onto the centreline points", () => {
    const rows = stakingRows(design(), { intervalFt: 400, includeOffsets: false });
    expect(rows[0]!.elevationFt).toBeCloseTo(100, 6);
    expect(rows[rows.length - 1]!.elevationFt).toBeCloseTo(108, 6);
  });

  it("drops the edge by the cross slope, not by the profile", () => {
    const rows = stakingRows(design(), { intervalFt: 400 });
    const cl = rows.find((r) => r.stationFt === 1000 && r.pointName === "CL")!;
    const edge = rows.find((r) => r.stationFt === 1000 && r.offsetFt === 12)!;
    // -2% over 12 ft = -0.24 ft
    expect(edge.elevationFt - cl.elevationFt).toBeCloseTo(-0.24, 6);
  });

  it("refuses a non-positive interval rather than looping forever", () => {
    expect(() => stakingRows(design(), { intervalFt: 0 })).toThrow(RangeError);
    expect(() => stakingRows(design(), { intervalFt: -5 })).toThrow(RangeError);
  });
});

describe("staking CSV", () => {
  const csv = () => toStakingCsv(design(), { intervalFt: 100 });

  it("names the units in the header, because ambiguous units build roads in the wrong place", () => {
    expect(csv()).toContain("US survey feet");
    expect(csv()).toContain("easting_ft,northing_ft,elevation_ft");
  });

  it("states the offset convention", () => {
    expect(csv()).toContain("negative = left of centreline");
  });

  it("carries the not-for-construction warning into the file itself", () => {
    expect(csv()).toContain("NOT FOR CONSTRUCTION");
  });

  it("writes a formatted station alongside the raw feet", () => {
    expect(csv()).toContain("10+00.00");
  });

  it("has one line per row plus the header block", () => {
    const lines = csv().trim().split("\n");
    const dataLines = lines.filter((l) => !l.startsWith("#") && !l.startsWith("station,"));
    expect(dataLines).toHaveLength(15);
  });

  it("says so when no CRS is set rather than implying one", () => {
    expect(csv()).toContain("CRS not set");
  });
});
