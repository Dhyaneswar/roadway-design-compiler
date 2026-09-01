// LandXML 1.2 exporter — reads kernel output, writes the vendor-neutral file
// that OpenRoads Designer and Civil 3D import as native civil objects.
// LandXML point text order is "northing easting".

import { computeHorizontal } from "../kernel/horizontal";
import { firstIllegalXmlChar, illegalXmlCharMessage } from "../schema/xml-text";
import type {
  HorizontalAlignment,
  PointEN,
  ProjectCrs,
  VerticalProfile,
} from "../schema/road-design";

export interface LandXMLInput {
  name: string;
  alignment: HorizontalAlignment;
  profile?: VerticalProfile;
  crs?: ProjectCrs;
}

const f = (x: number) => x.toFixed(6);
const pt = (p: PointEN) => `${f(p.n)} ${f(p.e)}`;

/**
 * ⛔ EVERY authored string that reaches an XML attribute goes through this.
 *
 * The schema accepts any non-empty name, and a name that arrived by import has
 * already had its entities DECODED -- so `A & B "quoted" <road>` was written
 * straight into four attributes and the file failed to parse at all. An export
 * that cannot be opened is worse than a refused export: the engineer finds out
 * in the CAD package, not here.
 *
 * ⚠ Not cosmetic. `name="` closes the attribute and `<` opens a tag, so an
 * authored name could forge structure in a file another party opens. Escaping
 * at the SINK rather than at the schema is deliberate: names are legitimately
 * allowed to contain these characters, and every future sink gets it for free.
 *
 * `&` must be first or it would re-escape the ampersands the others introduce.
 */
const xa = (s: string): string => {
  const text = String(s);
  /**
   * ⛔ Escaping is not enough: some characters XML 1.0 simply cannot carry.
   *
   * F034. `AB` passed the escaper untouched and produced an export that
   * reported success and that Chrome's own parser then rejected. There is no
   * escape to reach for -- `&#1;` is itself illegal in XML 1.0 -- so the choice
   * is refuse or silently alter the author's text, and altering a road name is
   * not ours to do. The schema refuses this first; this throw is the backstop
   * for toLandXML being called directly, the same way the delta bound is
   * enforced in both the schema and the kernel.
   */
  const bad = firstIllegalXmlChar(text);
  if (bad) throw new Error(illegalXmlCharMessage(text)!);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // ⚠ Tab, LF and CR are legal characters but an XML parser NORMALISES each to
    // a space inside an attribute value. Written literally they would come back
    // altered; written as character references they come back exactly.
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
};

export function toLandXML(input: LandXMLInput): string {
  const { name, alignment, profile, crs } = input;
  const h = computeHorizontal(alignment);

  const crsXml: string[] = crs
    ? [
        `  <CoordinateSystem desc="${xa(crs.horizontalDatum)} | vertical: ${xa(crs.verticalDatum)}` +
          `${crs.geoid ? ` (${xa(crs.geoid)})` : ""} | basis: ${xa(crs.coordinateBasis)}` +
          `${crs.combinedScaleFactor ? ` CSF ${crs.combinedScaleFactor}` : ""}" ` +
          `epsgCode="${xa(String(crs.epsgCode))}"/>`,
      ]
    : [];

  const geom: string[] = [];
  for (let i = 0; i < alignment.elements.length; i++) {
    const el = alignment.elements[i]!;
    const rep = h.elements[i]!;
    // Angle points carry no geometry of their own — the adjacent Lines'
    // differing bearings express the deflection in LandXML.
    if (el.type === "deflection") continue;
    const beginDist = rep.beginStation - alignment.beginStation;
    const endDist = rep.endStation - alignment.beginStation;
    const begin = h.pointAt(beginDist);
    const end = h.pointAt(endDist);
    if (el.type === "tangent") {
      geom.push(
        `      <Line dir="${f(rep.beginAzimuthDeg)}" length="${f(el.length)}">`,
        `        <Start>${pt(begin)}</Start>`,
        `        <End>${pt(end)}</End>`,
        `      </Line>`,
      );
    } else {
      const rot = el.direction === "right" ? "cw" : "ccw";
      const sign = el.direction === "right" ? 1 : -1;
      const azToCenter = (rep.beginAzimuthDeg + sign * 90) * (Math.PI / 180);
      const center: PointEN = {
        e: begin.e + el.radius * Math.sin(azToCenter),
        n: begin.n + el.radius * Math.cos(azToCenter),
      };
      // PI sits a tangent-distance ahead of the PC along the incoming heading.
      const azIn = rep.beginAzimuthDeg * (Math.PI / 180);
      const piPoint: PointEN = {
        e: begin.e + rep.curve!.tangentDistance * Math.sin(azIn),
        n: begin.n + rep.curve!.tangentDistance * Math.cos(azIn),
      };
      const dirEnd = rep.beginAzimuthDeg + sign * el.deltaDeg;
      geom.push(
        `      <Curve rot="${rot}" crvType="arc" radius="${f(el.radius)}" length="${f(rep.curve!.length)}" ` +
          `chord="${f(rep.curve!.chord)}" delta="${f(el.deltaDeg)}" ` +
          `dirStart="${f(rep.beginAzimuthDeg)}" dirEnd="${f(dirEnd)}" ` +
          `tangent="${f(rep.curve!.tangentDistance)}" external="${f(rep.curve!.external)}" ` +
          `midOrd="${f(rep.curve!.middleOrdinate)}">`,
        `        <Start>${pt(begin)}</Start>`,
        `        <Center>${pt(center)}</Center>`,
        `        <End>${pt(end)}</End>`,
        `        <PI>${pt(piPoint)}</PI>`,
        `      </Curve>`,
      );
    }
  }

  const profileXml: string[] = [];
  if (profile) {
    profileXml.push(`    <Profile name="${xa(name)}">`, `      <ProfAlign name="${xa(name)}-profile">`);
    for (const pvi of profile.pvis) {
      if (pvi.curveLength && pvi.curveLength > 0) {
        profileXml.push(
          `        <ParaCurve length="${f(pvi.curveLength)}">${f(pvi.station)} ${f(pvi.elevation)}</ParaCurve>`,
        );
      } else {
        profileXml.push(`        <PVI>${f(pvi.station)} ${f(pvi.elevation)}</PVI>`);
      }
    }
    profileXml.push(`      </ProfAlign>`, `    </Profile>`);
  }

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 ` +
      `http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" ` +
      `version="1.2" date="${date}" time="${time}">`,
    `  <Units>`,
    `    <Imperial areaUnit="squareFoot" linearUnit="USSurveyFoot" volumeUnit="cubicFeet" ` +
      `temperatureUnit="fahrenheit" pressureUnit="inchHG" ` +
      `angularUnit="decimal degrees" directionUnit="decimal degrees"/>`,
    `  </Units>`,
    ...crsXml,
    `  <Project name="${xa(name)}"/>`,
    `  <Application name="roadway-design-compiler" version="0.1.0"/>`,
    `  <Alignments>`,
    `    <Alignment name="${xa(name)}" length="${f(h.length)}" staStart="${f(alignment.beginStation)}">`,
    `      <CoordGeom>`,
    ...geom.map((l) => "  " + l),
    `      </CoordGeom>`,
    ...profileXml,
    `    </Alignment>`,
    `  </Alignments>`,
    `</LandXML>`,
    ``,
  ].join("\n");
}
