import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEIGHT_FT,
  checkRoadside,
  heightOf,
  lengthOf,
  roadsideQuantities,
  type RoadsideItem,
} from "../src/schema/roadside";

const rail = (over: Partial<RoadsideItem> = {}): RoadsideItem => ({
  id: "gr-1",
  kind: "guardrail",
  side: "left",
  beginStation: 1200,
  endStation: 1800,
  offsetFt: 8,
  ...over,
});

describe("measuring an item", () => {
  it("takes its length along the road", () => {
    expect(lengthOf(rail())).toBe(600);
  });

  it("never reports a negative length", () => {
    expect(lengthOf(rail({ beginStation: 1800, endStation: 1200 }))).toBe(0);
  });

  it("uses the authored height when there is one, the default otherwise", () => {
    expect(heightOf(rail())).toBe(DEFAULT_HEIGHT_FT.guardrail);
    expect(heightOf(rail({ heightFt: 3.1 }))).toBe(3.1);
  });

  it("gives a marking no height", () => {
    expect(heightOf(rail({ kind: "pavement-marking", pattern: "solid" }))).toBe(0);
  });
});

describe("checking placement", () => {
  const span = (items: RoadsideItem[]) => checkRoadside(items, 1000, 2000);

  it("passes a well-placed item", () => {
    expect(span([rail()])).toEqual([]);
  });

  it("catches a run that ends before it begins", () => {
    const p = span([rail({ beginStation: 1800, endStation: 1400 })]);
    expect(p.map((x) => x.code)).toContain("RoadsideRunIsNotForward");
  });

  it("catches an item hanging off the end of the alignment", () => {
    const p = span([rail({ endStation: 2400 })]);
    const hit = p.find((x) => x.code === "RoadsideOutsideAlignment")!;
    expect(hit.measurements.alignmentEnd).toBe(2000);
    expect(hit.measurements.itemEnd).toBe(2400);
  });

  it("rejects a signed offset, because side already carries the direction", () => {
    const p = span([rail({ offsetFt: -8 })]);
    expect(p.map((x) => x.code)).toContain("RoadsideOffsetNotPositive");
  });

  it("insists a marking states its pattern", () => {
    const p = span([rail({ kind: "pavement-marking" })]);
    expect(p.map((x) => x.code)).toContain("MarkingPatternUnstated");
    expect(span([rail({ kind: "pavement-marking", pattern: "dashed" })])).toEqual([]);
  });

  it("catches two items sharing an id, so an edit cannot hit the wrong one", () => {
    const p = span([rail(), rail({ beginStation: 1850, endStation: 1900 })]);
    expect(p.map((x) => x.code)).toContain("DuplicateRoadsideId");
  });

  it("does NOT judge whether a guardrail is warranted", () => {
    // Warrant depends on fill height, slope and clear zone, and is the licensed
    // engineer's call. A rail on a dead-flat road is odd, not invalid, and the
    // tool must not quietly answer the question the engineer is paid to answer.
    expect(span([rail({ offsetFt: 40 })])).toEqual([]);
  });
});

describe("quantities", () => {
  it("totals length by kind, which is what a bid schedule wants", () => {
    const q = roadsideQuantities([
      rail(),
      rail({ id: "gr-2", beginStation: 1850, endStation: 1990 }),
      rail({ id: "cb-1", kind: "concrete-barrier", beginStation: 1000, endStation: 1200 }),
    ]);
    const gr = q.find((r) => r.kind === "guardrail")!;
    expect(gr.count).toBe(2);
    expect(gr.totalLengthFt).toBe(740);
    expect(q.find((r) => r.kind === "concrete-barrier")!.totalLengthFt).toBe(200);
  });

  it("reports nothing for an empty roadside", () => {
    expect(roadsideQuantities([])).toEqual([]);
  });
});
