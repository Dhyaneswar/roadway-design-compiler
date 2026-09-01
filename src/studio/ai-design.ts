// AI proposal schema + mapper. The model emits THIS document shape (enforced
// by structured outputs); the mapper turns it into form rows. The kernel does
// all math — the model only proposes parameters with a rationale.

import { z } from "zod";
import type { StudioForm } from "./form-to-design";

const aiTangent = z.object({
  type: z.literal("tangent"),
  length: z.number().positive(),
});

const aiArc = z.object({
  type: z.literal("arc"),
  radius: z.number().positive(),
  // Same exclusive bound as the design schema -- a proposal must not be able to
  // author a curve the kernel cannot compute.
  deltaDeg: z.number().positive().lt(180,
    "a circular curve must deflect less than 180 degrees"),
  direction: z.enum(["left", "right"]),
});

const aiDeflection = z.object({
  type: z.literal("deflection"),
  deflectionDeg: z.number().positive().max(10),
  direction: z.enum(["left", "right"]),
});

const aiPvi = z.object({
  station: z.number(),
  elevation: z.number(),
  curveLength: z.number().positive().optional(),
});

export const AiDesignProposal = z.object({
  name: z.string().min(1),
  rationale: z
    .string()
    .describe("Brief engineering rationale: why these radii, grades, K values"),
  beginStation: z.number(),
  startE: z.number(),
  startN: z.number(),
  startAzimuthDeg: z.number().min(0).max(360),
  elements: z
    .array(z.discriminatedUnion("type", [aiTangent, aiArc, aiDeflection]))
    .min(1),
  pvis: z.array(aiPvi).min(2),
});

export type AiDesignProposalT = z.infer<typeof AiDesignProposal>;

export function proposalToForm(p: AiDesignProposalT): StudioForm {
  return {
    name: p.name,
    beginStation: p.beginStation,
    startE: p.startE,
    startN: p.startN,
    startAzimuthDeg: p.startAzimuthDeg,
    elements: p.elements.map((el) =>
      el.type === "tangent"
        ? { kind: "tangent" as const, length: String(el.length) }
        : el.type === "arc"
          ? {
              kind: "arc" as const,
              radius: String(el.radius),
              deltaDeg: String(el.deltaDeg),
              direction: el.direction,
            }
          : {
              kind: "deflection" as const,
              deflectionDeg: String(el.deflectionDeg),
              direction: el.direction,
            },
    ),
    // Endpoint PVIs carry no vertical curve (schema rule); models often put
    // one there anyway — strip rather than bounce the whole proposal.
    pvis: p.pvis.map((pvi, i) => ({
      station: String(pvi.station),
      elevation: String(pvi.elevation),
      curveLength:
        pvi.curveLength !== undefined && i > 0 && i < p.pvis.length - 1
          ? String(pvi.curveLength)
          : "",
    })),
    // The model proposes geometry only (v1.5 scope); the section comes from
    // the editor's default template until proposals carry typed sections.
    templates: [
      {
        name: "2-lane",
        left: [
          { name: "lane", width: "12", slopePercent: "-2" },
          { name: "shoulder", width: "6.5", slopePercent: "-4" },
        ],
        right: [
          { name: "lane", width: "12", slopePercent: "-2" },
          { name: "shoulder", width: "6.5", slopePercent: "-4" },
        ],
      },
    ],
    drops: [{ template: "2-lane", toStation: "" }],
  };
}
