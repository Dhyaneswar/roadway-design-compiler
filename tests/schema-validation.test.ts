import { describe, test, expect } from "vitest";
import { parseRoadDesign } from "../src/schema/validate";

// Alignment: tangent 200 + arc R500 Δ30° → length 200 + 500·π/6 = 461.7994.
// The profile is stationed BY the alignment: it must span begin → end exactly
// (±0.01 ft print-rounding tolerance) — see GEOMETRY-AND-POSITIONING.md.
const ARC_LEN = (500 * Math.PI) / 6;
const END = 200 + ARC_LEN; // 461.7993877991494

const valid = {
  name: "V-OK",
  alignment: {
    beginStation: 0,
    start: { e: 1000, n: 2000 },
    startAzimuthDeg: 90,
    elements: [
      { type: "tangent", length: 200 },
      { type: "arc", radius: 500, deltaDeg: 30, direction: "left" },
    ],
  },
  profile: {
    pvis: [
      { station: 0, elevation: 100 },
      { station: END, elevation: 102 },
    ],
  },
  templates: {
    basic: {
      name: "basic",
      left: [{ name: "lane", width: 12, slopePercent: -2 }],
      right: [{ name: "lane", width: 12, slopePercent: -2 }],
    },
  },
  drops: [{ template: "basic", fromStation: 0, toStation: END }],
};

describe("parseRoadDesign", () => {
  test("accepts a valid document", () => {
    const doc = parseRoadDesign(valid);
    expect(doc.name).toBe("V-OK");
    expect(doc.alignment.elements).toHaveLength(2);
  });

  test("rejects a non-positive arc radius", () => {
    const bad = structuredClone(valid) as any;
    bad.alignment.elements[1].radius = -500;
    expect(() => parseRoadDesign(bad)).toThrow(/radius/i);
  });

  test("rejects a drop referencing an unknown template", () => {
    const bad = structuredClone(valid) as any;
    bad.drops[0].template = "does-not-exist";
    expect(() => parseRoadDesign(bad)).toThrow(/template/i);
  });

  test("rejects PVIs out of station order", () => {
    const bad = structuredClone(valid) as any;
    bad.profile.pvis = [
      { station: END, elevation: 102 },
      { station: 0, elevation: 100 },
    ];
    expect(() => parseRoadDesign(bad)).toThrow(/order/i);
  });
});

describe("parseRoadDesign: profile must span the alignment", () => {
  test("rejects a first PVI not at the begin station", () => {
    const bad = structuredClone(valid) as any;
    bad.profile.pvis[0].station = 10;
    expect(() => parseRoadDesign(bad)).toThrow(/begin station/i);
  });

  test("rejects a last PVI short of the alignment end", () => {
    const bad = structuredClone(valid) as any;
    bad.profile.pvis[1].station = 450;
    expect(() => parseRoadDesign(bad)).toThrow(/end station/i);
  });

  test("accepts endpoints within 0.01 ft (print rounding)", () => {
    const ok = structuredClone(valid) as any;
    ok.profile.pvis[1].station = END - 0.005;
    expect(() => parseRoadDesign(ok)).not.toThrow();
  });
});

describe("parseRoadDesign: vertical curve placement", () => {
  test("rejects a curve on the first PVI", () => {
    const bad = structuredClone(valid) as any;
    bad.profile.pvis[0].curveLength = 100;
    expect(() => parseRoadDesign(bad)).toThrow(/first.*curve|curve.*first/i);
  });

  test("rejects a curve on the last PVI", () => {
    const bad = structuredClone(valid) as any;
    bad.profile.pvis[1].curveLength = 100;
    expect(() => parseRoadDesign(bad)).toThrow(/last.*curve|curve.*last/i);
  });

  test("rejects a curve extending past the previous PVI", () => {
    const bad = structuredClone(valid) as any;
    // PVC = 100 − 125 = −25 < first PVI station 0
    bad.profile.pvis = [
      { station: 0, elevation: 100 },
      { station: 100, elevation: 101, curveLength: 250 },
      { station: END, elevation: 102 },
    ];
    expect(() => parseRoadDesign(bad)).toThrow(/extends past/i);
  });

  test("rejects a curve extending past the next PVI", () => {
    const bad = structuredClone(valid) as any;
    // PVT = 400 + 100 = 500 > END (461.80)
    bad.profile.pvis = [
      { station: 0, elevation: 100 },
      { station: 400, elevation: 101, curveLength: 200 },
      { station: END, elevation: 102 },
    ];
    expect(() => parseRoadDesign(bad)).toThrow(/extends past/i);
  });

  test("rejects overlapping curves at consecutive PVIs", () => {
    const bad = structuredClone(valid) as any;
    // PVT₁ = 150+60 = 210 > PVC₂ = 250−60 = 190 — both within their own
    // neighbor bounds, only the pairwise check can catch this
    bad.profile.pvis = [
      { station: 0, elevation: 100 },
      { station: 150, elevation: 101, curveLength: 120 },
      { station: 250, elevation: 100.5, curveLength: 120 },
      { station: END, elevation: 102 },
    ];
    expect(() => parseRoadDesign(bad)).toThrow(/overlap/i);
  });

  test("accepts adjacent curves that just touch (PVT₁ = PVC₂)", () => {
    const ok = structuredClone(valid) as any;
    // PVT₁ = 150+50 = 200 = PVC₂ = 250−50
    ok.profile.pvis = [
      { station: 0, elevation: 100 },
      { station: 150, elevation: 101, curveLength: 100 },
      { station: 250, elevation: 100.5, curveLength: 100 },
      { station: END, elevation: 102 },
    ];
    expect(() => parseRoadDesign(ok)).not.toThrow();
  });
});

describe("parseRoadDesign: template drops are stationed by the alignment", () => {
  test("rejects a drop extending past the alignment end", () => {
    const bad = structuredClone(valid) as any;
    bad.drops = [{ template: "basic", fromStation: 0, toStation: END + 50 }];
    expect(() => parseRoadDesign(bad)).toThrow(/alignment range/i);
  });

  test("rejects a drop starting before the begin station", () => {
    const bad = structuredClone(valid) as any;
    bad.drops = [{ template: "basic", fromStation: -10, toStation: END }];
    expect(() => parseRoadDesign(bad)).toThrow(/alignment range/i);
  });

  test("rejects an empty or inverted drop range", () => {
    const bad = structuredClone(valid) as any;
    bad.drops = [{ template: "basic", fromStation: 200, toStation: 200 }];
    expect(() => parseRoadDesign(bad)).toThrow(/before its to-station/i);
  });

  test("rejects overlapping drops", () => {
    const bad = structuredClone(valid) as any;
    bad.drops = [
      { template: "basic", fromStation: 0, toStation: 250 },
      { template: "basic", fromStation: 200, toStation: END },
    ];
    expect(() => parseRoadDesign(bad)).toThrow(/overlap/i);
  });

  test("accepts drops that tile the range exactly", () => {
    const ok = structuredClone(valid) as any;
    ok.drops = [
      { template: "basic", fromStation: 0, toStation: 250 },
      { template: "basic", fromStation: 250, toStation: END },
    ];
    expect(() => parseRoadDesign(ok)).not.toThrow();
  });

  test("accepts a partial-coverage drop (corridors may model a sub-range)", () => {
    const ok = structuredClone(valid) as any;
    ok.drops = [{ template: "basic", fromStation: 100, toStation: 300 }];
    expect(() => parseRoadDesign(ok)).not.toThrow();
  });
});

describe("parseRoadDesign: template transitions", () => {
  const withWide = () => {
    const d = structuredClone(valid) as any;
    d.templates.wide = {
      name: "wide",
      left: [{ name: "lane", width: 24, slopePercent: -2 }],
      right: [{ name: "lane", width: 24, slopePercent: -2 }],
    };
    d.drops = [
      { template: "basic", fromStation: 0, toStation: 250 },
      { template: "wide", fromStation: 250, toStation: END, transitionLength: 100 },
    ];
    return d;
  };

  test("accepts a transition between templates with matching segment counts", () => {
    expect(() => parseRoadDesign(withWide())).not.toThrow();
  });

  test("rejects a transition longer than its drop", () => {
    const bad = withWide();
    bad.drops[1].transitionLength = 500;
    expect(() => parseRoadDesign(bad)).toThrow(/transition.*longer|exceed/i);
  });

  test("rejects a transition with no adjacent previous drop", () => {
    const bad = withWide();
    bad.drops[0].toStation = 200; // gap 200..250 before the transitioning drop
    expect(() => parseRoadDesign(bad)).toThrow(/transition.*previous drop/i);
  });

  test("rejects a transition between templates with mismatched segment counts", () => {
    const bad = withWide();
    bad.templates.wide.left.push({ name: "shoulder", width: 6, slopePercent: -4 });
    expect(() => parseRoadDesign(bad)).toThrow(/segment count/i);
  });

  test("rejects a transition on the first drop", () => {
    const bad = withWide();
    bad.drops = [{ template: "basic", fromStation: 0, toStation: END, transitionLength: 50 }];
    expect(() => parseRoadDesign(bad)).toThrow(/transition.*previous drop/i);
  });
});
