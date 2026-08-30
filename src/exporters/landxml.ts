// LandXML 1.2 exporter — reads kernel output, writes the vendor-neutral file
// that OpenRoads Designer and Civil 3D import as native civil objects.
// LandXML point text order is "northing easting".

import { computeHorizontal } from "../kernel/horizontal";
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

export function toLandXML(input: LandXMLInput): string {
  const { name, alignment, profile, crs } = input;
  const h = computeHorizontal(alignment);

  const crsXml: string[] = crs
    ? [
        `  <CoordinateSystem desc="${crs.horizontalDatum} | vertical: ${crs.verticalDatum}` +
          `${crs.geoid ? ` (${crs.geoid})` : ""} | basis: ${crs.coordinateBasis}` +
          `${crs.combinedScaleFactor ? ` CSF ${crs.combinedScaleFactor}` : ""}" ` +
          `epsgCode="${crs.epsgCode}"/>`,
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
    profileXml.push(`    <Profile name="${name}">`, `      <ProfAlign name="${name}-profile">`);
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
    `  <Project name="${name}"/>`,
    `  <Application name="roadway-design-compiler" version="0.1.0"/>`,
    `  <Alignments>`,
    `    <Alignment name="${name}" length="${f(h.length)}" staStart="${f(alignment.beginStation)}">`,
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
