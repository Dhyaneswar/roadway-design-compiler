// Roadside furniture — guardrail, barrier, and the markings an engineer specifies.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT DECORATION
// ---------------------------------------------------------------------------
// None of this appears in an imported LandXML, because LandXML carries what was
// surveyed and what was designed as surfaces -- not the roadside hardware. It
// would have been easy to conclude that drawing a guardrail is therefore always
// invention, and to leave it out.
//
// That is the wrong line. The distinction that matters is AUTHORED versus
// INVENTED, not existing versus new. A guardrail nobody asked for is decoration.
// A guardrail an engineer placed from station 12+00 to 18+00, left side, at an
// 8 ft offset, W-beam, is design data -- and a tool that cannot author it is not
// a design tool. Every field below is stated by a person or an agent acting for
// one, and nothing is inferred from geometry.
//
// So: the viewer draws these because they were authored, exactly as it draws a
// lane because a template authored it.

/** What the item is. Drives how it is drawn and how it is measured. */
export type RoadsideKind =
  /** Flexible W-beam or cable barrier along the shoulder. */
  | "guardrail"
  /** Rigid concrete barrier, typically a median or bridge parapet. */
  | "concrete-barrier"
  /** Longitudinal painted line: lane line, edge line, centre line. */
  | "pavement-marking"
  /** Raised curb at a pavement edge. */
  | "curb";

/** Which side of the centreline it runs along. */
export type RoadsideSide = "left" | "right";

/** Marking pattern. Only meaningful for a pavement-marking. */
export type MarkingPattern = "solid" | "dashed" | "double-solid";

export interface RoadsideItem {
  /** Stable id so an agent can change or remove exactly one item. */
  id: string;
  kind: RoadsideKind;
  side: RoadsideSide;
  /** Station where it starts, ft. */
  beginStation: number;
  /** Station where it ends, ft. Must exceed beginStation. */
  endStation: number;
  /**
   * Distance from the centreline, ft, always positive -- `side` carries the
   * direction. An item is placed where the engineer says, not where the template
   * happens to end, because the two are frequently different.
   */
  offsetFt: number;
  /** Height above the roadway surface, ft. Zero for a marking. */
  heightFt?: number;
  /** Pattern, for a pavement-marking. */
  pattern?: MarkingPattern;
  /** Free note the engineer can hang on it, e.g. a standard detail number. */
  note?: string;
}

/** Default height by kind, ft. Used only when the engineer states none. */
export const DEFAULT_HEIGHT_FT: Readonly<Record<RoadsideKind, number>> = {
  guardrail: 2.5,
  "concrete-barrier": 2.67,
  "pavement-marking": 0,
  curb: 0.5,
};

export function heightOf(item: RoadsideItem): number {
  return item.heightFt ?? DEFAULT_HEIGHT_FT[item.kind];
}

/** Length along the road, ft — what a quantity take-off is measured in. */
export function lengthOf(item: RoadsideItem): number {
  return Math.max(0, item.endStation - item.beginStation);
}

export interface RoadsideProblem {
  id: string;
  code: string;
  detail: string;
  measurements: Record<string, number>;
}

/**
 * Check placement against the alignment. Returns problems rather than throwing,
 * because an agent needs to be told what is wrong in a form it can act on.
 *
 * ⚠ Deliberately NOT checked here: whether a guardrail is warranted. Warrant is a
 * judgement about fill height, slope and clear zone that belongs to a licensed
 * engineer, and a tool that silently decides it would be answering the question
 * the engineer is paid to answer.
 */
export function checkRoadside(
  items: readonly RoadsideItem[],
  beginStation: number,
  endStation: number,
): RoadsideProblem[] {
  const problems: RoadsideProblem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.id)) {
      problems.push({
        id: item.id, code: "DuplicateRoadsideId",
        detail: `More than one roadside item is called "${item.id}".`,
        measurements: {},
      });
    }
    seen.add(item.id);

    if (item.endStation <= item.beginStation) {
      problems.push({
        id: item.id, code: "RoadsideRunIsNotForward",
        detail: `"${item.id}" ends at or before it begins.`,
        measurements: { beginStation: item.beginStation, endStation: item.endStation },
      });
    }
    if (item.beginStation < beginStation - 0.01 || item.endStation > endStation + 0.01) {
      problems.push({
        id: item.id, code: "RoadsideOutsideAlignment",
        detail:
          `"${item.id}" runs ${item.beginStation.toFixed(2)}–${item.endStation.toFixed(2)}, ` +
          `outside the alignment ${beginStation.toFixed(2)}–${endStation.toFixed(2)}.`,
        measurements: {
          itemBegin: item.beginStation, itemEnd: item.endStation,
          alignmentBegin: beginStation, alignmentEnd: endStation,
        },
      });
    }
    if (!(item.offsetFt > 0)) {
      problems.push({
        id: item.id, code: "RoadsideOffsetNotPositive",
        detail: `"${item.id}" has offset ${item.offsetFt}; offset is a distance and side carries the direction.`,
        measurements: { offsetFt: item.offsetFt },
      });
    }
    if (item.kind === "pavement-marking" && item.pattern === undefined) {
      problems.push({
        id: item.id, code: "MarkingPatternUnstated",
        detail: `"${item.id}" is a pavement marking with no pattern; solid and dashed mean different things to a driver.`,
        measurements: {},
      });
    }
  }
  return problems;
}

/** Quantity take-off by kind, ft — what goes on a bid schedule. */
export function roadsideQuantities(
  items: readonly RoadsideItem[],
): { kind: RoadsideKind; count: number; totalLengthFt: number }[] {
  const byKind = new Map<RoadsideKind, { count: number; totalLengthFt: number }>();
  for (const item of items) {
    const row = byKind.get(item.kind) ?? { count: 0, totalLengthFt: 0 };
    row.count += 1;
    row.totalLengthFt += lengthOf(item);
    byKind.set(item.kind, row);
  }
  return [...byKind.entries()].map(([kind, v]) => ({
    kind, count: v.count, totalLengthFt: Number(v.totalLengthFt.toFixed(3)),
  }));
}
