// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildTools, type StudioHost } from "../src/studio/webmcp-bridge";
import type { StudioForm } from "../src/studio/form-to-design";
import { formToDesign } from "../src/studio/form-to-design";
import { AgentChangeLedger } from "../src/studio/agent-changes";
import { CRS_ZONES, crsSelectionProblem, projectCrsFor } from "../src/studio/crs";
import { toDocument, fromDocument } from "../src/studio/design-document";

/**
 * F004 -- the coordinate system was project state living outside the project.
 *
 * It was derived on demand from two <select> elements, so it was outside
 * StudioForm and therefore outside all three things that read StudioForm:
 *
 *   - the undo snapshot, so a CRS change could not be reverted;
 *   - the agent change ledger, so set_coordinate_system never appeared there and
 *     undo_last_change silently acted on some older, unrelated change instead
 *     (QA saw ChangeAlreadyConfirmed with pendingCount 0 and no confirmation);
 *   - the portable design document, so a shared or reloaded design lost it.
 *
 * And because only the LandXML exporter was handed it, the staking CSV said
 * "CRS not set" for the very same project (F005).
 *
 * The CRS now lives in the form. These tests hold that line.
 */

const seed = (): StudioForm => ({
  name: "CRS Fixture",
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
  crs: { zone: "GA-West", basis: "grid" },
});

/** A host wired the way studio/main.ts wires it, ledger and all. */
function makeHost() {
  let form = seed();
  const ledger = new AgentChangeLedger();
  const host: StudioHost = {
    readForm: () => JSON.parse(JSON.stringify(form)) as StudioForm,
    writeForm: (next, agentChange) => {
      const before = agentChange !== undefined
        ? JSON.parse(JSON.stringify(form)) as StudioForm : undefined;
      form = JSON.parse(JSON.stringify(next)) as StudioForm;
      if (agentChange !== undefined) ledger.record(agentChange, before);
    },
    pendingChanges: () => ledger.pending().map((c) => ({ id: c.id, description: c.description })),
    undoLastAgentChange: () => {
      const r = ledger.undoLast();
      if (!r.ok) return { ok: false as const, reason: r.reason };
      form = r.before as StudioForm;
      return { ok: true as const, description: r.change.description };
    },
    offerAlternatives: () => 0,
    shareLink: () => "https://example.test/#design=x",
    // The studio's own setCrs: goes through writeForm, so it reaches the ledger.
    setCrs: (zone, basis, combinedScaleFactor, agentChange) => {
      if (zone !== "" && !CRS_ZONES.some((z) => z.value === zone)) return false;
      const next = JSON.parse(JSON.stringify(form)) as StudioForm;
      next.crs = { zone, basis,
        ...(combinedScaleFactor !== undefined ? { combinedScaleFactor } : {}) };
      host.writeForm(next, agentChange);
      return true;
    },
    crsZones: () => CRS_ZONES.map((z) => ({ value: z.value, label: z.label })),
    readCrs: () => projectCrsFor(form.crs),
    planFeatures: () => undefined,
    setPlanFeatures: () => {},
    designSections: () => [],
    setDesignSections: () => {},
    terrain: () => undefined,
    setTerrain: () => {},
    groundProfile: () => undefined,
    // Wired as studio/main.ts wires it: the entries belong to the load that
    // just ran, so undoing that load discards them with it.
    recordInherited: (ds) => {
      const owner = ledger.lastTransaction()?.id;
      for (const d of ds) {
        ledger.record(`${d} (inherited unconfirmed from the loaded design)`,
          undefined, new Date(), true, owner);
      }
    },
  };
  return { host, form: () => form, ledger };
}

const call = async (host: StudioHost, name: string, args: Record<string, unknown>) => {
  const tool = buildTools(host).find((t) => t.name === name)!;
  const res = await tool.execute(args);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

describe("the CRS is part of the design", () => {
  it("reaches the design through formToDesign", () => {
    const d = formToDesign(seed());
    expect(d.crs).toMatchObject({ zone: "GA-West", epsgCode: 2240, coordinateBasis: "grid" });
  });

  it("travels in the portable design document", () => {
    // The document is what a share link carries and what a reload restores.
    const doc = toDocument(seed());
    const back = fromDocument(JSON.parse(JSON.stringify(doc)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.form.crs).toEqual({ zone: "GA-West", basis: "grid" });
  });

  it("read_design_document carries it", async () => {
    const h = makeHost();
    await call(h.host, "set_coordinate_system", { zone: "GA-East", basis: "grid", commit: true });
    const r = await call(h.host, "read_design_document", {});
    expect(JSON.stringify(r)).toContain("GA-East");
  });

  it("an unknown zone yields NO crs rather than a silent default", () => {
    // The old derivation was `zone === "GA-East" ? east : west`, so any other
    // value georeferenced the road into Georgia West without saying so.
    expect(projectCrsFor({ zone: "TX-Central", basis: "grid" })).toBeUndefined();
    expect(projectCrsFor({ zone: "", basis: "grid" })).toBeUndefined();
  });
});

describe("a CRS change is an agent change like any other", () => {
  it("lands in the pending ledger", async () => {
    const h = makeHost();
    expect(h.host.pendingChanges()).toHaveLength(0);
    const r = await call(h.host, "set_coordinate_system",
      { zone: "GA-East", basis: "grid", commit: true });
    expect(r.committed).toBe(true);
    expect(h.host.pendingChanges()).toHaveLength(1);
    expect(h.host.pendingChanges()[0]!.description).toContain("GA-East");
  });

  it("is undone by undo_last_change, restoring the previous zone", async () => {
    const h = makeHost();
    await call(h.host, "set_coordinate_system", { zone: "GA-East", basis: "grid", commit: true });
    expect(h.form().crs!.zone).toBe("GA-East");

    const u = await call(h.host, "undo_last_change", {});
    expect(u.undone).toBe(true);
    expect(h.form().crs!.zone).toBe("GA-West");
    expect(h.host.pendingChanges()).toHaveLength(0);
  });

  it("reports NothingToUndo rather than ChangeAlreadyConfirmed when nothing was written", async () => {
    // QA saw ChangeAlreadyConfirmed with pendingCount 0 after a CRS change,
    // because the CRS write never entered the ledger and undo landed on an
    // older change. With the CRS in the ledger there is no such confusion.
    const h = makeHost();
    const u = await call(h.host, "undo_last_change", {});
    expect(u.code).toBe("NothingToUndo");
  });

  it("previews without changing anything", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_coordinate_system", { zone: "GA-East", basis: "grid" });
    expect(r.committed).toBe(false);
    expect(h.form().crs!.zone).toBe("GA-West");
    expect(h.host.pendingChanges()).toHaveLength(0);
  });
});

describe("ground coordinates need a scale factor", () => {
  it("refuses a ground basis with no combined scale factor", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_coordinate_system",
      { zone: "GA-West", basis: "ground", commit: true });
    expect(r.code).toBe("GroundBasisNeedsScaleFactor");
    expect(h.form().crs!.basis).toBe("grid");
    expect(h.host.pendingChanges()).toHaveLength(0);
  });

  it("accepts a ground basis with one, and carries it into the design", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_coordinate_system",
      { zone: "GA-West", basis: "ground", combinedScaleFactor: 0.99988, commit: true });
    expect(r.committed).toBe(true);
    const d = formToDesign(h.form());
    expect(d.crs).toMatchObject({ coordinateBasis: "ground", combinedScaleFactor: 0.99988 });
  });

  it("refuses a non-positive scale factor", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_coordinate_system",
      { zone: "GA-West", basis: "ground", combinedScaleFactor: 0, commit: true });
    expect(r.refused).toBe(true);
  });

  it("the rule matches the schema's own refusal", () => {
    // crsSelectionProblem and the zod refinement must not drift apart: the tool
    // would accept something the design then rejects, or vice versa.
    expect(crsSelectionProblem({ zone: "GA-West", basis: "ground" })).toBeDefined();
    expect(crsSelectionProblem({ zone: "GA-West", basis: "ground", combinedScaleFactor: 1 }))
      .toBeUndefined();
    expect(crsSelectionProblem({ zone: "GA-West", basis: "grid" })).toBeUndefined();
    expect(() => formToDesign({ ...seed(), crs: { zone: "GA-West", basis: "ground",
      combinedScaleFactor: 0.9999 } })).not.toThrow();
  });
});

describe("F005 -- one source, so both exports agree", () => {
  it("CSV and LandXML carry the same zone after a change", async () => {
    const h = makeHost();
    await call(h.host, "set_coordinate_system", { zone: "GA-East", basis: "grid", commit: true });
    // Exports are gated on confirmation; confirm as a person would.
    h.ledger.confirmAll();

    const csv = await call(h.host, "export_staking_csv", { intervalFt: 100 });
    const xml = await call(h.host, "export_landxml", {});
    expect(String(csv.csv)).toContain("2239");
    expect(String(xml.landxml)).toContain("2239");
    expect(String(csv.csv)).not.toContain("2240");
  });

  it("both say local when no zone is selected", async () => {
    const h = makeHost();
    await call(h.host, "set_coordinate_system", { zone: "", basis: "grid", commit: true });
    h.ledger.confirmAll();
    const csv = await call(h.host, "export_staking_csv", { intervalFt: 100 });
    expect(String(csv.csv)).toContain("CRS not set");
    expect(csv.coordinateSystem).toBeNull();
  });
});

describe("F018 -- inherited provenance blocks the deliverable, never the undo", () => {
  it("an inherited entry does not shadow the transaction beneath it", async () => {
    const h = makeHost();
    // A real transaction...
    await call(h.host, "set_coordinate_system", { zone: "GA-East", basis: "grid", commit: true });
    // ...then work that arrived already unconfirmed, which carries no snapshot.
    h.ledger.record("someone else's unconfirmed change", undefined, new Date(), true);
    expect(h.ledger.pendingCount()).toBe(2);

    // It used to sit on top with no snapshot and refuse forever.
    const u = await call(h.host, "undo_last_change", {});
    expect(u.undone).toBe(true);
    expect(h.form().crs!.zone).toBe("GA-West");
    // The inherited note stays: undoing our own change does not review theirs.
    expect(h.ledger.pendingCount()).toBe(1);
  });

  it("still blocks the deliverable on its own", async () => {
    const h = makeHost();
    h.ledger.record("someone else's unconfirmed change", undefined, new Date(), true);
    const xml = await call(h.host, "export_landxml", {});
    expect(xml.code).toBe("AwaitingEngineerConfirmation");
  });

  it("reports nothing-to-undo when only inherited entries exist", async () => {
    const h = makeHost();
    h.ledger.record("inherited", undefined, new Date(), true);
    const u = await call(h.host, "undo_last_change", {});
    expect(u.code).toBe("NothingToUndo");
  });
});

describe("F016 -- paging past the end says so instead of restarting", () => {
  it("does not serve page one again for a station beyond the road", async () => {
    const h = makeHost();
    // No terrain on this host, so read_ground refuses -- assert the refusal is
    // the ground one, not a silent wrap. The paging arithmetic itself is covered
    // end-to-end in verify-transaction.mjs against a real surface.
    const r = await call(h.host, "read_ground", { fromStationFt: 99999 });
    expect(r.code).toBe("NoGroundSurface");
  });
});

describe("F018 -- undoing a load takes the provenance it brought with it", () => {
  it("QA's sequence leaves no orphaned entries", async () => {
    // pending 0 -> transaction A:1 -> load carrying 2 inherited:4
    //           -> undo load:1 -> undo A:0
    // It used to end at 2: both real transactions undone, nothing on the page,
    // and the ledger still describing the discarded document's work.
    const h = makeHost();
    await call(h.host, "set_coordinate_system", { zone: "GA-East", basis: "grid", commit: true });
    expect(h.ledger.pendingCount()).toBe(1);

    const doc = {
      version: 2,
      savedAt: new Date().toISOString(),
      form: seed(),
      unconfirmed: ["their terrain", "their guardrail"],
    };
    const loaded = await call(h.host, "load_design_document", { document: doc, commit: true });
    expect(loaded.committed).toBe(true);
    expect(h.ledger.pendingCount()).toBe(4);
    expect(loaded.pendingEngineerConfirmation).toBe(4);

    const u1 = await call(h.host, "undo_last_change", {});
    expect(u1.undone).toBe(true);
    // The load AND the two entries it introduced.
    expect(h.ledger.pendingCount()).toBe(1);

    const u2 = await call(h.host, "undo_last_change", {});
    expect(u2.undone).toBe(true);
    expect(h.ledger.pendingCount()).toBe(0);
  });

  it("keeps provenance that was already there before the load", async () => {
    const h = makeHost();
    // Provenance from a reload: owned by no transaction here.
    h.ledger.record("from a previous session", undefined, new Date(), true);
    await call(h.host, "set_coordinate_system", { zone: "GA-East", basis: "grid", commit: true });
    expect(h.ledger.pendingCount()).toBe(2);

    const u = await call(h.host, "undo_last_change", {});
    expect(u.undone).toBe(true);
    // Our change is gone; nothing in this session reviewed theirs, so it stays.
    expect(h.ledger.pendingCount()).toBe(1);
    expect(h.ledger.pending()[0]!.description).toContain("previous session");
  });

  it("survives repeated load/undo cycles without accumulating entries", async () => {
    const h = makeHost();
    const doc = {
      version: 2, savedAt: new Date().toISOString(), form: seed(),
      unconfirmed: ["theirs"],
    };
    for (let i = 0; i < 3; i += 1) {
      await call(h.host, "load_design_document", { document: doc, commit: true });
      expect(h.ledger.pendingCount()).toBe(2);
      await call(h.host, "undo_last_change", {});
      expect(h.ledger.pendingCount()).toBe(0);
    }
  });

  it("an edit after inherited provenance undoes without disturbing it", async () => {
    const h = makeHost();
    h.ledger.record("theirs, from a reload", undefined, new Date(), true);
    await call(h.host, "set_coordinate_system", { zone: "GA-East", basis: "grid", commit: true });
    await call(h.host, "undo_last_change", {});
    expect(h.form().crs!.zone).toBe("GA-West");
    expect(h.ledger.pendingCount()).toBe(1);
  });
});
