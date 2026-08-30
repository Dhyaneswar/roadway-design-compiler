import { describe, expect, it } from "vitest";
import { AgentActivityLog, classifyResult } from "../src/studio/agent-activity";

describe("classifying a tool result", () => {
  it("reads a commit", () => {
    const c = classifyResult({ committed: true, change: "add tangent" });
    expect(c.kind).toBe("commit");
    expect(c.summary).toBe("add tangent");
  });

  it("reads a preview and says nothing changed", () => {
    const c = classifyResult({ previewed: true, committed: false, change: "widen curve 1" });
    expect(c.kind).toBe("preview");
    expect(c.summary).toContain("no change");
  });

  it("reads a refusal by its code, not its prose", () => {
    const c = classifyResult({ refused: true, code: "VerticalCurvesOverlap", detail: "..." });
    expect(c.kind).toBe("refused");
    expect(c.summary).toBe("VerticalCurvesOverlap");
  });

  it("keeps a bridge fault distinct from an engineering refusal", () => {
    const c = classifyResult({ error: true, code: "BridgeFault", detail: "boom" });
    expect(c.kind).toBe("error");
    expect(c.summary).toContain("BridgeFault");
  });

  it("summarises a criteria read by its counts", () => {
    expect(classifyResult({ checked: 8, failed: 3 }).summary).toBe("8 checks, 3 failed");
  });

  it("falls back to ok rather than dumping JSON", () => {
    expect(classifyResult({ something: "unrecognised" }).summary).toBe("ok");
    expect(classifyResult(null).kind).toBe("read");
  });
});

describe("the activity log", () => {
  it("counts every call and separates the ones that changed the model", () => {
    const l = new AgentActivityLog();
    l.record("read_design", "read", "ok");
    l.record("set_pvi", "commit", "set PVI 2");
    l.record("export_landxml", "refused", "AwaitingEngineerConfirmation");
    expect(l.count()).toBe(3);
    expect(l.commitCount()).toBe(1);
  });

  it("returns newest first, which is how it is read", () => {
    const l = new AgentActivityLog();
    l.record("first", "read", "a");
    l.record("second", "read", "b");
    expect(l.recent()[0]!.tool).toBe("second");
  });

  it("bounds itself so a long agent session cannot grow without limit", () => {
    const l = new AgentActivityLog();
    for (let i = 0; i < 260; i++) l.record("t" + i, "read", "x");
    expect(l.recent(500).length).toBeLessThanOrEqual(200);
    // the sequence keeps counting even though old entries were dropped
    expect(l.count()).toBe(260);
  });

  it("notifies a listener on every record", () => {
    const l = new AgentActivityLog();
    let fired = 0;
    l.onChange(() => fired++);
    l.record("a", "read", "x");
    l.record("b", "read", "y");
    expect(fired).toBe(2);
  });

  it("is empty before any agent touches it -- the discriminator", () => {
    const l = new AgentActivityLog();
    expect(l.count()).toBe(0);
    expect(l.recent()).toHaveLength(0);
  });
});
