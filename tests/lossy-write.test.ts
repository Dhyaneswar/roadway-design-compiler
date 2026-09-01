import { describe, expect, it } from "vitest";
import { buildTools, type StudioHost } from "../src/studio/webmcp-bridge";
import type { StudioForm } from "../src/studio/form-to-design";

// A form that exercises the fields most likely to be dropped in the mapping.
const seed = (): StudioForm => ({
  name: "Guard Test",
  beginStation: 1000,
  startE: 2200000,
  startN: 1350000,
  startAzimuthDeg: 75,
  elements: [
    { kind: "tangent", length: "1200" },
    { kind: "arc", radius: "1500", deltaDeg: "45", direction: "right" },
    { kind: "tangent", length: "800" },
  ],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "2000", elevation: "860", curveLength: "400" },
    { station: "3378", elevation: "865" },
  ],
  templates: [{
    name: "2-lane",
    left: [{ name: "lane", width: "12", slopePercent: "-2" }],
    right: [{ name: "lane", width: "12", slopePercent: "-2" }],
  }],
  drops: [{ template: "2-lane", toStation: "" }],
});

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * A host whose storage optionally loses a field on the way back out.
 *
 * ⚠ This fixture now implements a REAL undo. It used to answer every
 * undoLastAgentChange with "nothing-to-undo", which made the rollback assertions
 * below impossible to write and let F035 sit undetected: the guard reported
 * LossyWrite while the mangled form and its pending change stayed live. A stub
 * that cannot fail is a stub that cannot test.
 */
function makeHost(
  lose?: (f: StudioForm) => void,
  /** Simulate a rollback that cannot run, to test what the response then says. */
  undoFails = false,
): { host: StudioHost; written: string[] } {
  let current = seed();
  const written: string[] = [];
  /** The pre-change snapshots the real Studio keeps in its agent ledger. */
  const history: { form: StudioForm; written: string[] }[] = [];
  const host: StudioHost = {
    readForm: () => clone(current),
    writeForm: (next, agentChange) => {
      history.push({ form: clone(current), written: [...written] });
      current = clone(next);
      lose?.(current);
      if (agentChange) written.push(agentChange);
    },
    pendingChanges: () => written.map((d, i) => ({ id: i + 1, description: d })),
    undoLastAgentChange: () => {
      if (undoFails) return { ok: false as const, reason: "nothing-to-undo" as const };
      const prev = history.pop();
      if (!prev) return { ok: false as const, reason: "nothing-to-undo" as const };
      current = prev.form;
      written.length = 0;
      written.push(...prev.written);
      return { ok: true as const, description: "undone" };
    },
    offerAlternatives: () => 0,
    shareLink: () => "https://example.test/#design=x",
    setCrs: () => true,
    crsZones: () => [{ value: "GA-West", label: "Georgia West" }],
    readCrs: () => undefined,
    planFeatures: () => undefined,
    setPlanFeatures: () => {},
    designSections: () => [],
    setDesignSections: () => {},
    terrain: () => undefined,
    setTerrain: () => {},
    groundProfile: () => undefined,
  };
  return { host, written };
}

const call = async (host: StudioHost, name: string, args: Record<string, unknown>) => {
  const tool = buildTools(host).find((t) => t.name === name)!;
  const res = await tool.execute(args);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

/**
 * F035. A refused write must leave NOTHING behind -- not the mangled form, and
 * not the pending change that would ask an engineer to confirm work the app has
 * already disowned.
 */
const expectUntouched = (host: StudioHost): void => {
  expect(host.readForm(), "form restored to exactly its prior state").toEqual(seed());
  expect(host.pendingChanges().length, "no pending change left behind").toBe(0);
};

describe("a commit is only reported when the change survived", () => {
  it("reports committed when the write is faithful", async () => {
    const { host } = makeHost();
    const r = await call(host, "set_segment_material",
      { template: "2-lane", side: "right", index: 1, material: "asphalt", commit: true });
    expect(r.committed).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("catches a field silently dropped on the way in -- the material bug, reproduced", async () => {
    // Exactly the defect that shipped: the write appears to succeed and the value
    // is gone. Before the guard this returned committed: true.
    const { host } = makeHost((f) => {
      for (const t of f.templates) {
        for (const s of [...t.left, ...t.right]) delete s.material;
      }
    });
    const r = await call(host, "set_segment_material",
      { template: "2-lane", side: "right", index: 1, material: "asphalt", commit: true });
    expect(r.committed).toBeUndefined();
    expect(r.code).toBe("LossyWrite");
    expect(String(r.detail)).toContain("did not survive the round trip");
    // Said out loud, so a caller never has to infer it from the absence of a flag.
    expect(r.rolledBack).toBe(true);
    expect(r.warning).toBeUndefined();
    expectUntouched(host);
  });

  it("catches a dropped superelevation policy the same way", async () => {
    const { host } = makeHost((f) => { delete f.superelevation; });
    const r = await call(host, "set_superelevation",
      { designSpeedMph: 60, emax: 0.06, commit: true });
    expect(r.code).toBe("LossyWrite");
    expectUntouched(host);
  });

  it("catches dropped roadside furniture the same way", async () => {
    const { host } = makeHost((f) => { delete f.roadside; });
    const r = await call(host, "place_roadside_item", {
      id: "gr-1", kind: "guardrail", side: "left",
      beginStationFt: 1100, endStationFt: 1500, offsetFt: 20, commit: true,
    });
    expect(r.code).toBe("LossyWrite");
    expectUntouched(host);
  });

  it("says the fault is the app's, not the caller's", async () => {
    const { host } = makeHost((f) => { delete f.superelevation; });
    const r = await call(host, "set_superelevation",
      { designSpeedMph: 60, emax: 0.06, commit: true });
    expect(String(r.detail)).toContain("defect in the app");
  });

  it("leaves preview alone -- nothing was written, so nothing can be lost", async () => {
    const { host } = makeHost((f) => { delete f.superelevation; });
    const r = await call(host, "set_superelevation", { designSpeedMph: 60, emax: 0.06 });
    expect(r.previewed).toBe(true);
    expect(r.code).toBeUndefined();
  });

  it("reports a write that leaves the design unbuildable", async () => {
    const { host } = makeHost((f) => { f.elements = []; });
    const r = await call(host, "set_project_setup", { name: "x", commit: true });
    expect(r.code).toBe("WriteNotReadable");
    expectUntouched(host);
  });
});

/**
 * F036. When the rollback itself cannot run, the response must say so in BOTH
 * the flag and the prose. It used to carry `rolledBack: false` and a warning
 * beside a detail claiming "the design has been left as it was" -- an agent
 * reading the sentence and an agent reading the flag would have reached opposite
 * conclusions from one response.
 */
describe("a rollback that cannot run is not described as one that did", () => {
  it("never claims a clean state it did not achieve", async () => {
    const { host } = makeHost((f) => { delete f.superelevation; }, true);
    const r = await call(host, "set_superelevation",
      { designSpeedMph: 60, emax: 0.06, commit: true });

    expect(r.code).toBe("LossyWrite");
    expect(r.rolledBack).toBe(false);
    expect(String(r.detail)).not.toMatch(/left (exactly )?as it was/);
    expect(String(r.detail)).toContain("could NOT be rolled back");
    expect(String(r.warning)).toContain("may still hold it");
    // And the honesty is load-bearing: the change really is still there.
    expect(host.pendingChanges().length).toBe(1);
  });

  it("says the opposite, and means it, when the rollback does run", async () => {
    const { host } = makeHost((f) => { delete f.superelevation; });
    const r = await call(host, "set_superelevation",
      { designSpeedMph: 60, emax: 0.06, commit: true });

    expect(r.rolledBack).toBe(true);
    expect(String(r.detail)).toContain("left exactly as it was");
    expect(r.warning).toBeUndefined();
    expectUntouched(host);
  });
});
