// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { firstIllegalXmlChar, isXmlSafeText, illegalXmlCharMessage } from "../src/schema/xml-text";
import { parseRoadDesign } from "../src/schema/validate";
import { toLandXML } from "../src/exporters/landxml";
import type { HorizontalAlignment, VerticalProfile } from "../src/schema/road-design";

/**
 * F034. Escaping metacharacters is not the same as staying inside the XML 1.0
 * character set. `A\u0001B` escaped to itself, exported "successfully", and
 * produced a file Chrome's own parser rejected.
 *
 * XML 1.0 §2.2:
 *   Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 */

describe("what XML 1.0 can and cannot carry", () => {
  it("accepts ordinary text, including the metacharacters the escaper handles", () => {
    for (const s of ["RDC-S1", 'A & B "quoted" <road>', "Skärgårdsstad", "道路", "a\u{1F600}b"]) {
      expect(isXmlSafeText(s), s).toBe(true);
    }
  });

  it("accepts tab, LF and CR -- they are legal characters", () => {
    // Deliberate: the exporter writes them as character references so they
    // survive attribute-value normalisation rather than collapsing to spaces.
    for (const s of ["a\tb", "a\nb", "a\rb"]) {
      expect(isXmlSafeText(s), JSON.stringify(s)).toBe(true);
    }
  });

  it("rejects the C0 controls XML cannot represent", () => {
    for (const cp of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1f]) {
      const s = `a${String.fromCharCode(cp)}b`;
      expect(isXmlSafeText(s), `U+${cp.toString(16)}`).toBe(false);
      expect(firstIllegalXmlChar(s)!.codePoint).toBe(cp);
      expect(firstIllegalXmlChar(s)!.index).toBe(1);
    }
  });

  it("rejects the noncharacters and a lone surrogate", () => {
    for (const cp of [0xfffe, 0xffff, 0xd800, 0xdfff]) {
      expect(isXmlSafeText(`a${String.fromCharCode(cp)}`), `U+${cp.toString(16)}`).toBe(false);
    }
  });

  it("does not mistake a well-formed surrogate PAIR for a lone surrogate", () => {
    // "😀" is D83D DE00 in UTF-16 but a single legal code point U+1F600.
    expect(isXmlSafeText("😀")).toBe(true);
    expect(firstIllegalXmlChar("😀")).toBeUndefined();
  });

  it("reports the code point in a form a person can act on", () => {
    const msg = illegalXmlCharMessage("A\u0001B")!;
    expect(msg).toContain("U+0001");
    expect(msg).toContain("position 1");
    // It must not suggest the export will quietly clean it up.
    expect(msg).toMatch(/Remove the character/);
  });
});

const alignment: HorizontalAlignment = {
  beginStation: 1000,
  start: { e: 2200000, n: 1350000 },
  startAzimuthDeg: 75,
  elements: [{ type: "tangent", length: 500 }],
};
const profile: VerticalProfile = {
  pvis: [{ station: 1000, elevation: 850 }, { station: 1500, elevation: 855 }],
};
const design = (name: string) => ({
  name,
  alignment,
  profile,
  templates: { t: { name: "t", left: [{ name: "l", width: 12, slopePercent: -2 }], right: [] } },
  drops: [{ template: "t", fromStation: 1000, toStation: 1500 }],
});

describe("the gate refuses it before the design is built", () => {
  it("rejects a name carrying a control character", () => {
    expect(() => parseRoadDesign(design("A\u0001B"))).toThrow(/U\+0001/);
  });

  it("still accepts a name with legal whitespace", () => {
    expect(() => parseRoadDesign(design("A\tB"))).not.toThrow();
  });

  it("still accepts an ordinary name", () => {
    expect(() => parseRoadDesign(design("RDC-S1-SAMPLE"))).not.toThrow();
  });
});

describe("the exporter refuses it too, as a backstop", () => {
  // toLandXML is exported and can be called without passing the schema, the same
  // reason the delta bound is enforced in both the schema and the kernel.
  it("throws rather than writing a file that cannot be opened", () => {
    expect(() => toLandXML({ name: "A\u0001B", alignment, profile })).toThrow(/U\+0001/);
  });

  it("writes tab, LF and CR as character references so they round-trip", () => {
    const xml = toLandXML({ name: "A\tB\nC\rD", alignment, profile });
    expect(xml).toContain("&#9;");
    expect(xml).toContain("&#10;");
    expect(xml).toContain("&#13;");
    const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    // Written literally, an XML parser would hand back "A B C D".
    expect(doc.getElementsByTagName("Project")[0]!.getAttribute("name")).toBe("A\tB\nC\rD");
  });
});
