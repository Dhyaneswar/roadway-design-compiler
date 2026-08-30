import { describe, expect, it } from "vitest";
import { AgentChangeLedger } from "../src/studio/agent-changes";

describe("agent change ledger", () => {
  it("records changes as pending, never pre-confirmed", () => {
    const l = new AgentChangeLedger();
    const c = l.record("add 1500 ft tangent");
    expect(c.confirmed).toBe(false);
    expect(l.pendingCount()).toBe(1);
  });

  it("issues unique increasing ids", () => {
    const l = new AgentChangeLedger();
    expect(l.record("a").id).toBe(1);
    expect(l.record("b").id).toBe(2);
  });

  it("blocks the deliverable while anything is unconfirmed, and says what", () => {
    const l = new AgentChangeLedger();
    l.record("bank the curves at 70 mph");
    const blocked = l.exportBlockedReason();
    expect(blocked?.pendingCount).toBe(1);
    expect(blocked?.descriptions[0]).toContain("bank the curves");
  });

  it("clears the block only once a human confirms", () => {
    const l = new AgentChangeLedger();
    l.record("widen curve 1");
    expect(l.exportBlockedReason()).toBeDefined();
    expect(l.confirmAll()).toBe(1);
    expect(l.exportBlockedReason()).toBeUndefined();
  });

  it("confirms one change at a time without touching the others", () => {
    const l = new AgentChangeLedger();
    const a = l.record("a");
    l.record("b");
    expect(l.confirm(a.id)).toBe(true);
    expect(l.pendingCount()).toBe(1);
  });

  it("will not double-confirm", () => {
    const l = new AgentChangeLedger();
    const a = l.record("a");
    expect(l.confirm(a.id)).toBe(true);
    expect(l.confirm(a.id)).toBe(false);
  });

  it("reports nothing to confirm on an untouched design", () => {
    const l = new AgentChangeLedger();
    expect(l.exportBlockedReason()).toBeUndefined();
    expect(l.confirmAll()).toBe(0);
  });

  it("keeps confirmed history rather than deleting it", () => {
    const l = new AgentChangeLedger();
    l.record("a");
    l.confirmAll();
    expect(l.all()).toHaveLength(1);
    expect(l.all()[0]!.confirmed).toBe(true);
  });

  it("forgets everything on clear, including the id sequence", () => {
    const l = new AgentChangeLedger();
    l.record("a");
    l.clear();
    expect(l.all()).toHaveLength(0);
    expect(l.record("fresh").id).toBe(1);
  });
});
