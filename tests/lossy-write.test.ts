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

/** A host whose storage optionally loses a field on the way back out. */
function makeHost(lose?: (f: StudioForm) => void): { host: StudioHost; written: string[] } {
  let current = seed();
  const written: string[] = [];
  const host: StudioHost = {
    readForm: () => JSON.parse(JSON.stringify(current)) as StudioForm,
    writeForm: (next, agentChange) => {
      current = JSON.parse(JSON.stringify(next)) as StudioForm;
      lose?.(current);
      if (agentChange) written.push(agentChange);
    },
    pendingChanges: () => written.map((d, i) => ({ id: i + 1, description: d })),
    undoLastAgentChange: () => ({ ok: false as const, reason: "nothing-to-undo" }),
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
  });

  it("catches a dropped superelevation policy the same way", async () => {
    const { host } = makeHost((f) => { delete f.superelevation; });
    const r = await call(host, "set_superelevation",
      { designSpeedMph: 60, emax: 0.06, commit: true });
    expect(r.code).toBe("LossyWrite");
  });

  it("catches dropped roadside furniture the same way", async () => {
    const { host } = makeHost((f) => { delete f.roadside; });
    const r = await call(host, "place_roadside_item", {
      id: "gr-1", kind: "guardrail", side: "left",
      beginStationFt: 1100, endStationFt: 1500, offsetFt: 20, commit: true,
    });
    expect(r.code).toBe("LossyWrite");
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
  });
});
