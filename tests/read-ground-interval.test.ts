import { describe, expect, it } from "vitest";
import { buildTools, type StudioHost } from "../src/studio/webmcp-bridge";
import type { StudioForm } from "../src/studio/form-to-design";
import { makeTin, type GroundSample } from "../src/kernel/terrain";

/**
 * read_ground declared an intervalFt parameter and threw it away.
 *
 * The whole chain below the bridge was already correct -- the host interface takes
 * intervalFt, the studio implementation forwards it -- but the tool handler was
 * written as `() => {...}`, so it never received args at all and called
 * host.groundProfile() with nothing. Every request, at any interval, came back at
 * the 50 ft default. The agent had no way to detect it: the reply did not say what
 * spacing it used, so 25 ft and 100 ft produced identical, plausible, wrong answers.
 *
 * This is the third instance of one failure shape in this app -- a surface that
 * accepts an input nothing downstream reads. set_segment_material was the first
 * (see lossy-write.test.ts) and the terrain-without-alignment render was the
 * second. The guard is the same one in each case: make the tool state what it
 * actually did, and test that the statement is true.
 */

const seed = (): StudioForm => ({
  name: "Interval Test",
  beginStation: 1000,
  startE: 2200000,
  startN: 1350000,
  startAzimuthDeg: 75,
  elements: [{ kind: "tangent", length: "3000" }],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "4000", elevation: "870" },
  ],
  templates: [{
    name: "2-lane",
    left: [{ name: "lane", width: "12", slopePercent: "-2" }],
    right: [{ name: "lane", width: "12", slopePercent: "-2" }],
  }],
  drops: [{ template: "2-lane", toStation: "" }],
});

const tin = makeTin(
  "TestGround",
  [{ n: 0, e: 0, z: 100 }, { n: 100, e: 0, z: 100 }, { n: 0, e: 100, z: 100 }],
  [[0, 1, 2]],
);

/**
 * A host that samples the way the studio does, so the interval the bridge passes
 * is the interval that comes back.
 *
 * ⚠ This MIRRORS studio/main.ts rather than calling it, so it cannot catch a
 * regression in that arithmetic -- scripts/verify-ground-interval.mjs drives the
 * real app for that. Stations are whole multiples of the interval from the begin
 * station, with the end station always sampled.
 */
const ROAD_FT = 3000;
function makeHost(roadFt = ROAD_FT): { host: StudioHost; seen: (number | undefined)[] } {
  const seen: (number | undefined)[] = [];
  const current = seed();
  const host: StudioHost = {
    readForm: () => JSON.parse(JSON.stringify(current)) as StudioForm,
    writeForm: () => {},
    pendingChanges: () => [],
    undoLastAgentChange: () => ({ ok: false as const, reason: "nothing-to-undo" }),
    offerAlternatives: () => 0,
    shareLink: () => "https://example.test/#design=x",
    setCrs: () => true,
    crsZones: () => [],
    readCrs: () => undefined,
    planFeatures: () => undefined,
    setPlanFeatures: () => {},
    designSections: () => [],
    setDesignSections: () => {},
    terrain: () => tin,
    setTerrain: () => {},
    groundProfile: (intervalFt?: number) => {
      seen.push(intervalFt);
      const iv = intervalFt ?? 50;
      const CAP = 400;
      const step = Math.floor(roadFt / iv) > CAP - 1 ? roadFt / (CAP - 1) : iv;
      const out: GroundSample[] = [];
      const whole = Math.floor(roadFt / step + 1e-9);
      for (let i = 0; i <= whole; i += 1) {
        out.push({ station: 1000 + i * step, groundZ: 100, designZ: 105, cutFillFt: 5 });
      }
      if (out[out.length - 1]!.station < 1000 + roadFt - 1e-6) {
        out.push({ station: 1000 + roadFt, groundZ: 100, designZ: 105, cutFillFt: 5 });
      }
      return out;
    },
  };
  return { host, seen };
}

const call = async (host: StudioHost, name: string, args: Record<string, unknown>) => {
  const tool = buildTools(host).find((t) => t.name === name)!;
  const res = await tool.execute(args);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

describe("read_ground honours the interval it was asked for", () => {
  it("passes the requested interval down instead of dropping it", async () => {
    const { host, seen } = makeHost();
    await call(host, "read_ground", { intervalFt: 25 });
    expect(seen).toEqual([25]);
  });

  it("samples at 25, 50 and 100 ft when asked -- the reported bug", async () => {
    // Before the fix all three of these came back at 50 ft spacing.
    for (const want of [25, 50, 100]) {
      const { host } = makeHost();
      const r = await call(host, "read_ground", { intervalFt: want });
      expect(r.intervalFt).toBe(want);
      expect(r.requestedIntervalFt).toBe(want);
      const samples = r.samples as { station: number }[];
      expect(samples[1]!.station - samples[0]!.station).toBeCloseTo(want, 6);
    }
  });

  it("distinct intervals produce distinct station counts", async () => {
    const counts = new Set<number>();
    for (const want of [25, 50, 100]) {
      const { host } = makeHost();
      const r = await call(host, "read_ground", { intervalFt: want });
      counts.add(r.sampled as number);
    }
    expect(counts.size).toBe(3);
  });

  it("puts stations on whole multiples, not on an even division of the road", async () => {
    // The distinction the parameter name promises. An even division of a 3170 ft
    // road into ~100 ft parts gives 99.06 ft spacing and no round stations; what
    // an engineer means by "every 100 ft" is 10+00, 11+00, 12+00, with a short
    // last piece to the end. Both are defensible; only one matches the wording.
    const { host } = makeHost(3170);
    const r = await call(host, "read_ground", { intervalFt: 100 });
    const st = (r.samples as { station: number }[]).map((s) => s.station);

    expect(r.intervalFt).toBe(100);
    for (let i = 0; i < st.length - 1; i += 1) {
      expect((st[i]! - 1000) % 100).toBeCloseTo(0, 6);
    }
    // The end station is always sampled, so the final piece is short, not skipped.
    expect(st[st.length - 1]).toBeCloseTo(1000 + 3170, 6);
    const lastGap = st[st.length - 1]! - st[st.length - 2]!;
    expect(lastGap).toBeCloseTo(70, 6);
  });

  it("defaults to 50 ft when no interval is given", async () => {
    const { host } = makeHost();
    const r = await call(host, "read_ground", {});
    expect(r.intervalFt).toBe(50);
  });

  it("refuses a nonsense interval rather than quietly using the default", async () => {
    const { host } = makeHost();
    for (const bad of [0, -25]) {
      const r = await call(host, "read_ground", { intervalFt: bad });
      expect(r.code).toBe("BadArgument");
      expect(r.sampled).toBeUndefined();
    }
  });

  it("says so when the station cap widens the interval it was asked for", async () => {
    // 30,000 ft at 25 ft is 1,201 stations; the cap allows 400, so the real
    // spacing is ~75 ft. Serving that silently is the bug this tool already had.
    const { host } = makeHost(30000);
    const r = await call(host, "read_ground", { intervalFt: 25 });
    expect(r.requestedIntervalFt).toBe(25);
    expect(r.intervalFt as number).toBeGreaterThan(25);
    expect(String(r.note)).toContain("widened");
    expect(String(r.note)).toContain("400");
  });

  it("does not claim a widening when the interval was honoured exactly", async () => {
    const { host } = makeHost();
    const r = await call(host, "read_ground", { intervalFt: 100 });
    expect(String(r.note)).not.toContain("widened");
  });
});
