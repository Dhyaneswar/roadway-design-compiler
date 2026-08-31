// Maps studio form state (strings from inputs) to a validated RoadDesign.
// All numeric parsing and field-specific error messages live here so the DOM
// layer stays logic-free.

import { parseRoadDesign } from "../schema/validate";
import { computeHorizontal } from "../kernel/horizontal";
import type { HorizontalElement, RoadDesign, SegmentMaterial, SuperelevationSpec } from "../schema/road-design";
import type { RoadsideItem } from "../schema/roadside";

export interface FormElementRow {
  kind: "tangent" | "arc" | "deflection";
  length?: string;
  radius?: string;
  deltaDeg?: string;
  deflectionDeg?: string;
  direction?: "left" | "right";
}

export interface FormPviRow {
  station: string;
  elevation: string;
  curveLength?: string;
}

export interface FormSegmentRow {
  name: string;
  width: string;
  slopePercent: string;
  /** Authored material. Absent means unstated, which is drawn neutrally. */
  material?: SegmentMaterial;
}

export interface FormTemplateRow {
  name: string;
  left: FormSegmentRow[];
  right: FormSegmentRow[];
}

/** Boundary model: drop row i runs from the previous row's boundary (or the
 *  begin station) to its own toStation. The LAST row's toStation is derived
 *  (alignment end) — coverage is contiguous by construction. */
export interface FormDropRow {
  template: string;
  toStation: string;
  /** Taper length, ft — blend from the previous drop's template (optional) */
  transition?: string;
}

export interface StudioForm {
  name: string;
  beginStation: number;
  startE: number;
  startN: number;
  startAzimuthDeg: number;
  elements: FormElementRow[];
  pvis: FormPviRow[];
  templates: FormTemplateRow[];
  drops: FormDropRow[];
  /** Optional banking policy. Absent = template cross slopes everywhere. */
  superelevation?: SuperelevationSpec;
  /** Authored roadside furniture. */
  roadside?: RoadsideItem[];
}

function num(raw: string | undefined, label: string): number {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${label} is required`);
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${label} must be a number (got "${raw}")`);
  return v;
}

function mapElements(rows: FormElementRow[]): HorizontalElement[] {
  return rows.map((row, i) => {
    const label = `element ${i + 1}`;
    if (row.kind === "tangent") {
      return { type: "tangent" as const, length: num(row.length, `${label} length`) };
    }
    if (row.kind === "arc") {
      return {
        type: "arc" as const,
        radius: num(row.radius, `${label} radius`),
        deltaDeg: num(row.deltaDeg, `${label} delta`),
        direction: row.direction ?? "right",
      };
    }
    return {
      type: "deflection" as const,
      deflectionDeg: num(row.deflectionDeg, `${label} deflection`),
      direction: row.direction ?? "left",
    };
  });
}

/** Station range the horizontal alignment determines — the profile and the
 *  template drops are stationed BY this range, never independently. */
export function alignmentRangeFromForm(form: StudioForm): { begin: number; end: number } {
  const h = computeHorizontal({
    beginStation: form.beginStation,
    start: { e: form.startE, n: form.startN },
    startAzimuthDeg: form.startAzimuthDeg,
    elements: mapElements(form.elements),
  });
  return { begin: form.beginStation, end: form.beginStation + h.length };
}

export function formToDesign(form: StudioForm): RoadDesign {
  const elements = mapElements(form.elements);

  const pvis = form.pvis.map((row, i) => {
    const label = `PVI ${i + 1}`;
    const pvi: { station: number; elevation: number; curveLength?: number } = {
      station: num(row.station, `${label} station`),
      elevation: num(row.elevation, `${label} elevation`),
    };
    if (row.curveLength !== undefined && row.curveLength.trim() !== "") {
      pvi.curveLength = num(row.curveLength, `${label} curve length`);
    }
    return pvi;
  });

  // Templates: editor rows → record keyed by name (names must be unique).
  if (form.templates.length === 0) throw new Error("at least one template is required");
  const templates: Record<string, unknown> = {};
  form.templates.forEach((t, ti) => {
    const tLabel = `template ${ti + 1}`;
    const name = t.name.trim();
    if (!name) throw new Error(`${tLabel} name is required`);
    if (name in templates) throw new Error(`template name "${name}" is used twice`);
    const mapSide = (side: "left" | "right") =>
      t[side].map((s, si) => ({
        name: s.name.trim() || `seg${si + 1}`,
        width: num(s.width, `${tLabel} ${side} segment ${si + 1} width`),
        slopePercent: num(s.slopePercent, `${tLabel} ${side} segment ${si + 1} slope`),
        ...(s.material ? { material: s.material } : {}),
      }));
    templates[name] = { name, left: mapSide("left"), right: mapSide("right") };
  });

  // Drops are stationed by the alignment: boundaries between rows are the
  // only typed stations; first from = begin, last to = end (derived).
  const range = alignmentRangeFromForm(form);
  if (form.drops.length === 0) throw new Error("at least one template drop is required");
  const drops: {
    template: string;
    fromStation: number;
    toStation: number;
    transitionLength?: number;
  }[] = [];
  let cursor = range.begin;
  form.drops.forEach((row, di) => {
    const isLast = di === form.drops.length - 1;
    const to = isLast ? range.end : num(row.toStation, `drop ${di + 1} boundary station`);
    if (!isLast && (to <= cursor || to >= range.end)) {
      throw new Error(
        `drop ${di + 1} boundary must lie between ${cursor.toFixed(2)} ` +
          `and the alignment end ${range.end.toFixed(2)} (got ${to})`,
      );
    }
    const d: (typeof drops)[number] = { template: row.template, fromStation: cursor, toStation: to };
    if (row.transition !== undefined && row.transition.trim() !== "") {
      d.transitionLength = num(row.transition, `drop ${di + 1} taper length`);
    }
    drops.push(d);
    cursor = to;
  });

  return parseRoadDesign({
    ...(form.superelevation ? { superelevation: form.superelevation } : {}),
    ...(form.roadside && form.roadside.length > 0 ? { roadside: form.roadside } : {}),
    name: form.name || "Unnamed Road",
    alignment: {
      beginStation: form.beginStation,
      start: { e: form.startE, n: form.startN },
      startAzimuthDeg: form.startAzimuthDeg,
      elements,
    },
    profile: { pvis },
    templates,
    drops,
  });
}
