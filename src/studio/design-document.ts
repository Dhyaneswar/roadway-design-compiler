// Saving, loading and sharing a design.
//
// Why this matters more than it looks: the whole premise of this app is that an
// agent proposes and a LICENSED ENGINEER reviews and seals. Without a way to hand
// the design to that engineer, the review has to happen over the shoulder of
// whoever has the browser tab open. A design you cannot send is a design nobody
// else can check.
//
// So a design serialises to a portable document, restores from one, and packs into
// a URL fragment that carries the whole thing -- no server, no account, no upload.
// Send the link, the recipient opens exactly what you were looking at.
//
// The fragment is used deliberately: everything after '#' stays in the browser and
// is never sent to the server, so a design in a link is not logged by anyone's
// infrastructure on the way.

import type { StudioForm } from "./form-to-design";

/**
 * Bumped when the shape changes in a way older links would not survive.
 *
 * 2: carries `unconfirmed`. A v1 build opening a v2 link would drop the
 * provenance silently, which is exactly the failure this field exists to
 * prevent -- so the version gate refuses it instead.
 */
export const DOCUMENT_VERSION = 2;

export interface DesignDocument {
  version: number;
  /** ISO timestamp, so a recipient knows how old the design is. */
  savedAt: string;
  form: StudioForm;
  /**
   * Agent-authored changes that were NOT yet confirmed when this was saved.
   *
   * ⛔ Without this a design LAUNDERS through a link. Independent QA found a
   * source page with three pending changes whose shared copy showed no banner
   * and an enabled export button: the unconfirmed work arrived looking
   * reviewed. Confirmation is a licensed engineer's act on a specific design,
   * and it does not survive being copied to somebody else -- so what travels is
   * the fact that the work is still unconfirmed.
   */
  unconfirmed?: string[];
  /**
   * What imported context this design was worked against -- NOT the context.
   *
   * ⛔ Deliberate: the data is not saved. A single TIN here is 25,140 triangles;
   * localStorage is about 5 MB and a real survey would blow it, and a URL that
   * carried a surface would be megabytes long. So context is not persisted.
   *
   * But losing it SILENTLY is the problem. A design whose cut and fill were
   * computed against a surveyed surface reopens with no surface at all, and
   * nothing says the ground it was fitted to is missing. The names and counts
   * cost a few dozen bytes and let the app say exactly what to re-import.
   */
  context?: {
    terrainName?: string;
    terrainTriangles?: number;
    siteFeatureCount?: number;
    designSectionCount?: number;
  };
}

export function toDocument(
  form: StudioForm,
  now: Date = new Date(),
  unconfirmed: readonly string[] = [],
  context?: DesignDocument["context"],
): DesignDocument {
  const hasContext = context !== undefined
    && Object.values(context).some((v) => v !== undefined && v !== 0);
  return {
    version: DOCUMENT_VERSION,
    savedAt: now.toISOString(),
    form: JSON.parse(JSON.stringify(form)) as StudioForm,
    ...(unconfirmed.length > 0 ? { unconfirmed: [...unconfirmed] } : {}),
    ...(hasContext ? { context } : {}),
  };
}

export type LoadResult =
  | { ok: true; form: StudioForm; savedAt?: string; unconfirmed: string[];
      context?: DesignDocument["context"] }
  | { ok: false; reason: string };

/**
 * Restore a document. Deliberately forgiving about WHERE the design sits -- a
 * bare form works as well as a wrapped document -- because an agent that has just
 * read a design and hands it straight back should not be punished for it.
 */
export function fromDocument(input: unknown): LoadResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "not an object" };
  }
  const raw = input as Record<string, unknown>;
  const doc = (typeof raw.form === "object" && raw.form !== null ? raw.form : raw) as Record<string, unknown>;

  if (typeof raw.version === "number" && raw.version > DOCUMENT_VERSION) {
    return {
      ok: false,
      reason: `document version ${raw.version} is newer than this app understands ` +
        `(${DOCUMENT_VERSION}). Open it in a newer build rather than losing detail.`,
    };
  }
  // Shape check only. The kernel and zod do the real validation downstream; this
  // exists so a truncated link fails with something a human can act on.
  for (const key of ["elements", "pvis", "templates", "drops"]) {
    if (!Array.isArray(doc[key])) {
      return { ok: false, reason: `missing or malformed "${key}"` };
    }
  }
  for (const key of ["beginStation", "startE", "startN", "startAzimuthDeg"]) {
    if (typeof doc[key] !== "number" || !Number.isFinite(doc[key] as number)) {
      return { ok: false, reason: `missing or non-numeric "${key}"` };
    }
  }
  const savedAt = typeof raw.savedAt === "string" ? raw.savedAt : undefined;
  const unconfirmed = Array.isArray(raw.unconfirmed)
    ? raw.unconfirmed.filter((x): x is string => typeof x === "string")
    : [];
  const context = typeof raw.context === "object" && raw.context !== null
    ? raw.context as DesignDocument["context"] : undefined;
  return { ok: true, form: doc as unknown as StudioForm, savedAt, unconfirmed, context };
}

// --- URL fragment packing -------------------------------------------------
//
// base64url over the JSON. Not compressed: a road of this size is a couple of KB,
// well inside what browsers and chat clients carry, and a readable encoding is
// worth more than a few hundred bytes when someone has to debug a broken link.

const FRAGMENT_KEY = "design=";

export function encodeFragment(
  form: StudioForm,
  now?: Date,
  unconfirmed: readonly string[] = [],
  context?: DesignDocument["context"],
): string {
  const json = JSON.stringify(toDocument(form, now, unconfirmed, context));
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return FRAGMENT_KEY + b64;
}

export function decodeFragment(fragment: string): LoadResult {
  const raw = fragment.replace(/^#/, "");
  if (!raw.startsWith(FRAGMENT_KEY)) return { ok: false, reason: "no design in this link" };
  const b64 = raw.slice(FRAGMENT_KEY.length).replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return fromDocument(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return { ok: false, reason: "the design in this link is corrupt or truncated" };
  }
}

/**
 * A link that reproduces this design exactly -- including what is unconfirmed.
 * "Exactly" has to include the provenance, or the link becomes a way to strip it.
 */
export function shareUrl(
  form: StudioForm,
  base: string,
  unconfirmed: readonly string[] = [],
  context?: DesignDocument["context"],
): string {
  const clean = base.split("#")[0];
  return `${clean}#${encodeFragment(form, undefined, unconfirmed, context)}`;
}

// --- autosave -------------------------------------------------------------

const STORAGE_KEY = "rdc:design";

/** Persist across a reload. Never throws: blocked storage must not break the app. */
export function autosave(
  form: StudioForm,
  storage?: Storage,
  unconfirmed: readonly string[] = [],
  context?: DesignDocument["context"],
): void {
  try {
    (storage ?? window.localStorage).setItem(
      STORAGE_KEY, JSON.stringify(toDocument(form, undefined, unconfirmed, context)));
  } catch {
    /* private mode, quota, blocked cookies -- losing autosave is not worth an error */
  }
}

export function loadAutosave(storage?: Storage): LoadResult {
  try {
    const raw = (storage ?? window.localStorage).getItem(STORAGE_KEY);
    if (raw === null) return { ok: false, reason: "nothing saved" };
    return fromDocument(JSON.parse(raw));
  } catch {
    return { ok: false, reason: "saved design could not be read" };
  }
}

export function clearAutosave(storage?: Storage): void {
  try {
    (storage ?? window.localStorage).removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
