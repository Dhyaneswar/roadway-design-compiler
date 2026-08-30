// Live log of what the agent actually did.
//
// Two reasons this exists, and the first is not cosmetic:
//
// 1. PROOF OF MECHANISM. When an agent drives this page you cannot tell, from
//    the outside, whether it called our WebMCP tools or just clicked around the
//    DOM with browser control. Those are very different claims. Every entry here
//    is written from inside `executeTool`, so a filled log is direct evidence
//    that the agent used the tool surface -- and an empty log while the form
//    changes is evidence that it did not.
//
// 2. It makes the agent's work legible to the engineer who has to sign for it.
//    A reviewer should never have to guess what was proposed.

export type ActivityKind = "read" | "preview" | "commit" | "refused" | "error";

export interface ActivityEntry {
  readonly seq: number;
  readonly tool: string;
  readonly kind: ActivityKind;
  /** One-line summary of what came back. */
  readonly summary: string;
  /** Wall clock, for the log line. */
  readonly at: Date;
}

const MAX_ENTRIES = 200;

export class AgentActivityLog {
  private entries: ActivityEntry[] = [];
  private seq = 0;
  private listeners: (() => void)[] = [];

  /** Called from inside the tool executor, for every invocation. */
  record(tool: string, kind: ActivityKind, summary: string, at: Date = new Date()): ActivityEntry {
    const entry: ActivityEntry = { seq: ++this.seq, tool, kind, summary, at };
    this.entries.push(entry);
    // Bound the log: a long agent session should not grow memory without limit.
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    for (const l of this.listeners) l();
    return entry;
  }

  /** Newest first, which is how it is read. */
  recent(limit = 50): readonly ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  count(): number {
    return this.seq;
  }

  /** Number of calls that changed the model. */
  commitCount(): number {
    return this.entries.filter((e) => e.kind === "commit").length;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  clear(): void {
    this.entries = [];
    this.seq = 0;
    for (const l of this.listeners) l();
  }
}

/**
 * Classify a tool result into a log entry, without the caller having to know the
 * shape of every response. Kept here so the bridge stays about engineering and
 * this stays about presentation.
 */
export function classifyResult(
  result: unknown,
): { kind: ActivityKind; summary: string } {
  if (typeof result !== "object" || result === null) {
    return { kind: "read", summary: "ok" };
  }
  const r = result as Record<string, unknown>;

  if (r.error === true) {
    return { kind: "error", summary: String(r.code ?? "error") + ": " + String(r.detail ?? "") };
  }
  if (r.refused === true) {
    return { kind: "refused", summary: String(r.code ?? "refused") };
  }
  if (r.committed === true) {
    const what = typeof r.change === "string" ? r.change : "change applied";
    return { kind: "commit", summary: what };
  }
  if (r.previewed === true) {
    const what = typeof r.change === "string" ? r.change : "previewed";
    return { kind: "preview", summary: what + " (no change)" };
  }

  // Reads: summarise the most useful scalar we can find rather than dumping JSON.
  if (typeof r.pendingCount === "number") {
    return { kind: "read", summary: `${r.pendingCount} pending` };
  }
  if (typeof r.checked === "number" && typeof r.failed === "number") {
    return { kind: "read", summary: `${r.checked} checks, ${r.failed} failed` };
  }
  if (typeof r.lengthBytes === "number") {
    return { kind: "read", summary: `${r.lengthBytes} bytes` };
  }
  if (Array.isArray(r.curves)) {
    return { kind: "read", summary: `${r.curves.length} curves` };
  }
  if (Array.isArray(r.transitions)) {
    return { kind: "read", summary: `${r.transitions.length} transitions` };
  }
  if (typeof r.lengthFt === "number") {
    return { kind: "read", summary: `${r.lengthFt} ft` };
  }
  if (typeof r.valid === "boolean") {
    return { kind: "read", summary: r.valid ? "design valid" : "design invalid" };
  }
  return { kind: "read", summary: "ok" };
}
