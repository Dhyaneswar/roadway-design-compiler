import { describe, expect, it } from "vitest";
import {
  DOCUMENT_VERSION,
  autosave,
  clearAutosave,
  decodeFragment,
  encodeFragment,
  fromDocument,
  loadAutosave,
  shareUrl,
  toDocument,
} from "../src/studio/design-document";
import type { StudioForm } from "../src/studio/form-to-design";

const form = (): StudioForm => ({
  name: "Shared Road",
  beginStation: 1000,
  startE: 2200000,
  startN: 1350000,
  startAzimuthDeg: 75,
  elements: [
    { kind: "tangent", length: "1200" },
    { kind: "arc", radius: "1500", deltaDeg: "45", direction: "right" },
  ],
  pvis: [
    { station: "1000", elevation: "850" },
    { station: "2378", elevation: "865" },
  ],
  templates: [{
    name: "2-lane",
    left: [{ name: "lane", width: "12", slopePercent: "-2" }],
    right: [{ name: "lane", width: "12", slopePercent: "-2" }],
  }],
  drops: [{ template: "2-lane", toStation: "" }],
  superelevation: { designSpeedMph: 55, emax: 0.06 },
});

/** Minimal in-memory Storage, so the tests never touch a real browser. */
const fakeStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as Storage;
};

describe("the design document", () => {
  it("stamps a version and a time so a recipient knows what they got", () => {
    const d = toDocument(form(), new Date("2026-08-30T12:00:00Z"));
    expect(d.version).toBe(DOCUMENT_VERSION);
    expect(d.savedAt).toBe("2026-08-30T12:00:00.000Z");
  });

  it("copies rather than aliasing, so a later edit cannot mutate a saved document", () => {
    const f = form();
    const d = toDocument(f);
    f.elements[0]!.length = "9999";
    expect(d.form.elements[0]!.length).toBe("1200");
  });

  it("round-trips every field including superelevation", () => {
    const r = fromDocument(toDocument(form()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form.superelevation?.designSpeedMph).toBe(55);
    expect(r.form.elements).toHaveLength(2);
    expect(r.form.name).toBe("Shared Road");
  });

  it("accepts a bare form as well as a wrapped document", () => {
    const r = fromDocument(form());
    expect(r.ok).toBe(true);
  });

  it("refuses a document from a newer app rather than silently losing detail", () => {
    const r = fromDocument({ version: DOCUMENT_VERSION + 5, form: form() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("newer than this app understands");
  });

  it("names the field that is wrong rather than failing blankly", () => {
    const broken = { ...form(), pvis: "not an array" };
    const r = fromDocument(broken);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("pvis");
  });

  it("rejects a non-numeric start coordinate", () => {
    const r = fromDocument({ ...form(), startE: "east" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("startE");
  });

  it("rejects rubbish without throwing", () => {
    expect(fromDocument(null).ok).toBe(false);
    expect(fromDocument("a string").ok).toBe(false);
    expect(fromDocument(42).ok).toBe(false);
  });
});

describe("sharing by link", () => {
  it("round-trips through a URL fragment", () => {
    const r = decodeFragment(encodeFragment(form()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form.name).toBe("Shared Road");
    expect(r.form.elements[1]!.radius).toBe("1500");
  });

  it("produces a fragment that is URL-safe", () => {
    const f = encodeFragment(form());
    expect(f.startsWith("design=")).toBe(true);
    // Only the payload has to be base64url; the "design=" key keeps its '='.
    const payload = f.slice("design=".length);
    expect(payload).not.toMatch(/[+/=]/);
  });

  it("builds a share link on the page's own origin and replaces any old fragment", () => {
    const url = shareUrl(form(), "https://example.test/studio#design=stale");
    expect(url.startsWith("https://example.test/studio#design=")).toBe(true);
    expect(url).not.toContain("stale");
  });

  it("says so when a link carries no design", () => {
    const r = decodeFragment("#something-else");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("no design");
  });

  it("reports a truncated link instead of throwing", () => {
    const good = encodeFragment(form());
    const r = decodeFragment(good.slice(0, good.length - 40));
    expect(r.ok).toBe(false);
  });

  it("keeps the whole design inside a link a chat client will carry", () => {
    // Well under the ~8 KB that browsers and messaging apps handle comfortably.
    expect(encodeFragment(form()).length).toBeLessThan(4000);
  });
});

describe("autosave", () => {
  it("survives a reload", () => {
    const s = fakeStorage();
    autosave(form(), s);
    const r = loadAutosave(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form.name).toBe("Shared Road");
  });

  it("reports an empty store rather than failing", () => {
    const r = loadAutosave(fakeStorage());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("nothing saved");
  });

  it("clears", () => {
    const s = fakeStorage();
    autosave(form(), s);
    clearAutosave(s);
    expect(loadAutosave(s).ok).toBe(false);
  });

  it("never throws when storage is blocked, because losing autosave must not break the app", () => {
    const hostile = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
      clear: () => {}, key: () => null, length: 0,
    } as unknown as Storage;
    expect(() => autosave(form(), hostile)).not.toThrow();
    expect(() => clearAutosave(hostile)).not.toThrow();
    expect(loadAutosave(hostile).ok).toBe(false);
  });
});
