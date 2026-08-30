// Construction staking export.
//
// LandXML hands the design to another engineer's software. THIS hands it to the
// survey crew who will physically put stakes in the ground: for every station at
// a chosen interval, the coordinates and elevation of the centreline and of each
// template point, so a rod-and-gun crew or a GPS rover can set them out.
//
// It is the same computed corridor the 3D view draws -- no separate maths, so the
// stakes and the picture cannot disagree.
//
// ⛔ This is a construction deliverable. Like LandXML it sits behind the engineer
// confirmation gate: an agent may compute it and may never emit it unreviewed.

import { computeCorridor } from "../kernel/corridor";
import type { RoadDesign } from "../schema/road-design";

export interface StakingOptions {
  /** Station interval in feet. */
  intervalFt: number;
  /** Include the template points, not just the centreline. */
  includeOffsets?: boolean;
  /** Decimal places for coordinates and elevations. */
  precision?: number;
}

/** One staking row. Field crews read these top to bottom. */
export interface StakingRow {
  stationFt: number;
  /** "CL" for centreline, otherwise the template segment name. */
  pointName: string;
  /** Signed offset: negative left of centreline, positive right. */
  offsetFt: number;
  eastingFt: number;
  northingFt: number;
  elevationFt: number;
}

function fmtStation(v: number): string {
  const whole = Math.floor(v / 100);
  const rem = v - whole * 100;
  return `${whole}+${rem.toFixed(2).padStart(5, "0")}`;
}

export function stakingRows(design: RoadDesign, options: StakingOptions): StakingRow[] {
  const { intervalFt } = options;
  if (!Number.isFinite(intervalFt) || intervalFt <= 0) {
    throw new RangeError("staking interval must be a positive number of feet");
  }
  const includeOffsets = options.includeOffsets !== false;
  const corridor = computeCorridor(design, intervalFt);
  const rows: StakingRow[] = [];

  for (const section of corridor.sections) {
    rows.push({
      stationFt: section.station,
      pointName: "CL",
      offsetFt: 0,
      eastingFt: section.centerline.e,
      northingFt: section.centerline.n,
      elevationFt: section.centerline.z,
    });
    if (!includeOffsets) continue;
    // Left offsets are reported negative, which is the convention a crew expects.
    for (const p of section.left) {
      rows.push({
        stationFt: section.station,
        pointName: p.name,
        offsetFt: -p.offset,
        eastingFt: p.point.e,
        northingFt: p.point.n,
        elevationFt: p.point.z,
      });
    }
    for (const p of section.right) {
      rows.push({
        stationFt: section.station,
        pointName: p.name,
        offsetFt: p.offset,
        eastingFt: p.point.e,
        northingFt: p.point.n,
        elevationFt: p.point.z,
      });
    }
  }
  return rows;
}

/**
 * CSV a crew can load. Header row names units explicitly, because a staking file
 * with ambiguous units is how a road gets built in the wrong place.
 */
export function toStakingCsv(design: RoadDesign, options: StakingOptions): string {
  const precision = options.precision ?? 3;
  const rows = stakingRows(design, options);
  const n = (v: number): string => v.toFixed(precision);

  const header = [
    `# ${design.name} — construction staking`,
    `# interval ${options.intervalFt} ft · ${rows.length} points · US survey feet`,
    design.crs
      ? `# CRS ${design.crs.zone} EPSG:${design.crs.epsgCode} ${design.crs.horizontalDatum} / ` +
        `${design.crs.verticalDatum} (${design.crs.coordinateBasis})`
      : "# CRS not set — coordinates are project-local",
    "# offset is signed: negative = left of centreline, positive = right",
    "# NOT FOR CONSTRUCTION until sealed by a licensed Professional Engineer",
    "station,station_ft,point,offset_ft,easting_ft,northing_ft,elevation_ft",
  ].join("\n");

  const body = rows
    .map((r) =>
      [
        fmtStation(r.stationFt),
        n(r.stationFt),
        r.pointName,
        n(r.offsetFt),
        n(r.eastingFt),
        n(r.northingFt),
        n(r.elevationFt),
      ].join(","),
    )
    .join("\n");

  return `${header}\n${body}\n`;
}
