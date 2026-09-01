// The authored pavement structure, drawn under the road at true thickness.
//
// ⛔ AUTHORED, never designed. Every thickness here is a number an engineer
// typed. Nothing in this module supplies a default course, infers a material
// from a layer's name, or scales a thickness to make it look better -- a course
// drawn thicker than it was authored is a drawing that lies about the road.
//
// The stack hangs from the road surface: each course occupies the band between
// the running cumulative depth above it and below it, following the same
// cross-section shape as the pavement it sits under. That keeps a 4 in surface
// visibly a third of a 12 in subbase, which is the point of drawing it at all.

import { computeCorridor, type Corridor, type CrossSection } from "../kernel/corridor";
import type { PavementLayer, RoadDesign } from "../schema/road-design";

export interface Point3 { e: number; n: number; z: number }

export interface PavementLayerMesh {
  /** The engineer's own name for the course. Shown verbatim. */
  name: string;
  /** As authored, in inches. */
  thicknessIn: number;
  /** Free text the engineer typed, when they typed any. */
  material?: string;
  /** Which template this stack belongs to. */
  template: string;
  /** Depth of the TOP of this course below the road surface, ft. */
  topDepthFt: number;
  positions: number[];
  indices: number[];
}

const IN_PER_FT = 12;

/**
 * The section's full running surface, left edge to right edge.
 *
 * Left points are stored outward from the centreline, so they are reversed to
 * make one continuous left-to-right chain. The centreline point itself joins
 * the two sides; without it the stack would be creased along the crown.
 */
function surfaceChain(sec: CrossSection): Point3[] {
  const left = [...sec.left].reverse().map((p) => p.point);
  const right = sec.right.map((p) => p.point);
  return [...left, sec.centerline, ...right];
}

/**
 * One mesh per authored course, for every template that has a stack.
 *
 * Sections whose template has no authored stack are skipped rather than given
 * an invented one: "not stated" is not "none".
 */
export function buildPavementMeshes(
  design: RoadDesign,
  origin: Point3,
  intervalFt = 25,
  corridor?: Corridor,
): PavementLayerMesh[] {
  const c = corridor ?? computeCorridor(design, intervalFt);
  if (c.sections.length < 2) return [];

  const out: PavementLayerMesh[] = [];

  // Group consecutive sections by template: a stack belongs to one template, and
  // a run that changes template mid-way must not be swept as one solid.
  let runStart = 0;
  for (let i = 1; i <= c.sections.length; i += 1) {
    const ended = i === c.sections.length
      || c.sections[i]!.template !== c.sections[runStart]!.template;
    if (!ended) continue;

    const template = c.sections[runStart]!.template;
    const layers: PavementLayer[] = design.templates[template]?.pavementLayers ?? [];
    const run = c.sections.slice(runStart, i);
    if (layers.length > 0 && run.length >= 2) {
      let depthFt = 0;
      for (const layer of layers) {
        const thickFt = layer.thicknessIn / IN_PER_FT;
        out.push({
          name: layer.name,
          thicknessIn: layer.thicknessIn,
          material: layer.material,
          template,
          topDepthFt: depthFt,
          ...sweep(run, origin, depthFt, depthFt + thickFt),
        });
        depthFt += thickFt;
      }
    }
    runStart = i;
  }
  return out;
}

/** Sweep the band between two depths below the running surface. */
function sweep(
  sections: readonly CrossSection[],
  origin: Point3,
  topDepthFt: number,
  bottomDepthFt: number,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const chains = sections.map(surfaceChain);
  const width = chains[0]!.length;
  // A template change can alter the point count. Sweeping across one would
  // interpolate between shapes that do not correspond, so the run stops instead.
  if (!chains.every((ch) => ch.length === width)) return { positions, indices };

  const push = (p: Point3, dz: number): number => {
    const idx = positions.length / 3;
    positions.push(p.e - origin.e, p.z - dz - origin.z, -(p.n - origin.n));
    return idx;
  };

  // Two rings per section: the top of the course and its bottom.
  const topRing: number[][] = [];
  const botRing: number[][] = [];
  for (const chain of chains) {
    topRing.push(chain.map((p) => push(p, topDepthFt)));
    botRing.push(chain.map((p) => push(p, bottomDepthFt)));
  }

  const quad = (a: number, b: number, cc: number, d: number): void => {
    indices.push(a, b, cc, a, cc, d);
  };

  for (let s = 0; s + 1 < chains.length; s += 1) {
    for (let k = 0; k + 1 < width; k += 1) {
      // Top and bottom faces.
      quad(topRing[s]![k]!, topRing[s]![k + 1]!, topRing[s + 1]![k + 1]!, topRing[s + 1]![k]!);
      quad(botRing[s]![k + 1]!, botRing[s]![k]!, botRing[s + 1]![k]!, botRing[s + 1]![k + 1]!);
    }
    // The two outside edges, so the stack reads as solid courses in a cut view.
    const l = 0, r = width - 1;
    quad(topRing[s]![l]!, botRing[s]![l]!, botRing[s + 1]![l]!, topRing[s + 1]![l]!);
    quad(botRing[s]![r]!, topRing[s]![r]!, topRing[s + 1]![r]!, botRing[s + 1]![r]!);
  }

  // Cap both ends, so a cross-section view shows courses rather than open shells.
  const capEnd = (ring: number[], bot: number[], flip: boolean): void => {
    for (let k = 0; k + 1 < width; k += 1) {
      if (flip) quad(ring[k + 1]!, ring[k]!, bot[k]!, bot[k + 1]!);
      else quad(ring[k]!, ring[k + 1]!, bot[k + 1]!, bot[k]!);
    }
  };
  capEnd(topRing[0]!, botRing[0]!, false);
  capEnd(topRing[topRing.length - 1]!, botRing[botRing.length - 1]!, true);

  return { positions, indices };
}

/**
 * Colours for a stack, assigned across the WHOLE stack.
 *
 * ⛔ These distinguish courses and nothing else. They are not material colours:
 * a course called "surface" is not painted asphalt-black because the app has no
 * business deciding that "surface" means asphalt. Assigned across the complete
 * stack so two courses can never collide into the same visible colour, and
 * deterministic so a reload draws the same stack the same way.
 */
const LAYER_PALETTE: readonly number[] = [
  0xb08968, 0x7f8c8d, 0x9a8c98, 0x6d8b74, 0xa68a64, 0x6b7a8f,
  0x8f7a6b, 0x748b8b, 0x8b7488, 0x8b8b74,
];

export function pavementLayerColors(count: number): number[] {
  return Array.from({ length: count }, (_, i) => LAYER_PALETTE[i % LAYER_PALETTE.length]!);
}
