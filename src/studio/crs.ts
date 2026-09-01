// The project coordinate reference system, as a value.
//
// This used to live inside studio/main.ts, derived on demand from two <select>
// elements. That put it OUTSIDE StudioForm, and therefore outside the undo
// snapshot, outside the agent change ledger and outside the portable design
// document -- which is why a CRS change could not be undone and did not travel
// with a design that was shared or saved. Independent QA raised all three as
// F004. The CRS is project data, so it lives with the rest of the project data.

import type { ProjectCrs } from "../schema/road-design";

/** What the engineer selected. The full ProjectCrs is derived from this. */
export interface CrsSelection {
  /** Zone key, or "" / undefined for local coordinates. */
  zone: string;
  basis: "grid" | "ground";
  /**
   * Required when basis is "ground": ground distances are grid distances
   * divided by this. The schema refuses a ground CRS without it, because
   * "ground coordinates" with no stated scale factor cannot be reconciled with
   * anything a survey crew measures.
   */
  combinedScaleFactor?: number;
}

export interface CrsZone {
  value: string;
  label: string;
  epsgCode: number;
  horizontalDatum: string;
}

/**
 * The zones this project offers.
 *
 * Deliberately a short, explicit list rather than a projection database: these
 * are the two zones the corpus uses, and inventing a general CRS engine would
 * be claiming a capability that has not been tested against real exports.
 */
export const CRS_ZONES: readonly CrsZone[] = [
  {
    value: "GA-West",
    label: "Georgia West — NAD83 ftUS (EPSG:2240)",
    epsgCode: 2240,
    horizontalDatum: "NAD83 / Georgia Coordinate System of 1985, West Zone",
  },
  {
    value: "GA-East",
    label: "Georgia East — NAD83 ftUS (EPSG:2239)",
    epsgCode: 2239,
    horizontalDatum: "NAD83 / Georgia Coordinate System of 1985, East Zone",
  },
];

export const VERTICAL_DATUM = "NAVD88";

export function isKnownZone(zone: string | undefined): boolean {
  return CRS_ZONES.some((z) => z.value === zone);
}

/**
 * Build the full ProjectCrs from a selection, or undefined for local coordinates.
 *
 * ⚠ Returns undefined for an UNKNOWN zone rather than falling back to a default.
 * The previous derivation was `zone === "GA-East" ? east : west`, so any value
 * that was not GA-East -- including a typo or a zone from another state --
 * silently produced Georgia West, and the LandXML would have georeferenced a
 * road into the wrong part of the world without saying so.
 */
export function projectCrsFor(sel: CrsSelection | undefined): ProjectCrs | undefined {
  if (!sel || !sel.zone) return undefined;
  const zone = CRS_ZONES.find((z) => z.value === sel.zone);
  if (!zone) return undefined;
  return {
    zone: zone.value,
    epsgCode: zone.epsgCode,
    horizontalDatum: zone.horizontalDatum,
    verticalDatum: VERTICAL_DATUM,
    coordinateBasis: sel.basis,
    ...(sel.combinedScaleFactor !== undefined
      ? { combinedScaleFactor: sel.combinedScaleFactor }
      : {}),
  };
}

/**
 * Why this selection cannot be used, or undefined when it is fine.
 *
 * Kept separate from projectCrsFor so both the form and the tool surface can
 * explain the same problem in their own words instead of one guessing at the
 * other's rules.
 */
export function crsSelectionProblem(sel: CrsSelection): string | undefined {
  if (!sel.zone) return undefined; // local coordinates are a valid choice
  if (!isKnownZone(sel.zone)) {
    return `"${sel.zone}" is not one of the zones this project offers.`;
  }
  if (sel.basis === "ground" && sel.combinedScaleFactor === undefined) {
    return "Ground coordinates require a combined scale factor: ground distances " +
      "are grid distances divided by it, and without it the coordinates cannot be " +
      "reconciled with a grid or with what a survey crew measures.";
  }
  if (sel.combinedScaleFactor !== undefined && !(sel.combinedScaleFactor > 0)) {
    return "The combined scale factor must be greater than zero.";
  }
  return undefined;
}
