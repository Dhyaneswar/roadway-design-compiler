// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildTools, type StudioHost } from "../src/studio/webmcp-bridge";
import type { StudioForm } from "../src/studio/form-to-design";
import { toLandXML } from "../src/exporters/landxml";
import { makeTin, type Tin } from "../src/kernel/terrain";
import type { PlanFeatureSet } from "../src/importers/plan-features";
import type { DesignSectionSurface } from "../src/importers/design-sections";
import { AgentChangeLedger } from "../src/studio/agent-changes";

/**
 * import_landxml is a WRITE TOOL and owes the same contract as every other one:
 * a preview changes nothing, and a commit changes only what it says it changed.
 *
 * Independent QA (2026-08-31) found it breaking that contract twice.
 *
 *   F006  A context-only file loaded its 71 site features and reported
 *         committed:true while the caller had passed commit:false. The branch
 *         never read args.commit at all.
 *
 *   F007  An alignment-only import cleared an imported survey. setTerrain was
 *         guarded by "does this file carry a surface"; setDesignSections and
 *         setPlanFeatures, three lines below it, were not -- so a file with no
 *         survey in it wiped the survey already loaded. All three also ran
 *         BEFORE the commit check, so a preview cleared context too.
 *
 *   W001  Replacing the alignment removes roadside furniture stationed against
 *         the road being replaced. That is the intended behaviour -- a guardrail
 *         at 20+00-34+00 need not exist on the new road -- but it was not
 *         disclosed, so it was discovered afterwards rather than previewed.
 */

const seed = (): StudioForm => ({
  name: "Import Test",
  beginStation: 1000,
  startE: 2200000,
  startN: 1350000,
  startAzimuthDeg: 75,
  elements: [{ kind: "tangent", length: "1500" }],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "2500", elevation: "860" },
  ],
  templates: [{
    name: "2-lane",
    left: [{ name: "lane", width: "12", slopePercent: "-2" }],
    right: [{ name: "lane", width: "12", slopePercent: "-2" }],
  }],
  drops: [{ template: "2-lane", toStation: "" }],
  roadside: [
    { id: "gr-1", kind: "guardrail", side: "left",
      beginStation: 1100, endStation: 1400, offsetFt: 20 },
    { id: "cb-1", kind: "concrete-barrier", side: "right",
      beginStation: 1200, endStation: 1500, offsetFt: 18 },
  ],
});

/** Ground and a survey that are ALREADY loaded before any import runs. */
const existingTin = (): Tin => makeTin(
  "AlreadyLoadedGround",
  [{ n: 1350000, e: 2200000, z: 100 },
   { n: 1350100, e: 2200000, z: 101 },
   { n: 1350000, e: 2200100, z: 102 }],
  [[0, 1, 2]],
);
const existingFeatures = (): PlanFeatureSet => ({
  features: [
    { name: "BLDG1", hasElevation: false,
      points: [{ n: 1350010, e: 2200010 }, { n: 1350020, e: 2200020 }] },
    { name: "SDWK", hasElevation: false,
      points: [{ n: 1350030, e: 2200030 }, { n: 1350040, e: 2200040 }] },
  ],
  unresolvedRefs: 0,
  bounds: { minN: 1350010, maxN: 1350040, minE: 2200010, maxE: 2200040 },
});

/** A LandXML carrying ONLY a TIN surface -- no alignment, no plan features. */
const SURFACE_ONLY_XML = `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Imperial linearUnit="foot" areaUnit="squareFoot" volumeUnit="cubicFeet"
    angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>
  <Surfaces>
    <Surface name="ImportedGround">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">1351000 2201000 200</P>
          <P id="2">1351100 2201000 201</P>
          <P id="3">1351000 2201100 202</P>
        </Pnts>
        <Faces><F>1 2 3</F></Faces>
      </Definition>
    </Surface>
  </Surfaces>
</LandXML>`;

/** A LandXML carrying ONLY an alignment -- no surface, no plan features. */
const ALIGNMENT_ONLY_XML = toLandXML({
  name: "ImportedRoad",
  alignment: {
    beginStation: 2000,
    start: { e: 2300000, n: 1360000 },
    startAzimuthDeg: 40,
    elements: [{ type: "tangent", length: 900 }],
  },
  profile: { pvis: [{ station: 2000, elevation: 700 }, { station: 2900, elevation: 712 }] },
});

/**
 * A LandXML carrying BOTH an alignment and a surface -- QA's combined fixture.
 * Built by splicing the surface block into the alignment-only export so the two
 * fixtures stay in step.
 */
const SURFACES_BLOCK = SURFACE_ONLY_XML.slice(
  SURFACE_ONLY_XML.indexOf("<Surfaces>"),
  SURFACE_ONLY_XML.indexOf("</Surfaces>") + "</Surfaces>".length,
);
const COMBINED_XML = ALIGNMENT_ONLY_XML.replace(
  "</LandXML>",
  `${SURFACES_BLOCK}\n</LandXML>`,
);

interface Harness {
  host: StudioHost;
  calls: string[];
  state: () => { terrain?: Tin; features?: PlanFeatureSet; sections: readonly DesignSectionSurface[] };
  form: () => StudioForm;
}

function makeHost(): Harness {
  let form = seed();
  let terrain: Tin | undefined = existingTin();
  let features: PlanFeatureSet | undefined = existingFeatures();
  let sections: readonly DesignSectionSurface[] = [];
  const calls: string[] = [];
  // A REAL ledger, wired the way studio/main.ts wires it. Independent QA noted
  // that a stubbed undo proves preview and layer selection but not restoration,
  // so the W001 claim -- "undo_last_change restores them" -- went untested.
  const ledger = new AgentChangeLedger();
  const host: StudioHost = {
    readForm: () => JSON.parse(JSON.stringify(form)) as StudioForm,
    writeForm: (next, agentChange) => {
      const before = agentChange !== undefined ? snapshot() : undefined;
      form = JSON.parse(JSON.stringify(next)) as StudioForm;
      if (agentChange !== undefined) ledger.record(agentChange, before);
    },
    pendingChanges: () => ledger.pending().map((c) => ({ id: c.id, description: c.description })),
    undoLastAgentChange: () => {
      const r = ledger.undoLast();
      if (!r.ok) return { ok: false as const, reason: r.reason };
      const snap = r.before as ReturnType<typeof snapshot>;
      form = snap.form;
      terrain = snap.terrain;
      features = snap.features;
      sections = snap.sections;
      return { ok: true as const, description: r.change.description };
    },
    offerAlternatives: () => 0,
    shareLink: () => "https://example.test/#design=x",
    setCrs: () => true,
    crsZones: () => [],
    readCrs: () => undefined,
    planFeatures: () => features,
    setPlanFeatures: (f) => { calls.push("setPlanFeatures"); features = f; },
    designSections: () => sections,
    setDesignSections: (s) => { calls.push("setDesignSections"); sections = s; },
    terrain: () => terrain,
    setTerrain: (t) => { calls.push("setTerrain"); terrain = t; },
    groundProfile: () => undefined,
    setImportedContext: (ctx, agentChange) => {
      const before = agentChange !== undefined ? snapshot() : undefined;
      if (ctx.planFeatures !== undefined) { calls.push("setPlanFeatures"); features = ctx.planFeatures; }
      if (ctx.designSections !== undefined) { calls.push("setDesignSections"); sections = ctx.designSections; }
      if (ctx.terrain !== undefined) { calls.push("setTerrain"); terrain = ctx.terrain; }
      if (agentChange !== undefined) ledger.record(agentChange, before);
    },
  };
  // The whole project, the way studio/main.ts snapshots it for undo.
  function snapshot() {
    return {
      form: JSON.parse(JSON.stringify(form)) as StudioForm,
      terrain, features, sections,
    };
  }
  return { host, calls, state: () => ({ terrain, features, sections }), form: () => form };
}

const call = async (host: StudioHost, name: string, args: Record<string, unknown>) => {
  const tool = buildTools(host).find((t) => t.name === name)!;
  const res = await tool.execute(args);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

describe("F006 -- a context-only import obeys commit", () => {
  it("previews without touching terrain, site features or the ledger", async () => {
    const h = makeHost();
    const before = h.state();
    const r = await call(h.host, "import_landxml", { xml: SURFACE_ONLY_XML, commit: false });

    expect(r.committed).toBe(false);
    expect(r.previewed).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.state().terrain!.name).toBe("AlreadyLoadedGround");
    expect(h.state().terrain).toBe(before.terrain);
    expect(h.state().features).toBe(before.features);
  });

  it("previews the same way when commit is omitted entirely", async () => {
    const h = makeHost();
    const r = await call(h.host, "import_landxml", { xml: SURFACE_ONLY_XML });
    expect(r.committed).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("says what it would load, so the preview is worth reading", async () => {
    const h = makeHost();
    const r = await call(h.host, "import_landxml", { xml: SURFACE_ONLY_XML, commit: false });
    expect(String(r.change)).toContain("would load");
    expect((r.groundSurface as { name: string }).name).toBe("ImportedGround");
  });

  it("loads it on commit, and only then", async () => {
    const h = makeHost();
    const r = await call(h.host, "import_landxml", { xml: SURFACE_ONLY_XML, commit: true });
    expect(r.committed).toBe(true);
    expect(h.calls).toContain("setTerrain");
    expect(h.state().terrain!.name).toBe("ImportedGround");
  });
});

describe("F007 -- an import replaces the layers it carries and no others", () => {
  it("does not clear an imported survey just because the file has no survey", async () => {
    const h = makeHost();
    await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: true });
    expect(h.state().features!.features).toHaveLength(2);
    expect(h.calls).not.toContain("setPlanFeatures");
  });

  it("does not clear loaded ground just because the file has no surface", async () => {
    const h = makeHost();
    await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: true });
    expect(h.state().terrain!.name).toBe("AlreadyLoadedGround");
    expect(h.calls).not.toContain("setTerrain");
  });

  it("does not touch context while previewing an alignment import", async () => {
    const h = makeHost();
    const before = h.state();
    await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: false });
    expect(h.calls).toEqual([]);
    expect(h.state().features).toBe(before.features);
    expect(h.state().terrain).toBe(before.terrain);
  });

  it("reports which layers it replaces and which it leaves alone", async () => {
    const h = makeHost();
    const r = await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: false });
    const layers = r.contextLayers as { replaces: string[]; leavesAlone: string[] };
    expect(layers.replaces).toEqual([]);
    expect(layers.leavesAlone).toContain("terrain");
    expect(layers.leavesAlone).toContain("siteFeatures");
  });

  it("a surface-only file replaces terrain and leaves the survey alone", async () => {
    const h = makeHost();
    const r = await call(h.host, "import_landxml", { xml: SURFACE_ONLY_XML, commit: true });
    const layers = r.contextLayers as { replaces: string[]; leavesAlone: string[] };
    expect(layers.replaces).toEqual(["terrain"]);
    expect(layers.leavesAlone).toContain("siteFeatures");
    expect(h.state().features!.features).toHaveLength(2);
  });
});

describe("W001 -- replacement removes roadside furniture, and says so first", () => {
  it("enumerates the items it will remove IN THE PREVIEW", async () => {
    const h = makeHost();
    const r = await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: false });

    expect(r.removesRoadsideItems).toBe(2);
    const removed = r.removedRoadside as { id: string; kind: string }[];
    expect(removed.map((x) => x.id).sort()).toEqual(["cb-1", "gr-1"]);
    expect(removed[0]).toMatchObject({ beginStationFt: 1100, endStationFt: 1400 });
    // And the preview really is a preview: they are still there.
    expect(h.form().roadside).toHaveLength(2);
  });

  it("explains the reason in the notes rather than leaving it to be discovered", async () => {
    const h = makeHost();
    const r = await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: false });
    const notes = (r.importedFrom as { notes: string[] }).notes.join(" ");
    expect(notes).toContain("roadside item");
    expect(notes).toContain("undo_last_change");
  });

  it("actually removes them on commit, matching what the preview promised", async () => {
    const h = makeHost();
    const r = await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: true });
    expect(r.removesRoadsideItems).toBe(2);
    expect(h.form().roadside ?? []).toHaveLength(0);
  });

  it("reports zero, and no list, when there is nothing to remove", async () => {
    const h = makeHost();
    await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: true });
    const r = await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: false });
    expect(r.removesRoadsideItems).toBe(0);
    expect(r.removedRoadside).toBeUndefined();
  });
});

describe("undo after an import -- what it restores, and what it does not", () => {
  it("restores the roadside furniture the import removed", async () => {
    const h = makeHost();
    await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: true });
    expect(h.form().roadside ?? []).toHaveLength(0);

    const u = await call(h.host, "undo_last_change", {});
    expect(u.undone).toBe(true);
    expect(h.form().roadside).toHaveLength(2);
    expect((h.form().roadside ?? []).map((r) => r.id).sort()).toEqual(["cb-1", "gr-1"]);
  });

  it("restores the road itself", async () => {
    const h = makeHost();
    const before = JSON.stringify(h.form());
    await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: true });
    expect(h.form().name).toBe("ImportedRoad");

    await call(h.host, "undo_last_change", {});
    expect(JSON.stringify(h.form())).toBe(before);
  });

  it("clears the pending ledger entry it undid", async () => {
    const h = makeHost();
    await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: true });
    expect(h.host.pendingChanges()).toHaveLength(1);
    await call(h.host, "undo_last_change", {});
    expect(h.host.pendingChanges()).toHaveLength(0);
  });

  it("reports nothing-to-undo after a preview, because a preview wrote nothing", async () => {
    const h = makeHost();
    await call(h.host, "import_landxml", { xml: ALIGNMENT_ONLY_XML, commit: false });
    const u = await call(h.host, "undo_last_change", {});
    expect(u.code).toBe("NothingToUndo");
  });

  it("a context-only commit enters the ledger (F010)", async () => {
    // It used to bypass writeForm entirely: the surface loaded, pending stayed
    // at zero, and undo reported NothingToUndo while the new ground sat there.
    const h = makeHost();
    await call(h.host, "import_landxml", { xml: SURFACE_ONLY_XML, commit: true });
    expect(h.state().terrain!.name).toBe("ImportedGround");
    expect(h.host.pendingChanges()).toHaveLength(1);
    expect(h.host.pendingChanges()[0]!.description).toContain("ground surface");
  });

  it("undo puts the replaced terrain back (F010)", async () => {
    const h = makeHost();
    await call(h.host, "import_landxml", { xml: SURFACE_ONLY_XML, commit: true });
    const u = await call(h.host, "undo_last_change", {});
    expect(u.undone).toBe(true);
    expect(h.state().terrain!.name).toBe("AlreadyLoadedGround");
    expect(h.host.pendingChanges()).toHaveLength(0);
  });

  it("one undo restores BOTH the road and the terrain a combined import moved", async () => {
    // QA's combined fixture: undo said restored, the road came back, and the
    // replacement terrain stayed. A partial restore reported as a restore is
    // worse than refusing to undo.
    const h = makeHost();
    const beforeName = h.state().terrain!.name;
    await call(h.host, "import_landxml", { xml: COMBINED_XML, commit: true });
    expect(h.state().terrain!.name).toBe("ImportedGround");
    expect(h.form().roadside ?? []).toHaveLength(0);

    const u = await call(h.host, "undo_last_change", {});
    expect(u.undone).toBe(true);
    expect(h.state().terrain!.name).toBe(beforeName);
    expect(h.form().roadside).toHaveLength(2);
  });
});
