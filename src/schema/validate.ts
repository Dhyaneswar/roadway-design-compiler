// Runtime validation for RoadDesign documents (zod). This is the gate every
// document passes before the kernel sees it — including future AI-proposed
// edits, which are only ever accepted as validated document patches.

import { z } from "zod";
import { illegalXmlCharMessage, isXmlSafeText } from "./xml-text";
import { computeHorizontal } from "../kernel/horizontal";
import type { RoadDesign } from "./road-design";

const pointEN = z.object({ e: z.number().finite(), n: z.number().finite() });

const tangent = z.object({
  type: z.literal("tangent"),
  length: z.number().positive(),
});

const arc = z.object({
  type: z.literal("arc"),
  radius: z.number().positive({ message: "arc radius must be positive" }),
  // ⛔ EXCLUSIVE of 180. A circular curve's tangent and external distances are
  // R·tan(Δ/2) and R·(sec(Δ/2)−1), both singular at Δ=180 where the two tangents
  // are parallel and never meet -- there is no curve to compute.
  //
  // ⚠ PAST 180 the reason is different, and saying so wrongly cost a README
  // correction. A 276° cul-de-sac bulb is a perfectly real MAJOR arc whose
  // tangents DO intersect; what fails is this model, not the geometry. tan(Δ/2)
  // simply goes negative and puts the PI on the far side. The bound is the
  // minor-arc convention's domain, and major arcs are an unbuilt feature rather
  // than an impossible one.
  //
  // ⚠ This read .max(180) and let exactly 180 through. It survived every
  // finiteness check because IEEE 754 cannot represent π/2 exactly, so
  // Math.tan(π/2) returns 1.63e16 rather than Infinity: at R=400 the preview
  // reported a tangent distance of 6.53e18 ft and Number.isFinite said true.
  // Plausible-looking garbage passes guards that Infinity would have tripped.
  deltaDeg: z.number().positive().lt(180,
    "a circular curve must deflect less than 180 degrees: this kernel uses the " +
    "minor-arc simple-curve model, where at 180 the tangents are parallel and the " +
    "tangent and external distances are undefined, and past 180 they change sign"),
  direction: z.enum(["left", "right"]),
});

const deflection = z.object({
  type: z.literal("deflection"),
  deflectionDeg: z.number().positive().max(10, {
    message: "deflections over 10 degrees should be designed as curves",
  }),
  direction: z.enum(["left", "right"]),
});

const horizontalAlignment = z.object({
  beginStation: z.number().finite(),
  start: pointEN,
  startAzimuthDeg: z.number().finite(),
  elements: z.array(z.discriminatedUnion("type", [tangent, arc, deflection])).min(1),
});

const pvi = z.object({
  station: z.number().finite(),
  elevation: z.number().finite(),
  curveLength: z.number().positive().optional(),
});

const verticalProfile = z
  .object({ pvis: z.array(pvi).min(2) })
  .refine(
    (p) => p.pvis.every((x, i) => i === 0 || x.station > p.pvis[i - 1]!.station),
    { message: "PVIs must be in increasing station order" },
  );

const segmentMaterial = z.enum(["asphalt", "concrete", "gravel", "grass", "earth"]);

const templateSegment = z.object({
  name: z.string().min(1),
  width: z.number().positive(),
  slopePercent: z.number().finite(),
  material: segmentMaterial.optional(),
});

const pavementLayer = z.object({
  name: z.string().min(1),
  // Positive and finite: a zero or negative course is not a thin course, it is
  // a mistake, and NaN/Infinity must never reach geometry.
  thicknessIn: z.number().positive().finite(),
  material: z.string().min(1).optional(),
});

const template = z.object({
  name: z.string().min(1),
  left: z.array(templateSegment),
  right: z.array(templateSegment),
  pavementLayers: z.array(pavementLayer).optional(),
});

const drop = z.object({
  template: z.string().min(1),
  fromStation: z.number().finite(),
  toStation: z.number().finite(),
  transitionLength: z.number().positive().optional(),
});

const projectCrs = z
  .object({
    zone: z.string().min(1),
    epsgCode: z.number().int().positive(),
    horizontalDatum: z.string().min(1),
    verticalDatum: z.string().min(1),
    coordinateBasis: z.enum(["grid", "ground"]),
    combinedScaleFactor: z.number().positive().optional(),
    geoid: z.string().optional(),
  })
  .refine((c) => c.coordinateBasis !== "ground" || c.combinedScaleFactor !== undefined, {
    message: "ground coordinates require a combinedScaleFactor",
  });

const superelevationSpec = z.object({
  designSpeedMph: z.number().positive(),
  emax: z.number().positive().max(0.15),
  normalCrownPercent: z.number().positive().max(10).optional(),
  sideFriction: z.number().positive().max(0.5).optional(),
  laneWidthFt: z.number().positive().optional(),
  lanesRotated: z.number().positive().optional(),
  maxRelativeGradientPercent: z.number().positive().max(5).optional(),
  laneAdjustmentFactor: z.number().positive().optional(),
});

const roadsideItem = z.object({
  id: z.string().min(1),
  kind: z.enum(["guardrail", "concrete-barrier", "pavement-marking", "curb"]),
  side: z.enum(["left", "right"]),
  beginStation: z.number().finite(),
  endStation: z.number().finite(),
  offsetFt: z.number().positive(),
  heightFt: z.number().nonnegative().optional(),
  pattern: z.enum(["solid", "dashed", "double-solid"]).optional(),
  note: z.string().optional(),
});

const roadDesign = z
  .object({
    // ⛔ The name is the one authored string that reaches the LandXML file, so
    // the character-set rule lives here, at the gate, rather than in the
    // exporter where the design has already been mutated to hold it.
    name: z
      .string()
      .min(1)
      .refine(isXmlSafeText, {
        error: (iss) => illegalXmlCharMessage(String(iss.input)) ?? "invalid name",
      }),
    alignment: horizontalAlignment,
    profile: verticalProfile,
    templates: z.record(z.string(), template),
    drops: z.array(drop),
    crs: projectCrs.optional(),
    superelevation: superelevationSpec.optional(),
    roadside: z.array(roadsideItem).optional(),
  })
  .refine((d) => d.drops.every((x) => x.template in d.templates), {
    message: "every drop must reference a defined template",
  });

/** Print-rounding tolerance for station agreement, ft. */
const STATION_TOL = 0.01;
const EPS = 1e-9;

// The profile is stationed BY the alignment — its PVI range must span the
// alignment exactly, and vertical curves must fit between their neighboring
// PVIs without overlapping. Cross-field rules live here (not in zod shapes)
// because they need the computed horizontal length.
function checkProfileAgainstAlignment(d: RoadDesign): void {
  const fail = (msg: string): never => {
    throw new Error(`invalid RoadDesign: ${msg}`);
  };

  const begin = d.alignment.beginStation;
  const end = begin + computeHorizontal(d.alignment).length;
  const pvis = d.profile.pvis;
  const first = pvis[0]!;
  const last = pvis[pvis.length - 1]!;

  if (Math.abs(first.station - begin) > STATION_TOL) {
    fail(
      `profile must start at the alignment begin station ${begin.toFixed(2)} ` +
        `(first PVI is at ${first.station.toFixed(2)})`,
    );
  }
  if (Math.abs(last.station - end) > STATION_TOL) {
    fail(
      `profile must end at the alignment end station ${end.toFixed(2)} ` +
        `(last PVI is at ${last.station.toFixed(2)})`,
    );
  }
  if (first.curveLength !== undefined) {
    fail("first PVI cannot carry a vertical curve");
  }
  if (last.curveLength !== undefined) {
    fail("last PVI cannot carry a vertical curve");
  }

  let prevPvt = -Infinity;
  for (let i = 1; i < pvis.length - 1; i++) {
    const pvi = pvis[i]!;
    const L = pvi.curveLength ?? 0;
    if (L <= 0) continue;
    const pvc = pvi.station - L / 2;
    const pvt = pvi.station + L / 2;
    if (pvc < pvis[i - 1]!.station - EPS || pvt > pvis[i + 1]!.station + EPS) {
      fail(
        `vertical curve at PVI ${pvi.station.toFixed(2)} (L=${L}) ` +
          `extends past a neighboring PVI`,
      );
    }
    if (pvc < prevPvt - EPS) {
      fail(`vertical curves at consecutive PVIs overlap near station ${pvc.toFixed(2)}`);
    }
    prevPvt = pvt;
  }

  // Template drops are stationed by the alignment too: within range, forward,
  // and non-overlapping. Full coverage is NOT required — a corridor may
  // legitimately model a sub-range (e.g. just the widening segment).
  const sorted = [...d.drops].sort((a, b) => a.fromStation - b.fromStation);
  let prevTo = -Infinity;
  let prevDrop: (typeof sorted)[number] | undefined;
  for (const drop of sorted) {
    if (drop.fromStation >= drop.toStation) {
      fail(
        `drop at station ${drop.fromStation.toFixed(2)} must begin before its to-station`,
      );
    }
    if (drop.fromStation < begin - STATION_TOL || drop.toStation > end + STATION_TOL) {
      fail(
        `drop ${drop.fromStation.toFixed(2)}–${drop.toStation.toFixed(2)} is outside ` +
          `the alignment range ${begin.toFixed(2)}–${end.toFixed(2)}`,
      );
    }
    if (drop.fromStation < prevTo - EPS) {
      fail(`drops overlap near station ${drop.fromStation.toFixed(2)}`);
    }

    // Transitions (tapers) blend point-wise from the previous drop's template.
    if (drop.transitionLength !== undefined) {
      const L = drop.transitionLength;
      if (L > drop.toStation - drop.fromStation + EPS) {
        fail(
          `transition length ${L} exceeds the drop length at station ` +
            drop.fromStation.toFixed(2),
        );
      }
      if (!prevDrop || Math.abs(prevDrop.toStation - drop.fromStation) > STATION_TOL) {
        fail(
          `transition at station ${drop.fromStation.toFixed(2)} requires a previous drop ` +
            `ending exactly at its from-station`,
        );
      }
      const from = d.templates[prevDrop!.template]!;
      const to = d.templates[drop.template]!;
      if (from.left.length !== to.left.length || from.right.length !== to.right.length) {
        fail(
          `transition between "${prevDrop!.template}" and "${drop.template}" requires ` +
            `matching segment counts per side (point-wise blend)`,
        );
      }
    }
    prevTo = drop.toStation;
    prevDrop = drop;
  }
}

export function parseRoadDesign(input: unknown): RoadDesign {
  const result = roadDesign.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid RoadDesign: ${issues}`);
  }
  const design = result.data as RoadDesign;
  checkProfileAgainstAlignment(design);
  return design;
}
