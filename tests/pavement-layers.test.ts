// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildTools, type StudioHost } from "../src/studio/webmcp-bridge";
import { formToDesign, type StudioForm } from "../src/studio/form-to-design";
import { AgentChangeLedger } from "../src/studio/agent-changes";
import { toDocument, fromDocument } from "../src/studio/design-document";
import { buildPavementMeshes, pavementLayerColors } from "../src/viewer/pavement-mesh";

/**
 * The authored pavement structure.
 *
 * ⛔ This is not a pavement design calculator and must never read like one. The
 * engineer states the structure; the app records it, adds it up, draws it at
 * true thickness, and says plainly that it calculated no adequacy. 4/8/12 below
 * is TEST INPUT, never a recommendation or a default.
 */

const seed = (): StudioForm => ({
  name: "Pavement Fixture",
  beginStation: 1000,
  startE: 2200000,
  startN: 1350000,
  startAzimuthDeg: 75,
  elements: [{ kind: "tangent", length: "1500" }],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "2500", elevation: "860" },
  ],
  templates: [
    {
      name: "2-lane",
      left: [{ name: "lane", width: "12", slopePercent: "-2" }],
      right: [{ name: "lane", width: "12", slopePercent: "-2" }],
    },
    {
      name: "ramp",
      left: [{ name: "lane", width: "16", slopePercent: "-2" }],
      right: [{ name: "lane", width: "16", slopePercent: "-2" }],
    },
  ],
  drops: [{ template: "2-lane", toStation: "" }],
  crs: { zone: "GA-West", basis: "grid" },
});

const STACK = [
  { name: "surface", thicknessIn: 4, material: "asphalt concrete" },
  { name: "base", thicknessIn: 8 },
  { name: "subbase", thicknessIn: 12, material: "graded aggregate" },
];

function makeHost() {
  let form = seed();
  const ledger = new AgentChangeLedger();
  const snap = () => ({ form: JSON.parse(JSON.stringify(form)) as StudioForm });
  const host: StudioHost = {
    readForm: () => JSON.parse(JSON.stringify(form)) as StudioForm,
    writeForm: (next, agentChange) => {
      const before = agentChange !== undefined ? snap() : undefined;
      form = JSON.parse(JSON.stringify(next)) as StudioForm;
      if (agentChange !== undefined) ledger.record(agentChange, before);
    },
    pendingChanges: () => ledger.pending().map((c) => ({ id: c.id, description: c.description })),
    undoLastAgentChange: () => {
      const r = ledger.undoLast();
      if (!r.ok) return { ok: false as const, reason: r.reason };
      form = (r.before as { form: StudioForm }).form;
      return { ok: true as const, description: r.change.description };
    },
    offerAlternatives: () => 0,
    shareLink: () => "https://example.test/#design=x",
    setCrs: () => true,
    crsZones: () => [],
    readCrs: () => undefined,
    planFeatures: () => undefined,
    setPlanFeatures: () => {},
    designSections: () => [],
    setDesignSections: () => {},
    terrain: () => undefined,
    setTerrain: () => {},
    groundProfile: () => undefined,
  };
  return { host, form: () => form, ledger };
}

const call = async (host: StudioHost, name: string, args: Record<string, unknown>) => {
  const tool = buildTools(host).find((t) => t.name === name)!;
  const res = await tool.execute(args);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};
const setStack = (host: StudioHost, layers: unknown[], commit = true, template = "2-lane") =>
  call(host, "set_pavement_layers", { template, layers, commit });

describe("1 -- preview changes nothing", () => {
  it("leaves the form, the ledger and the read-back untouched", async () => {
    const h = makeHost();
    const before = JSON.stringify(h.form());
    const r = await setStack(h.host, STACK, false);

    expect(r.committed).toBe(false);
    expect(r.previewed).toBe(true);
    expect(JSON.stringify(h.form())).toBe(before);
    expect(h.host.pendingChanges()).toHaveLength(0);
    const read = await call(h.host, "read_pavement_layers", {});
    const t = (read.templates as { template: string; layerCount: number }[])
      .find((x) => x.template === "2-lane")!;
    expect(t.layerCount).toBe(0);
  });

  it("still reports what it WOULD do", async () => {
    const h = makeHost();
    const r = await setStack(h.host, STACK, false);
    expect(r.totalThicknessIn).toBe(24);
    expect((r.layers as { name: string }[]).map((L) => L.name))
      .toEqual(["surface", "base", "subbase"]);
  });
});

describe("2 -- commit persists the exact authored values", () => {
  it("reads back 4/8/12 and a 24 in total, in order", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const read = await call(h.host, "read_pavement_layers", {});
    const t = (read.templates as {
      template: string; layers: { name: string; thicknessIn: number; material?: string }[];
      totalThicknessIn: number;
    }[]).find((x) => x.template === "2-lane")!;

    expect(t.layers.map((L) => L.name)).toEqual(["surface", "base", "subbase"]);
    expect(t.layers.map((L) => L.thicknessIn)).toEqual([4, 8, 12]);
    expect(t.totalThicknessIn).toBe(24);
    expect(t.layers[0]!.material).toBe("asphalt concrete");
    expect(t.layers[1]!.material).toBeUndefined();
  });

  it("keeps fractional thicknesses exactly, without rounding", async () => {
    const h = makeHost();
    await setStack(h.host, [{ name: "overlay", thicknessIn: 1.75 }]);
    const read = await call(h.host, "read_pavement_layers", {});
    const t = (read.templates as { template: string; layers: { thicknessIn: number }[] }[])
      .find((x) => x.template === "2-lane")!;
    expect(t.layers[0]!.thicknessIn).toBe(1.75);
  });

  it("reaches the design through formToDesign", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const d = formToDesign(h.form());
    expect(d.templates["2-lane"]!.pavementLayers!.map((L) => L.thicknessIn)).toEqual([4, 8, 12]);
  });
});

describe("3 -- undo restores the prior complete stack", () => {
  it("A -> B -> undo gives A back exactly", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    await setStack(h.host, [{ name: "thin overlay", thicknessIn: 2 }]);
    let read = await call(h.host, "read_pavement_layers", {});
    let t = (read.templates as { template: string; layers: { name: string }[] }[])
      .find((x) => x.template === "2-lane")!;
    expect(t.layers.map((L) => L.name)).toEqual(["thin overlay"]);

    const u = await call(h.host, "undo_last_change", {});
    expect(u.undone).toBe(true);
    read = await call(h.host, "read_pavement_layers", {});
    t = (read.templates as { template: string; layers: { name: string }[] }[])
      .find((x) => x.template === "2-lane")!;
    expect(t.layers.map((L) => L.name)).toEqual(["surface", "base", "subbase"]);
  });

  it("reports how many layers it replaced", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const r = await setStack(h.host, [{ name: "overlay", thicknessIn: 2 }]);
    expect(r.replacedLayerCount).toBe(3);
    expect(String(r.note)).toContain("undo_last_change");
  });
});

describe("4 -- the stack travels with the design", () => {
  it("survives the portable document round trip", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const doc = toDocument(h.form(), undefined, ["unconfirmed work"]);
    const back = fromDocument(JSON.parse(JSON.stringify(doc)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const t = back.form.templates.find((x) => x.name === "2-lane")!;
    expect(t.pavementLayers!.map((L) => L.thicknessIn)).toEqual(["4", "8", "12"]);
    // Provenance rules from F018/F019 still apply to the document carrying it.
    expect(back.unconfirmed).toEqual(["unconfirmed work"]);
  });

  it("read_design_document carries it", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const r = await call(h.host, "read_design_document", {});
    expect(JSON.stringify(r.document)).toContain("subbase");
  });
});

describe("5 -- bad input refuses without mutating", () => {
  const bad: [string, unknown[]][] = [
    ["zero", [{ name: "x", thicknessIn: 0 }]],
    ["negative", [{ name: "x", thicknessIn: -4 }]],
    ["NaN", [{ name: "x", thicknessIn: Number.NaN }]],
    ["infinity", [{ name: "x", thicknessIn: Number.POSITIVE_INFINITY }]],
    ["missing thickness", [{ name: "x" }]],
    ["missing name", [{ thicknessIn: 4 }]],
    ["not an object", ["surface 4 inches"]],
  ];

  for (const [label, layers] of bad) {
    it(`refuses ${label} and changes nothing`, async () => {
      const h = makeHost();
      await setStack(h.host, STACK);
      const before = JSON.stringify(h.form());
      const pending = h.host.pendingChanges().length;

      const r = await setStack(h.host, layers);
      expect(r.committed).toBeUndefined();
      expect(JSON.stringify(h.form())).toBe(before);
      expect(h.host.pendingChanges()).toHaveLength(pending);
    });
  }

  it("refuses a malformed layers argument", async () => {
    const h = makeHost();
    const r = await call(h.host, "set_pavement_layers",
      { template: "2-lane", layers: "surface", commit: true });
    expect(r.code).toBe("BadArgument");
  });

  it("refuses an unknown template and lists the real ones", async () => {
    const h = makeHost();
    const r = await setStack(h.host, STACK, true, "no-such-template");
    expect(r.code).toBe("TemplateNotFound");
    expect(r.available).toEqual(["2-lane", "ramp"]);
    expect(h.form().templates[0]!.pavementLayers).toBeUndefined();
  });

  it("ALLOWS duplicate layer names, because order identifies a course", async () => {
    const h = makeHost();
    const r = await setStack(h.host, [
      { name: "base", thicknessIn: 6 },
      { name: "base", thicknessIn: 6 },
    ]);
    expect(r.committed).toBe(true);
    expect(r.totalThicknessIn).toBe(12);
  });
});

describe("6 -- templates keep independent stacks", () => {
  it("setting one does not touch another", async () => {
    const h = makeHost();
    await setStack(h.host, STACK, true, "2-lane");
    await setStack(h.host, [{ name: "ramp surface", thicknessIn: 3 }], true, "ramp");

    const read = await call(h.host, "read_pavement_layers", {});
    const rows = read.templates as { template: string; layers: { name: string }[] }[];
    expect(rows.find((x) => x.template === "2-lane")!.layers.map((L) => L.name))
      .toEqual(["surface", "base", "subbase"]);
    expect(rows.find((x) => x.template === "ramp")!.layers.map((L) => L.name))
      .toEqual(["ramp surface"]);
  });
});

describe("7 -- an empty stack removes every layer, and undo restores them", () => {
  it("commits the removal", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const r = await setStack(h.host, []);
    expect(r.committed).toBe(true);
    expect(r.replacedLayerCount).toBe(3);
    expect(h.form().templates[0]!.pavementLayers).toBeUndefined();
  });

  it("undo brings the whole stack back", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    await setStack(h.host, []);
    await call(h.host, "undo_last_change", {});
    const read = await call(h.host, "read_pavement_layers", {});
    const t = (read.templates as { template: string; layers: { name: string }[] }[])
      .find((x) => x.template === "2-lane")!;
    expect(t.layers.map((L) => L.name)).toEqual(["surface", "base", "subbase"]);
  });
});

describe("8 -- the geometry has one visible course per authored entry", () => {
  it("builds a mesh per layer, in order, at true thickness", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const design = formToDesign(h.form());
    const meshes = buildPavementMeshes(design, { e: 0, n: 0, z: 0 }, 25);

    expect(meshes).toHaveLength(3);
    expect(meshes.map((m) => m.name)).toEqual(["surface", "base", "subbase"]);
    expect(meshes.map((m) => m.thicknessIn)).toEqual([4, 8, 12]);
    for (const m of meshes) expect(m.indices.length).toBeGreaterThan(0);
  });

  it("stacks them top-down at the authored depths, not exaggerated", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const design = formToDesign(h.form());
    const meshes = buildPavementMeshes(design, { e: 0, n: 0, z: 0 }, 25);
    // 0, then 4/12 ft, then (4+8)/12 ft. Depths are exact, never scaled.
    expect(meshes.map((m) => m.topDepthFt)).toEqual([0, 4 / 12, 12 / 12]);
  });

  it("gives three courses three distinct colours, deterministically", () => {
    const a = pavementLayerColors(3);
    const b = pavementLayerColors(3);
    expect(new Set(a).size).toBe(3);
    expect(a).toEqual(b);
  });

  it("draws nothing for a template with no authored stack", async () => {
    const h = makeHost();
    const design = formToDesign(h.form());
    expect(buildPavementMeshes(design, { e: 0, n: 0, z: 0 }, 25)).toHaveLength(0);
  });
});

describe("9 -- no response claims an engineering judgement", () => {
  it("set_pavement_layers says only what was authored", async () => {
    const h = makeHost();
    const r = await setStack(h.host, STACK);
    // Strip the DISCLAIMER sentence before looking for claims: saying "no
    // structural adequacy was calculated" is the opposite of claiming one.
    const claims = JSON.stringify(r)
      .replace(/No structural adequacy[^"]*?calculated\./gi, "");
    expect(claims).not.toMatch(/recommend|pavement life|structural number|design life|complian/i);
  });

  it("read_pavement_layers says only what was authored", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const r = await call(h.host, "read_pavement_layers", {});
    const claims = JSON.stringify(r)
      .replace(/NO structural adequacy was calculated[^"]*/gi, "")
      .replace(/does not compute[^"]*/gi, "");
    expect(claims).not.toMatch(/recommend|pavement life|structural number|design life/i);
  });

  it("states plainly that nothing was calculated", async () => {
    const h = makeHost();
    await setStack(h.host, STACK);
    const r = await call(h.host, "read_pavement_layers", {});
    expect(String(r.note)).toMatch(/no structural adequacy was calculated/i);
  });
});
