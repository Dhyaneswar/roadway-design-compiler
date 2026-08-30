// Typed refusals for the agent surface.
//
// The kernel and validator already fail correctly -- they throw with good
// human-readable messages. That is right for a person and useless to an agent:
// a string cannot be computed against.
//
// This module turns a failure into a STRUCTURE carrying the numbers the agent
// needs to fix it, plus the id of the tool that fixes it. It never scrapes those
// numbers out of a message: it recomputes them from the design, so the refusal
// is precise rather than parsed.
//
// A refusal is a RESULT, never an exception. Nothing here throws.

import type { RoadDesign } from "../schema/road-design";
import type { StudioForm } from "./form-to-design";
import { alignmentRangeFromForm, formToDesign } from "./form-to-design";

/** Print-rounding tolerance for station agreement, ft. Matches validate.ts. */
const STATION_TOL = 0.01;

export interface Refusal {
  readonly refused: true;
  /** Machine-stable discriminator. Agents should branch on this, not on prose. */
  readonly code: string;
  /** One sentence a human can read. */
  readonly detail: string;
  /** The numbers that make the refusal solvable. Empty only when none exist. */
  readonly measurements: Readonly<Record<string, number>>;
  /** Tool names that can resolve this refusal. */
  readonly resolvedBy: readonly string[];
  /** Where the rule comes from. */
  readonly authority: readonly string[];
}

const refusal = (
  code: string,
  detail: string,
  measurements: Record<string, number>,
  resolvedBy: readonly string[],
  authority: readonly string[] = ["RoadDesign v0.2 cross-field rules"],
): Refusal => ({ refused: true, code, detail, measurements, resolvedBy, authority });

/**
 * Classify a failed design.
 *
 * Order matters: the alignment-span rules are checked first because they are the
 * ones an agent hits constantly (any horizontal edit moves the alignment end and
 * therefore invalidates the profile), and they are the ones that carry an exactly
 * computable fix.
 */
export function classify(form: StudioForm, error: unknown): Refusal {
  const message = error instanceof Error ? error.message : String(error);

  // Can we even measure the alignment? If the horizontal itself is broken, the
  // span rules are unmeasurable and we must say so rather than guess.
  let range: { begin: number; end: number };
  try {
    range = alignmentRangeFromForm(form);
  } catch (horizontalError) {
    return refusal(
      "HorizontalAlignmentInvalid",
      `The horizontal alignment cannot be computed, so nothing downstream can be checked: ${
        horizontalError instanceof Error ? horizontalError.message : String(horizontalError)
      }`,
      { elementCount: form.elements.length },
      ["set_horizontal_element", "add_horizontal_element", "remove_horizontal_element"],
      ["RoadDesign v0.2 horizontal alignment"],
    );
  }

  const pvis = form.pvis;
  const first = pvis[0];
  const last = pvis[pvis.length - 1];

  if (pvis.length < 2) {
    return refusal(
      "ProfileNeedsTwoPvis",
      "A vertical profile needs at least two PVIs, one at each end of the alignment.",
      { pviCount: pvis.length, alignmentBeginFt: range.begin, alignmentEndFt: range.end },
      ["add_pvi"],
    );
  }

  // ---- the two span rules: the agent's most common refusal, and fully solvable
  if (first !== undefined) {
    const firstSta = Number(first.station);
    if (Number.isFinite(firstSta) && Math.abs(firstSta - range.begin) > STATION_TOL) {
      return refusal(
        "ProfileDoesNotStartAtAlignmentBegin",
        `The profile must start at the alignment begin station. Move the first PVI to ` +
          `${range.begin.toFixed(2)}.`,
        {
          alignmentBeginFt: range.begin,
          firstPviStationFt: firstSta,
          moveFirstPviByFt: range.begin - firstSta,
        },
        ["set_pvi"],
      );
    }
  }

  if (last !== undefined) {
    const lastSta = Number(last.station);
    if (Number.isFinite(lastSta) && Math.abs(lastSta - range.end) > STATION_TOL) {
      return refusal(
        "ProfileDoesNotEndAtAlignmentEnd",
        `The profile is stationed by the alignment, and the alignment now ends at ` +
          `${range.end.toFixed(2)}. Move the last PVI there.`,
        {
          alignmentEndFt: range.end,
          lastPviStationFt: lastSta,
          moveLastPviByFt: range.end - lastSta,
          alignmentLengthFt: range.end - range.begin,
        },
        ["set_pvi"],
      );
    }
  }

  if (first?.curveLength !== undefined && first.curveLength.trim() !== "") {
    return refusal(
      "EndPviCarriesVerticalCurve",
      "The first PVI cannot carry a vertical curve; there is no incoming grade to curve from.",
      { pviIndex: 0 },
      ["set_pvi"],
    );
  }
  if (last?.curveLength !== undefined && last.curveLength.trim() !== "") {
    return refusal(
      "EndPviCarriesVerticalCurve",
      "The last PVI cannot carry a vertical curve; there is no outgoing grade to curve into.",
      { pviIndex: pvis.length - 1 },
      ["set_pvi"],
    );
  }

  // ---- vertical curve overlap, measured rather than parsed
  let prevPvt = -Infinity;
  for (let i = 0; i < pvis.length; i += 1) {
    const row = pvis[i]!;
    const sta = Number(row.station);
    const L = row.curveLength === undefined || row.curveLength.trim() === ""
      ? 0
      : Number(row.curveLength);
    if (!Number.isFinite(sta) || !Number.isFinite(L)) continue;
    const pvc = sta - L / 2;
    if (pvc < prevPvt - 1e-9) {
      return refusal(
        "VerticalCurvesOverlap",
        `The vertical curve at PVI ${i + 1} begins before the previous curve ends. ` +
          `Shorten one of them, or move the PVIs apart.`,
        {
          pviIndex: i,
          pviStationFt: sta,
          curveLengthFt: L,
          pvcStationFt: pvc,
          previousPvtStationFt: prevPvt,
          overlapFt: prevPvt - pvc,
        },
        ["set_pvi"],
      );
    }
    prevPvt = sta + L / 2;
  }

  // ---- drops are stationed by the alignment too
  for (let i = 0; i < form.drops.length; i += 1) {
    const row = form.drops[i]!;
    const isLast = i === form.drops.length - 1;
    if (isLast) continue; // last boundary is derived, never authored
    const to = Number(row.toStation);
    if (Number.isFinite(to) && (to <= range.begin || to >= range.end)) {
      return refusal(
        "DropBoundaryOutsideAlignment",
        `Template drop boundary ${i + 1} must fall strictly inside the alignment range.`,
        {
          dropIndex: i,
          boundaryStationFt: to,
          alignmentBeginFt: range.begin,
          alignmentEndFt: range.end,
        },
        ["set_template_drop"],
      );
    }
  }

  // ---- nothing we model specifically: hand back the validator's own words,
  // clearly marked as unclassified so an agent does not treat it as structured.
  return refusal(
    "DesignRejected",
    message.replace(/^invalid RoadDesign:\s*/, ""),
    { alignmentBeginFt: range.begin, alignmentEndFt: range.end },
    ["what_do_i_need"],
  );
}

/**
 * Mirror the studio's own derivation: the first and last PVI stations and the
 * last drop boundary are DERIVED from the alignment, not authored. The UI does
 * this in syncDerivedPviStations/syncDropStations before every render.
 *
 * The bridge must do it too. Without it every horizontal edit an agent makes is
 * refused forever, because lengthening the road always breaks the profile span
 * that the app would have fixed for a human on the next keystroke. Mutates in
 * place; callers pass a clone.
 */
export function deriveStations(form: StudioForm): void {
  let range: { begin: number; end: number };
  try {
    range = alignmentRangeFromForm(form);
  } catch {
    return; // horizontal is broken; classify() will report that instead
  }
  if (form.pvis.length > 0) {
    form.pvis[0]!.station = String(range.begin);
    if (form.pvis.length > 1) {
      form.pvis[form.pvis.length - 1]!.station = String(range.end);
    }
  }
  if (form.drops.length > 0) {
    form.drops[form.drops.length - 1]!.toStation = String(range.end);
  }
}

/** Validate without applying. Returns the design, or a typed refusal. */
export function tryBuild(form: StudioForm): { design: RoadDesign } | Refusal {
  deriveStations(form);
  try {
    return { design: formToDesign(form) };
  } catch (error) {
    return classify(form, error);
  }
}

export const isRefusal = (v: unknown): v is Refusal =>
  typeof v === "object" && v !== null && (v as { refused?: unknown }).refused === true;
