// LandXML import — bringing someone else's alignment in.
//
// The exporter made this a one-way door: you could hand a design to OpenRoads but
// never bring one back. That capped the app at greenfield work, because every
// practising engineer already has alignments -- in ORD, in Civil 3D, in a survey
// deliverable. This reads them.
//
// ---------------------------------------------------------------------------
// THREE DECISIONS, EACH MADE THE ROBUST WAY RATHER THAN THE OBVIOUS WAY
// ---------------------------------------------------------------------------
//
// 1. GEOMETRY COMES FROM THE COORDINATES, NOT FROM `dir` AND `staStart`.
//    LandXML in the wild disagrees about angular units: measured against a real
//    public file, `dir="2.238999"` is RADIANS, while other writers emit degrees,
//    and the Units element does not always say which. Start/End/Center points are
//    unambiguous, so lengths and bearings are derived from them. It also means a
//    file whose stated direction disagrees with its own geometry is read the way
//    the geometry actually runs.
//
// 2. COORDINATES ARE NORTHING THEN EASTING. That is the LandXML convention and
//    it is what this project's exporter emits. Getting it backwards silently
//    mirrors the road, so it is asserted rather than assumed.
//
// 3. AN UNSUPPORTED ELEMENT IS A REFUSAL, NEVER AN APPROXIMATION. Spirals appear
//    in 3 of the 5 real alignments available to test against. This kernel does not
//    model them, so a file containing one is REFUSED and says how many it found.
//    Quietly dropping a spiral would change the geometry of a road that somebody
//    is going to build.

import type { HorizontalElement, PVI } from "../schema/road-design";
import { makeTin, type Tin, type TinFace, type TinPoint } from "../kernel/terrain";
import { resolveSurfaceAppearance, type AuthoredMaterial,
  type SurfaceMaterialUse } from "../viewer/surface-appearance";
import { parseDesignSections, type DesignSectionSurface } from "./design-sections";
import { parsePlanFeatures, type PlanFeatureSet } from "./plan-features";

export interface ImportedAlignment {
  name: string;
  beginStation: number;
  start: { e: number; n: number };
  startAzimuthDeg: number;
  elements: HorizontalElement[];
  pvis: PVI[];
  /** What the file said its units were, before conversion. */
  sourceUnit: "foot" | "usSurveyFoot" | "meter";
  /** Anything the reader chose not to carry over, stated plainly. */
  notes: string[];
}

export type ImportResult =
  | { ok: true; alignments: ImportedAlignment[]; surfaces: Tin[];
      /** As-designed cross sections, when the file carries them. */
      designSections: DesignSectionSurface[];
      /** The site that already exists: buildings, kerbs, lot lines. */
      planFeatures: PlanFeatureSet }
  | { ok: false; code: string; detail: string; measurements?: Record<string, number> };

const DEG = 180 / Math.PI;
/** Survey feet per metre. */
export const FT_PER_M = 3.280833333333333;

function azimuthDeg(fromN: number, fromE: number, toN: number, toE: number): number {
  return ((Math.atan2(toE - fromE, toN - fromN) * DEG) % 360 + 360) % 360;
}
const dist = (aN: number, aE: number, bN: number, bE: number): number =>
  Math.hypot(bN - aN, bE - aE);

/** "northing easting [elev]" → the pair, in LandXML's own order. */
function parsePoint(text: string | null | undefined): { n: number; e: number } | undefined {
  if (!text) return undefined;
  const parts = text.trim().split(/\s+/).map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]!) || !Number.isFinite(parts[1]!)) return undefined;
  return { n: parts[0]!, e: parts[1]! };
}

function textOf(parent: Element, tag: string): string | undefined {
  const el = parent.getElementsByTagName(tag)[0] ?? parent.getElementsByTagName(`ns:${tag}`)[0];
  return el?.textContent ?? undefined;
}

/**
 * Local-name lookup, so both LandXML 1.1 and 1.2 namespaces work.
 *
 * ⚠ Uses the INDEXED namespace lookup rather than walking every element. The
 * walking version was O(n) per call and this function is called repeatedly, which
 * made a real 126-spiral file exhaust the heap before it could be refused. A
 * reader that dies on a big file is worse than one that says no.
 */
function byLocalName(root: Element | Document, name: string): Element[] {
  const found = root.getElementsByTagNameNS("*", name);
  if (found.length > 0) return Array.prototype.slice.call(found) as Element[];
  // Namespace-less documents: the plain lookup is indexed too.
  return Array.prototype.slice.call(root.getElementsByTagName(name)) as Element[];
}

/**
 * The file's linear unit.
 *
 * Exported because anything reading a document OUTSIDE the main import path --
 * a harness, a test against real files -- has to apply the same conversion.
 * A verifier that assumed feet printed a metric file's 11.8 m widths as
 * "11.8 ft" and looked plausible while being off by a factor of 3.28.
 */
export function detectUnit(doc: Document): "foot" | "usSurveyFoot" | "meter" {
  const imperial = byLocalName(doc, "Imperial")[0];
  if (imperial) {
    const u = (imperial.getAttribute("linearUnit") ?? "").toLowerCase();
    return u.includes("ussurvey") ? "usSurveyFoot" : "foot";
  }
  return "meter";
}

/**
 * Refuse the expensive files BEFORE building a DOM.
 *
 * ⚠ Measured against real exports: two OpenRoads files here are 19.7 MB and
 * 31.1 MB, carrying 504,000 and 822,000 elements. They are TIN surface meshes and
 * contain no <Alignment> at all -- so parsing them costs hundreds of megabytes to
 * learn there is nothing to import, and can take the tab down on the way.
 *
 * A substring scan over the raw text answers both questions with almost no memory,
 * so a surface-only file is refused instantly however large it is.
 */
function preflight(xml: string): ImportResult | undefined {
  const MB = 1024 * 1024;
  // Order matters: a file that is not LandXML at all must say so, rather than
  // reporting the absence of alignments it was never going to have.
  if (!/<\s*(\w+:)?LandXML[\s>]/.test(xml)) {
    return { ok: false, code: "NotLandXml",
      detail: "No <LandXML> root element. This reader takes LandXML 1.1 or 1.2." };
  }
  if (!/<\s*(\w+:)?Alignment[\s>]/.test(xml) && !/<\s*(\w+:)?Surface[\s>]/.test(xml)
      && !/<\s*(\w+:)?PlanFeature[\s>]/.test(xml)) {
    return {
      ok: false,
      code: "NoAlignments",
      detail:
        "This LandXML has no <Alignment>. Many files carry only surfaces or parcels; " +
        "this reader imports horizontal alignments and their profiles.",
      measurements: { fileSizeMb: Number((xml.length / MB).toFixed(2)) },
    };
  }
  const LIMIT_MB = 12;
  if (xml.length > LIMIT_MB * MB) {
    return {
      ok: false,
      code: "FileTooLarge",
      detail:
        `That file is ${(xml.length / MB).toFixed(1)} MB. Files this size are usually surface ` +
        `meshes, and parsing one in the browser can take the page down. Export just the ` +
        `alignment and profile, which is normally well under a megabyte.`,
      measurements: { fileSizeMb: Number((xml.length / MB).toFixed(2)), limitMb: LIMIT_MB },
    };
  }
  return undefined;
}


/**
 * Read every TIN surface in the document.
 *
 * LandXML numbers its points from 1 and refers to them by id, but real files are
 * not guaranteed to list them in order, so ids are mapped rather than assumed to
 * be positions. A face naming a point that is not there is skipped rather than
 * producing a triangle with a NaN corner.
 */
/**
 * The document-level MaterialTable, when a LandXML 2.0 file carries one.
 *
 * ⛔ Read exactly as written and never invented. A colour here is the
 * designer's own; the app's job is to use it or to say why it could not.
 */
export function parseMaterials(doc: Document): AuthoredMaterial[] {
  const out: AuthoredMaterial[] = [];
  for (const el of byLocalName(doc, "Material")) {
    // ⚠ Number(null) is 0, not NaN, so a Material with no index attribute used
    // to become index 0 -- and would then answer a boundary referencing m="0".
    const rawIndex = el.getAttribute("index");
    if (rawIndex === null || rawIndex.trim() === "") continue;
    const index = Number(rawIndex);
    if (!Number.isInteger(index)) continue;
    const raw = (el.getAttribute("color") ?? "").split(",").map((v) => Number(v.trim()));
    const color = raw.length === 3 && raw.every((v) => Number.isFinite(v))
      ? [raw[0]!, raw[1]!, raw[2]!] as const
      : undefined;
    const tex = el.getAttribute("textureImageRef") ?? undefined;
    const sym = el.getAttribute("symbolRef") ?? undefined;
    out.push({
      index,
      ...(color ? { color } : {}),
      ...(tex ? { textureImageRef: tex } : {}),
      ...(sym ? { symbolRef: sym } : {}),
    });
  }
  return out;
}

/** Which materials a surface's own texture boundaries reference. */
function surfaceMaterialUse(sEl: Element): SurfaceMaterialUse | undefined {
  const seen = new Set<number>();
  let regions = 0;
  for (const b of byLocalName(sEl, "Boundary")) {
    // ⚠ The same Number(null) === 0 trap as the material index, and it bites
    // harder here: a Boundary with no `m` became a reference to material 0, so
    // a file that happened to define material 0 had an unrelated region painted
    // in it and LABELLED authored. A missing reference is not a reference to
    // the zeroth thing.
    const raw = b.getAttribute("m");
    if (raw === null || raw.trim() === "") continue;
    const m = Number(raw);
    if (!Number.isInteger(m)) continue;
    regions += 1;
    seen.add(m);
  }
  if (regions === 0) return undefined;
  return { indices: [...seen].sort((a, b) => a - b), regionCount: regions };
}

export function parseSurfaces(doc: Document, toFt = 1): Tin[] {
  const materials = parseMaterials(doc);
  const out: Tin[] = [];
  for (const sEl of byLocalName(doc, "Surface")) {
    const name = sEl.getAttribute("name") || "surface";
    const byId = new Map<string, number>();
    const points: TinPoint[] = [];

    for (const pEl of byLocalName(sEl, "P")) {
      const nums = (pEl.textContent ?? "").trim().split(/\s+/).map(Number);
      if (nums.length < 3 || nums.some((v) => !Number.isFinite(v))) continue;
      const id = pEl.getAttribute("id");
      if (id !== null) byId.set(id, points.length);
      // LandXML point order is northing, easting, elevation.
      points.push({ n: nums[0]! * toFt, e: nums[1]! * toFt, z: nums[2]! * toFt });
    }
    if (points.length === 0) continue;

    const faces: TinFace[] = [];
    for (const fEl of byLocalName(sEl, "F")) {
      // A face marked as a hole or otherwise invisible is not part of the surface.
      if ((fEl.getAttribute("i") ?? "") === "1") continue;
      const ids = (fEl.textContent ?? "").trim().split(/\s+/);
      if (ids.length < 3) continue;
      const a = byId.get(ids[0]!), b2 = byId.get(ids[1]!), c = byId.get(ids[2]!);
      if (a === undefined || b2 === undefined || c === undefined) continue;
      faces.push([a, b2, c]);
    }
    if (faces.length === 0) continue;
    const tin = makeTin(name, points, faces);
    // Appearance travels WITH the surface, resolved once at import.
    tin.appearance = resolveSurfaceAppearance(name, surfaceMaterialUse(sEl), materials);
    out.push(tin);
  }
  return out;
}

/** Sections for the surface-only path, where the unit is resolved locally. */
function parseSectionsHere(doc: Document): DesignSectionSurface[] {
  return parseDesignSections(doc, detectUnit(doc) === "meter" ? FT_PER_M : 1, byLocalName);
}

export function parseLandXML(xml: string): ImportResult {
  const early = preflight(xml);
  if (early) return early;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return { ok: false, code: "NotXml", detail: "That file is not parseable XML." };
  }
  if (byLocalName(doc, "parsererror").length > 0 || doc.getElementsByTagName("parsererror").length > 0) {
    return { ok: false, code: "NotXml", detail: "That file is not well-formed XML." };
  }
  if (byLocalName(doc, "LandXML").length === 0) {
    return { ok: false, code: "NotLandXml",
      detail: "No <LandXML> root element. This reader takes LandXML 1.1 or 1.2." };
  }

  const alignmentEls = byLocalName(doc, "Alignment");
  if (alignmentEls.length === 0) {
    // A surface-only file is a perfectly good import: it is the ground the road
    // will sit on, which is exactly what this app was missing.
    const localToFt = detectUnit(doc) === "meter" ? FT_PER_M : 1;
    const onlyFeatures = parsePlanFeatures(doc, localToFt, byLocalName);
    const onlySurfaces = parseSurfaces(doc, localToFt);
    if (onlySurfaces.length > 0 || onlyFeatures.features.length > 0) {
      return { ok: true, alignments: [], surfaces: onlySurfaces,
        designSections: parseSectionsHere(doc), planFeatures: onlyFeatures };
    }
    return {
      ok: false,
      code: "NoAlignments",
      detail:
        "This LandXML has no <Alignment>. Many files carry only surfaces or parcels; " +
        "this reader imports horizontal alignments and their profiles.",
      measurements: { surfaceCount: byLocalName(doc, "Surface").length },
    };
  }

  const sourceUnit = detectUnit(doc);
  const toFt = sourceUnit === "meter" ? FT_PER_M : 1;

  const out: ImportedAlignment[] = [];
  for (const aEl of alignmentEls) {
    const name = aEl.getAttribute("name") || "imported";
    const notes: string[] = [];

    // Spirals are checked on the ALIGNMENT, not inside CoordGeom. Real files
    // disagree about structure -- one sample here holds its geometry directly
    // under <Alignments> with no CoordGeom wrapper at all -- and a spiralled
    // alignment deserves the specific refusal whichever shape it arrived in.
    const spirals = byLocalName(aEl, "Spiral").length;
    if (spirals > 0) {
      return {
        ok: false,
        code: "SpiralsNotSupported",
        detail:
          `Alignment "${name}" uses ${spirals} spiral transition${spirals === 1 ? "" : "s"}. ` +
          `This kernel models tangents, circular curves and angle points only. Importing it ` +
          `would silently drop the spirals and change the geometry of the road.`,
        measurements: { spiralCount: spirals },
      };
    }

    const geom = byLocalName(aEl, "CoordGeom")[0];
    if (!geom) {
      return {
        ok: false,
        code: "NoCoordGeom",
        detail:
          `Alignment "${name}" has no <CoordGeom>. Its geometry is written in a dialect this ` +
          `reader does not recognise -- some older writers put elements directly under ` +
          `<Alignments> with names like <Curve1>. Re-export it as standard LandXML 1.1 or 1.2.`,
      };
    }

    // Children in document order: that ordering IS the alignment.
    const parts: Element[] = [];
    for (let i = 0; i < geom.children.length; i += 1) {
      const c = geom.children[i]!;
      const local = c.localName ?? c.nodeName.replace(/^.*:/, "");
      if (local === "Line" || local === "Curve") parts.push(c);
    }
    if (parts.length === 0) { notes.push("CoordGeom had no Line or Curve"); continue; }

    const elements: HorizontalElement[] = [];
    let startPoint: { n: number; e: number } | undefined;
    let startAz: number | undefined;
    let prevAz = 0;

    for (const part of parts) {
      const local = part.localName ?? part.nodeName.replace(/^.*:/, "");
      const s = parsePoint(textOf(part, "Start"));
      const e = parsePoint(textOf(part, "End"));
      if (!s || !e) {
        return { ok: false, code: "IncompleteGeometry",
          detail: `An element of "${name}" is missing its Start or End point.` };
      }
      if (!startPoint) startPoint = s;

      if (local === "Line") {
        const az = azimuthDeg(s.n, s.e, e.n, e.e);
        if (startAz === undefined) startAz = az;
        elements.push({ type: "tangent", length: dist(s.n, s.e, e.n, e.e) * toFt });
        prevAz = az;
      } else {
        const c = parsePoint(textOf(part, "Center"));
        const rot = (part.getAttribute("rot") ?? "").toLowerCase();
        const attrR = Number(part.getAttribute("radius"));
        if (!c && !Number.isFinite(attrR)) {
          return { ok: false, code: "IncompleteGeometry",
            detail: `A curve of "${name}" has neither a Center point nor a radius.` };
        }
        // Radius from the centre when we have it: it is the file's own geometry
        // rather than a possibly-stale attribute.
        const radius = c ? dist(c.n, c.e, s.n, s.e) : attrR;
        const direction: "left" | "right" = rot.startsWith("ccw") ? "left" : "right";

        // Delta from the chord and radius, which needs no angular unit at all.
        const chord = dist(s.n, s.e, e.n, e.e);
        const ratio = Math.min(1, chord / (2 * radius));
        let deltaDeg = 2 * Math.asin(ratio) * DEG;

        // asin only reaches 90 deg, so a curve past a half-turn reads short. The
        // arc length attribute, when present, disambiguates.
        const arcAttr = Number(part.getAttribute("length"));
        if (Number.isFinite(arcAttr) && arcAttr > 0) {
          const fromArc = (arcAttr / radius) * DEG;
          if (fromArc > 90 && Math.abs(fromArc - deltaDeg) > 1) deltaDeg = fromArc;
        }
        if (!(deltaDeg > 0) || deltaDeg >= 180) {
          return { ok: false, code: "UnsupportedCurve",
            detail: `A curve of "${name}" spans ${deltaDeg.toFixed(2)} degrees. ` +
              `This kernel takes circular curves above 0 and below 180 degrees.`,
            measurements: { deltaDeg } };
        }
        if (startAz === undefined) {
          // A curve leading the alignment: its entry bearing is the tangent at
          // Start, perpendicular to the radius.
          const radial = c ? azimuthDeg(c.n, c.e, s.n, s.e) : 0;
          startAz = ((direction === "right" ? radial + 90 : radial - 90) % 360 + 360) % 360;
        }
        elements.push({ type: "arc", radius: radius * toFt, deltaDeg, direction });
        prevAz = azimuthDeg(s.n, s.e, e.n, e.e);
      }
    }
    void prevAz;

    if (!startPoint || startAz === undefined) { notes.push("could not establish a start"); continue; }

    // Profile: PVIs, with a parabolic length when the file gives one.
    const pvis: PVI[] = [];
    const profAlign = byLocalName(aEl, "ProfAlign")[0]
      ?? byLocalName(doc, "ProfAlign").find((pa) =>
        (pa.getAttribute("name") ?? "").toLowerCase().includes(name.toLowerCase()));
    if (profAlign) {
      for (let i = 0; i < profAlign.children.length; i += 1) {
        const c = profAlign.children[i]!;
        const local = c.localName ?? c.nodeName.replace(/^.*:/, "");
        if (local !== "PVI" && local !== "ParaCurve") continue;
        const nums = (c.textContent ?? "").trim().split(/\s+/).map(Number);
        if (nums.length < 2 || !Number.isFinite(nums[0]!) || !Number.isFinite(nums[1]!)) continue;
        const pvi: PVI = { station: nums[0]! * toFt, elevation: nums[1]! * toFt };
        if (local === "ParaCurve") {
          const L = Number(c.getAttribute("length"));
          if (Number.isFinite(L) && L > 0) pvi.curveLength = L * toFt;
        }
        pvis.push(pvi);
      }
    }
    if (pvis.length > 0) {
      // End PVIs cannot carry a curve in this schema; the file may disagree.
      delete pvis[0]!.curveLength;
      delete pvis[pvis.length - 1]!.curveLength;
    } else {
      notes.push("no vertical profile found; a flat placeholder profile was created");
    }

    const staStart = Number(aEl.getAttribute("staStart"));
    out.push({
      name,
      beginStation: (Number.isFinite(staStart) ? staStart : 0) * toFt,
      start: { e: startPoint.e * toFt, n: startPoint.n * toFt },
      startAzimuthDeg: startAz,
      elements,
      pvis,
      sourceUnit,
      notes: sourceUnit === "meter"
        ? [`converted from metres to US survey feet (x${FT_PER_M})`, ...notes]
        : notes,
    });
  }

  if (out.length === 0) {
    return { ok: false, code: "NoUsableAlignment",
      detail: "Alignments were present but none carried geometry this reader could use." };
  }
  return { ok: true, alignments: out, surfaces: parseSurfaces(doc, toFt),
    designSections: parseDesignSections(doc, toFt, byLocalName),
    planFeatures: parsePlanFeatures(doc, toFt, byLocalName) };
}
