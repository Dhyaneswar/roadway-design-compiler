// The agent-proposed change ledger.
//
// ADR: an agent can never be the confirming party.
//
// A licensed Professional Engineer seals a roadway design and carries personal
// legal liability for it. That signature cannot be delegated to software, so
// this app draws the line in the only place it can be enforced: an agent may
// author freely, but everything it authors is held as PROPOSED until a human
// confirms it, and the deliverable -- the LandXML an engineer would hand to
// ORD -- cannot be produced while anything is still unconfirmed.
//
// The agent is told this plainly by every tool response, and it can read its own
// unconfirmed work. It just cannot clear the flag. There is no tool for that,
// deliberately: confirmation happens in the UI, by a person.

export interface AgentChange {
  /** Monotonic id, unique within the session. */
  readonly id: number;
  /** What the agent did, in the words the tool used. */
  readonly description: string;
  /** Wall-clock time the change was applied. */
  readonly at: string;
  /** Whether a human has confirmed it. */
  confirmed: boolean;
  /**
   * The design as it stood BEFORE this change, so it can be undone. Opaque here
   * on purpose: the ledger is about authority, not about roadway geometry.
   */
  readonly before?: unknown;
  /**
   * True when this records work that arrived ALREADY unconfirmed -- carried in
   * from a shared document or restored after a reload -- rather than a change
   * made here.
   *
   * It still blocks the deliverable: unreviewed work is unreviewed whoever
   * authored it. But it is NOT a transaction, so it is never the target of an
   * undo and must never sit in front of one. Entries like this used to pile up
   * on top of the stack with no snapshot, and undoLast refused on the topmost
   * one -- so a design that arrived with inherited provenance could never be
   * undone at all.
   */
  readonly inherited?: boolean;
  /**
   * For an inherited entry, the id of the transaction that brought it in.
   *
   * Undoing that transaction discards the document it loaded, so the provenance
   * that arrived WITH it goes too -- otherwise the ledger keeps describing a
   * terrain and a guardrail that are no longer anywhere, and the deliverable
   * stays blocked by work that has already been thrown away.
   *
   * Undefined for provenance that was already present -- restored after a reload
   * or opened from a link. That is not owned by any transaction here and must
   * survive every undo, because nothing in this session reviewed it.
   */
  readonly introducedBy?: number;
}

export class AgentChangeLedger {
  private changes: AgentChange[] = [];
  private nextId = 1;

  /** Record an agent-authored change as pending confirmation. */
  record(
    description: string,
    before?: unknown,
    now: Date = new Date(),
    inherited = false,
    introducedBy?: number,
  ): AgentChange {
    const change: AgentChange = {
      id: this.nextId++,
      description,
      at: now.toISOString(),
      confirmed: false,
      before,
      ...(inherited ? { inherited: true } : {}),
      ...(introducedBy !== undefined ? { introducedBy } : {}),
    };
    this.changes.push(change);
    return change;
  }

  /** The most recent change, confirmed or not. */
  last(): AgentChange | undefined {
    return this.changes[this.changes.length - 1];
  }

  /** The most recent real TRANSACTION, ignoring inherited provenance. */
  lastTransaction(): AgentChange | undefined {
    for (let i = this.changes.length - 1; i >= 0; i -= 1) {
      const c = this.changes[i]!;
      if (c.inherited !== true) return c;
    }
    return undefined;
  }

  /**
   * Remove the most recent change and hand back the design that preceded it.
   *
   * ⛔ Refuses when the last change has been CONFIRMED. Once a licensed engineer
   * has accepted work, an agent silently reverting it would undo something a
   * person has already stood behind. The agent must author a new, visible change
   * instead -- which lands in this ledger and needs its own confirmation.
   */
  undoLast():
    | { ok: true; change: AgentChange; before: unknown }
    | { ok: false; reason: "nothing-to-undo" | "last-change-confirmed"; change?: AgentChange } {
    // The most recent real TRANSACTION, stepping over inherited provenance.
    // Those carry no snapshot and describe somebody else's unreviewed work, so
    // they are not undoable and must not shadow the change beneath them.
    let i = this.changes.length - 1;
    while (i >= 0 && this.changes[i]!.inherited === true) i -= 1;
    if (i < 0) return { ok: false, reason: "nothing-to-undo" };
    const change = this.changes[i]!;
    if (change.confirmed) return { ok: false, reason: "last-change-confirmed", change };
    if (change.before === undefined) return { ok: false, reason: "nothing-to-undo", change };
    this.changes.splice(i, 1);
    // Take the provenance this transaction introduced with it. Leaving it behind
    // orphans the ledger: both real transactions undone, nothing on the page,
    // and entries still describing the discarded document's terrain and
    // guardrail while the deliverable stays blocked by them.
    this.changes = this.changes.filter((c) => c.introducedBy !== change.id);
    return { ok: true, change, before: change.before };
  }

  all(): readonly AgentChange[] {
    return this.changes;
  }

  pending(): readonly AgentChange[] {
    return this.changes.filter((c) => !c.confirmed);
  }

  pendingCount(): number {
    return this.pending().length;
  }

  /** A person confirms everything outstanding. There is no agent-facing path here. */
  confirmAll(): number {
    const n = this.pendingCount();
    for (const c of this.changes) c.confirmed = true;
    return n;
  }

  /** A person confirms one change. */
  confirm(id: number): boolean {
    const c = this.changes.find((x) => x.id === id);
    if (!c || c.confirmed) return false;
    c.confirmed = true;
    return true;
  }

  /** Forget everything -- used when the design is reset. */
  clear(): void {
    this.changes = [];
    this.nextId = 1;
  }

  /**
   * Why the deliverable is blocked, or undefined when it is clear.
   * Returned as data so the caller can shape it into a refusal.
   */
  exportBlockedReason(): { pendingCount: number; descriptions: string[] } | undefined {
    const pending = this.pending();
    if (pending.length === 0) return undefined;
    return {
      pendingCount: pending.length,
      descriptions: pending.map((c) => c.description),
    };
  }
}
