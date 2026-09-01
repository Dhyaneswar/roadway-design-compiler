// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { toLandXML } from "../src/exporters/landxml";
import type { HorizontalAlignment, VerticalProfile, ProjectCrs } from "../src/schema/road-design";

/**
 * An authored name must not be able to break the file it is written into.
 *
 * F030. The schema accepts any non-empty name and the exporter interpolated it
 * straight into four XML attributes -- Project, Alignment, Profile, ProfAlign.
 * `A & B "quoted" <road>` produced a document that no XML parser would open:
 * the quote closed the attribute and the angle bracket opened a tag.
 *
 * ⚠ An export that cannot be parsed is worse than a refused export. The engineer
 * discovers it in Civil 3D or ORD, after the handoff, with no clue which of the
 * characters in their project name did it.
 *
 * Names arriving by IMPORT have already had their entities decoded, so this is
 * reachable without anybody typing an angle bracket on purpose.
 */

const NASTY = 'A & B "quoted" <road>';

const alignment: HorizontalAlignment = {
  beginStation: 1000,
  start: { e: 2200000, n: 1350000 },
  startAzimuthDeg: 75,
  elements: [
    { type: "tangent", length: 500 },
    { type: "arc", radius: 1500, deltaDeg: 30, direction: "right" },
    { type: "tangent", length: 400 },
  ],
};
const profile: VerticalProfile = {
  pvis: [
    { station: 1000, elevation: 850 },
    { station: 1500, elevation: 860, curveLength: 300 },
    { station: 2685.4, elevation: 845 },
  ],
};

const parse = (xml: string): Document =>
  new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;

/**
 * ⚠ getElementsByTagName, not getElementsByTagNameNS("*", ...). Happy DOM
 * returns nothing for the namespace-wildcard form on a default-namespaced XML
 * document, which is the same limitation the design-section reader carries a
 * byLocalName injection point for. Using it here would make every assertion
 * below pass vacuously against a null.
 */
const el = (doc: Document, tag: string): Element => {
  const found = doc.getElementsByTagName(tag);
  expect(found.length, `<${tag}> present`).toBeGreaterThan(0);
  return found[0] as unknown as Element;
};
const attr = (doc: Document, tag: string): string | null => el(doc, tag).getAttribute("name");

describe("an authored name survives export as text, not as markup", () => {
  const xml = toLandXML({ name: NASTY, alignment, profile });
  const doc = parse(xml);

  it("produces a document an XML parser will open", () => {
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    expect(doc.documentElement?.nodeName).toBe("LandXML");
  });

  it("escapes rather than drops the characters", () => {
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
    expect(xml).toContain("&lt;road&gt;");
    // The raw form must not survive anywhere in the file.
    expect(xml).not.toContain('"quoted"');
    expect(xml).not.toContain("<road>");
  });

  it("round-trips the exact authored text through all four sinks", () => {
    expect(attr(doc, "Project")).toBe(NASTY);
    expect(attr(doc, "Alignment")).toBe(NASTY);
    expect(attr(doc, "Profile")).toBe(NASTY);
    expect(attr(doc, "ProfAlign")).toBe(`${NASTY}-profile`);
  });

  it("does not let a name forge structure", () => {
    // The classic shape: close the attribute, close the tag, add your own.
    const forged = toLandXML({
      name: '"/><Alignment name="INJECTED',
      alignment, profile,
    });
    const d = parse(forged);
    expect(d.getElementsByTagName("parsererror").length).toBe(0);
    // Exactly the one alignment we authored, not two.
    expect(d.getElementsByTagName("Alignment").length).toBe(1);
    expect(attr(d, "Alignment")).toBe('"/><Alignment name="INJECTED');
  });
});

describe("the coordinate system block is escaped too", () => {
  it("keeps a datum containing markup as text", () => {
    const crs = {
      epsgCode: 2240,
      horizontalDatum: 'NAD83 & "Georgia West"',
      verticalDatum: "NAVD88 <ft>",
      geoid: "GEOID18 & co",
      coordinateBasis: "grid",
    } as unknown as ProjectCrs;
    const doc = parse(toLandXML({ name: "plain", alignment, profile, crs }));
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
    const cs = el(doc, "CoordinateSystem");
    expect(cs.getAttribute("desc")).toContain('NAD83 & "Georgia West"');
    expect(cs.getAttribute("desc")).toContain("NAVD88 <ft>");
  });
});

describe("ordinary names are untouched", () => {
  it("does not escape what needs no escaping", () => {
    const xml = toLandXML({ name: "RDC-S1-SAMPLE", alignment, profile });
    expect(xml).toContain('<Project name="RDC-S1-SAMPLE"/>');
    expect(xml).not.toContain("&amp;");
  });
});
