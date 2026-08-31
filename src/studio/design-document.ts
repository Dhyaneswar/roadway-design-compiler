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

/** Bumped when the shape changes in a way older links would not survive. */
export const DOCUMENT_VERSION = 1;

export interface DesignDocument {
  version: number;
  /** ISO timestamp, so a recipient knows how old the design is. */
  savedAt: string;
  form: StudioForm;
}

export function toDocument(form: StudioForm, now: Date = new Date()): DesignDocument {
  return {
    version: DOCUMENT_VERSION,
    savedAt: now.toISOString(),
    form: JSON.parse(JSON.stringify(form)) as StudioForm,
  };
}

export type LoadResult =
  | { ok: true; form: StudioForm; savedAt?: string }
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
  return { ok: true, form: doc as unknown as StudioForm, savedAt };
}

// --- URL fragment packing -------------------------------------------------
//
// base64url over the JSON. Not compressed: a road of this size is a couple of KB,
// well inside what browsers and chat clients carry, and a readable encoding is
// worth more than a few hundred bytes when someone has to debug a broken link.

const FRAGMENT_KEY = "design=";

export function encodeFragment(form: StudioForm, now?: Date): string {
  const json = JSON.stringify(toDocument(form, now));
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

/** A link that reproduces this design exactly. */
export function shareUrl(form: StudioForm, base: string): string {
  const clean = base.split("#")[0];
  return `${clean}#${encodeFragment(form)}`;
}

// --- autosave -------------------------------------------------------------

const STORAGE_KEY = "rdc:design";

/** Persist across a reload. Never throws: blocked storage must not break the app. */
export function autosave(form: StudioForm, storage?: Storage): void {
  try {
    (storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(toDocument(form)));
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
