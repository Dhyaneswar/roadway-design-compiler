// RoadDesign schema v0 — the single source of truth every other module reads/writes.
// Element model follows FDOT's Roadway 3D Modeling element matrix conventions
// (alignment + station/offset location data; US survey feet).

export interface PointEN {
  /** Easting, US survey feet */
  e: number;
  /** Northing, US survey feet */
  n: number;
}

export interface TangentElement {
  type: "tangent";
  /** Length along centerline, ft */
  length: number;
}

export interface ArcElement {
  type: "arc";
  /** Radius, ft (always positive) */
  radius: number;
  /** Central angle, degrees (always positive) */
  deltaDeg: number;
  /** Turn direction looking ahead on stationing */
  direction: "left" | "right";
}

export interface DeflectionElement {
  /** Angle point: instantaneous bearing change with no curve (urban practice
   *  for tiny deflections; see corpus PI 0000297 sheet 47). Zero length. */
  type: "deflection";
  /** Deflection angle, degrees (always positive) */
  deflectionDeg: number;
  direction: "left" | "right";
}

export type HorizontalElement = TangentElement | ArcElement | DeflectionElement;

export interface HorizontalAlignment {
  /** Station value at the start point, ft */
  beginStation: number;
  start: PointEN;
  /** Azimuth of the initial heading, degrees clockwise from north */
  startAzimuthDeg: number;
  elements: HorizontalElement[];
}

export interface PVI {
  /** Station, ft */
  station: number;
  /** Elevation, ft */
  elevation: number;
  /** Symmetric parabolic curve length through this PVI, ft (omit for none) */
  curveLength?: number;
}

export interface VerticalProfile {
  /** PVIs in increasing station order; first and last carry no curve */
  pvis: PVI[];
}

export interface TemplateSegment {
  name: string;
  /** Horizontal width of this segment, ft (measured outward) */
  width: number;
  /** Cross slope, percent; negative drains away from centerline */
  slopePercent: number;
}

export interface Template {
  name: string;
  /** Segments outward from centerline on the left side */
  left: TemplateSegment[];
  /** Segments outward from centerline on the right side */
  right: TemplateSegment[];
}

export interface TemplateDrop {
  /** Key into RoadDesign.templates */
  template: string;
  fromStation: number;
  toStation: number;
  /** Taper: blend linearly from the previous drop's template over the first
   *  N ft of this drop. Requires an adjacent previous drop and matching
   *  segment counts per side (point-wise interpolation). */
  transitionLength?: number;
}

export interface ProjectCrs {
  /** Named zone shorthand, e.g. "GA-West", "GA-East", or "custom" */
  zone: string;
  /** EPSG code for the projected CRS (GA West ftUS = 2240, GA East ftUS = 2239) */
  epsgCode: number;
  /** e.g. "NAD83 / Georgia Coordinate System of 1985, West Zone" */
  horizontalDatum: string;
  /** e.g. "NAVD88" */
  verticalDatum: string;
  /** Grid (state plane) vs ground (scaled) coordinates — never leave ambiguous.
   *  Survey topo files inherit this from project control; everything that
   *  references them inherits it too. */
  coordinateBasis: "grid" | "ground";
  /** Combined scale factor when coordinateBasis is "ground" */
  combinedScaleFactor?: number;
  /** Geoid model used for GNSS-derived elevations, e.g. "GEOID18" */
  geoid?: string;
}


/** Superelevation policy for the design. Optional: without it the corridor
 *  keeps its template cross slopes everywhere, exactly as before. */
export interface SuperelevationSpec {
  designSpeedMph: number;
  /** Maximum superelevation rate as a decimal, e.g. 0.06. */
  emax: number;
  normalCrownPercent?: number;
  sideFriction?: number;
  laneWidthFt?: number;
  lanesRotated?: number;
  maxRelativeGradientPercent?: number;
  laneAdjustmentFactor?: number;
}

export interface RoadDesign {
  name: string;
  alignment: HorizontalAlignment;
  profile: VerticalProfile;
  templates: Record<string, Template>;
  drops: TemplateDrop[];
  /** Project coordinate reference system. Optional in v0 documents; the
   *  exporter emits LandXML <CoordinateSystem> when present. */
  crs?: ProjectCrs;
  /** When present, curves are banked and the corridor cross slopes rotate. */
  superelevation?: SuperelevationSpec;
}
