// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildTools, type StudioHost } from "../src/studio/webmcp-bridge";
import type { StudioForm } from "../src/studio/form-to-design";

/**
 * The tool catalogue is a CONTRACT, and it must not say things that are untrue.
 *
 * F037. `remove_horizontal_element` and `remove_pvi` both told an agent "there is
 * no undo tool". `undo_last_change` exists and reverses either removal completely
 * while it is still an unconfirmed agent change -- QA committed each removal and
 * undid it exactly.
 *
 * ⚠ A description is not decoration. An agent reading "no undo" avoids a
 * reversible action, or tells a person their change is permanent when it is not.
 * The catalogue is the only thing an agent has; a false sentence in it is a bug
 * with no stack trace.
 *
 * F033/F034/F029 were the app doing something other than what it said. This is
 * the same defect one layer up: the app doing something BETTER than it said.
 */

const host = {
  readForm: () => ({}) as StudioForm,
  writeForm: () => {},
  pendingChanges: () => [],
  undoLastAgentChange: () => ({ ok: false as const, reason: "nothing-to-undo" as const }),
  offerAlternatives: () => 0,
  shareLink: () => "",
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
} as unknown as StudioHost;

const tools = buildTools(host);
const byName = (n: string) => {
  const t = tools.find((x) => x.name === n);
  expect(t, `tool ${n} exists`).toBeDefined();
  return t!;
};

describe("no tool denies a recovery path the app actually has", () => {
  it("undo_last_change is in the catalogue at all", () => {
    // The premise of every claim below.
    expect(tools.map((t) => t.name)).toContain("undo_last_change");
  });

  for (const name of ["remove_horizontal_element", "remove_pvi"]) {
    it(`${name} does not claim there is no undo`, () => {
      const d = byName(name).description;
      expect(d).not.toMatch(/no undo/i);
      expect(d).not.toMatch(/cannot be undone/i);
      expect(d).not.toMatch(/irreversible/i);
    });

    it(`${name} names undo_last_change and its condition`, () => {
      const d = byName(name).description;
      expect(d).toContain("undo_last_change");
      // The condition matters as much as the tool: undo refuses once a person
      // has confirmed the change, which is the whole point of the seal.
      expect(d).toMatch(/unconfirmed/i);
    });

    it(`${name} still warns that it is destructive`, () => {
      // Correcting the undo claim must not soften the warning into nothing.
      expect(byName(name).description).toMatch(/DESTRUCTIVE/);
      expect(byName(name).description).toMatch(/Preview first/i);
    });
  }

  it("no description anywhere denies undo", () => {
    // A sweep, so the next tool to copy the phrasing is caught here rather than
    // by an agent that believed it.
    const liars = tools.filter((t) =>
      /no undo tool|cannot be undone|irreversible/i.test(t.description),
    );
    expect(liars.map((t) => t.name)).toEqual([]);
  });
});

describe("the delta bound is stated wherever it is enforced", () => {
  // The same class as F037: enforced in one place, documented in another.
  for (const name of ["add_horizontal_element", "set_horizontal_element"]) {
    it(`${name} states the exclusive 180 bound`, () => {
      const schema = byName(name).inputSchema as {
        properties: Record<string, { description: string }>;
      };
      const d = schema.properties.deltaDeg!.description;
      expect(d).toMatch(/less than 180/i);
      expect(d).not.toMatch(/0 to 180/);
    });
  }
});
