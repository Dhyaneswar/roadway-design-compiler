// WebMCP bridge for the Roadway Design Compiler.
//
// The trust model this app was built on -- "AI proposes parameters, the kernel
// computes, the engineer owns every decision" -- is exactly what WebMCP is for.
// So the agent gets tools that PROPOSE and READ. It never computes geometry, and
// it can never be the confirming party.
//
// Three things are deliberate:
//
// 1. EVERY write tool previews by default. `commit: false` (the default) computes
//    the consequence and changes nothing. The engineer confirms.
// 2. Every refusal is a typed structure with the numbers needed to fix it and the
//    tool that fixes it -- see webmcp-refusals.ts. A refusal is a RESULT.
// 3. Every committed change is stamped agent-proposed. The agent cannot seal a
//    design; a licensed Professional Engineer does that, and carries the liability.
//
// The engineering conventions that used to live in a server-side system prompt now
// live in these tool descriptions, so ANY agent inherits them -- which is the point
// of the standard.

import { computeHorizontal } from "../kernel/horizontal";
import { computeVertical } from "../kernel/vertical";
import { crossSectionAt } from "../kernel/corridor";
import { toLandXML } from "../exporters/landxml";
import { alignmentRangeFromForm } from "./form-to-design";
import type { FormElementRow, FormPviRow, StudioForm } from "./form-to-design";
import { judgeCurveRadius, judgeGrade, judgeVerticalCurveK,
  type CriteriaBasis } from "../kernel/criteria";
import { transitionFor } from "../kernel/superelevation";
import type { SuperelevationSpec } from "../schema/road-design";
import { AiDesignProposal, proposalToForm } from "./ai-design";
import { isRefusal, tryBuild, type Refusal } from "./webmcp-refusals";

export const AGENT_PROVENANCE = "agent-proposed; awaiting engineer confirmation";

export interface WebMcpTextResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
}
/** MCP tool annotations. Hints, not enforcement -- the engine still decides. */
export interface WebMcpToolAnnotations {
  readonly title?: string;
  /** True when the tool cannot change the model under any arguments. */
  readonly readOnlyHint?: boolean;
  /** True when the tool may remove or overwrite work irrecoverably. */
  readonly destructiveHint?: boolean;
  /** True when repeating the call with the same arguments changes nothing further. */
  readonly idempotentHint?: boolean;
  /** True when the tool reaches anything outside this page. */
  readonly openWorldHint?: boolean;
}

export interface WebMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: WebMcpToolAnnotations;
  readonly execute: (args: Record<string, unknown>) => Promise<WebMcpTextResult>;
}
export interface WebMcpModelContext {
  registerTool(tool: WebMcpTool): Promise<void> | void;
}

declare global {
  interface Document { readonly modelContext?: WebMcpModelContext }
  interface Navigator { readonly modelContext?: WebMcpModelContext }
}

/** The DOM layer implements this. The bridge never touches the DOM itself. */
export interface StudioHost {
  readForm(): StudioForm;
  /** Apply a form to the live studio: state, inputs, and a re-render.
   *  `agentChange` describes what the agent did, and is recorded as pending
   *  engineer confirmation. */
  writeForm(next: StudioForm, agentChange?: string): void;
  /** Agent-authored changes not yet confirmed by a human. */
  pendingChanges(): readonly { readonly id: number; readonly description: string }[];
  /** Called for EVERY tool invocation. This is what proves, from inside the
   *  tool surface, that an agent used WebMCP rather than driving the DOM. */
  onToolCall?(tool: string, result: unknown): void;
  /** The selected coordinate reference system, so LandXML matches the app exactly. */
  readCrs(): unknown;
}

/** Curve table rows, derived from element reports (PC = begin, PT = end). */
function curveRows(h: { elements: readonly { type: string; beginStation: number; endStation: number; curve?: unknown }[] }) {
  const rows: Record<string, unknown>[] = [];
  h.elements.forEach((el, i) => {
    if (el.type !== "arc" || el.curve === undefined) return;
    const c = el.curve as Record<string, number>;
    rows.push({
      elementIndex: i + 1,
      pcStationFt: el.beginStation,
      ptStationFt: el.endStation,
      radiusFt: c.radius,
      deltaDeg: c.deltaDeg,
      tangentFt: c.tangentDistance,
      arcLengthFt: c.length,
      chordFt: c.chord,
      externalFt: c.external,
      middleOrdinateFt: c.middleOrdinate,
    });
  });
  return rows;
}

const clone = (form: StudioForm): StudioForm => JSON.parse(JSON.stringify(form)) as StudioForm;
const ok = (v: unknown): WebMcpTextResult => ({
  content: [{ type: "text", text: JSON.stringify(v, null, 1) }],
});

const S = {
  obj: (properties: Record<string, unknown>, required: string[] = []) =>
    ({ type: "object", properties, required }) as Record<string, unknown>,
  num: (description: string) => ({ type: "number", description }),
  int: (description: string) => ({ type: "integer", description }),
  str: (description: string) => ({ type: "string", description }),
  enum: (values: string[], description: string) => ({ type: "string", enum: values, description }),
  commit: {
    type: "boolean",
    description:
      "false (the default) PREVIEWS: it computes the consequence and changes nothing. " +
      "true applies the change. Preview first; a licensed engineer confirms.",
  },
};

/** Shared shape for every write tool: preview, or commit with provenance. */
function applyOrPreview(
  host: StudioHost,
  next: StudioForm,
  commit: boolean,
  what: string,
): unknown {
  const built = tryBuild(next);
  if (isRefusal(built)) return built;

  const h = computeHorizontal(built.design.alignment);
  const v = computeVertical(built.design.profile);
  const range = alignmentRangeFromForm(next);
  const consequence = {
    change: what,
    alignmentLengthFt: Number(h.length.toFixed(4)),
    beginStationFt: range.begin,
    endStationFt: Number(range.end.toFixed(4)),
    curveCount: curveRows(h).length,
    verticalCurveCount: v.curves.length,
    highLowPointCount: v.highLowPoints.length,
  };

  if (!commit) {
    return { previewed: true, committed: false, ...consequence,
      note: "Nothing changed. Call again with commit: true to apply." };
  }
  host.writeForm(next, what);
  return {
    committed: true,
    ...consequence,
    provenance: AGENT_PROVENANCE,
    pendingEngineerConfirmation: host.pendingChanges().length,
    note:
      "Applied and stamped agent-proposed. It is NOT confirmed: a licensed engineer " +
      "confirms it in the Studio. LandXML export stays blocked until they do.",
  };
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}


/**
 * Tool annotation policy, in one place so it can be read as a policy rather than
 * hunted for across twenty call sites.
 *
 *   readOnlyHint    the tool cannot change the model under ANY arguments
 *   destructiveHint the tool can remove authored work
 *   idempotentHint  repeating the call with the same arguments changes nothing more
 *   openWorldHint   the tool reaches outside this page (nothing here does: the
 *                   kernel is local and deterministic, and there is no network)
 *
 * Note every write tool is idempotent EXCEPT the two that append. That is a real
 * distinction an agent can act on: retrying a failed set_pvi is safe, retrying a
 * failed add_pvi may not be.
 *
 * ⚠ MEASURED 2026-08-30 against Chrome's WebMCP implementation: only
 * `readOnlyHint` survives registration. Chrome adds its own
 * `untrustedContentHint` and DROPS `destructiveHint`, `idempotentHint`,
 * `openWorldHint` and `title`. The full set is kept here anyway -- it is correct,
 * it is what MCP specifies, and other transports carry it -- but anything an
 * agent must actually know is ALSO stated in the tool description, which is the
 * only channel guaranteed to reach it.
 */
const ANNOTATIONS: Readonly<Record<string, WebMcpToolAnnotations>> = {
  read_design: { title: "Read the design", readOnlyHint: true, idempotentHint: true },
  read_alignment_range: { title: "Read alignment extents", readOnlyHint: true, idempotentHint: true },
  read_curve_table: { title: "Read the curve table", readOnlyHint: true, idempotentHint: true },
  read_profile_table: { title: "Read the profile table", readOnlyHint: true, idempotentHint: true },
  read_cross_section: { title: "Read a cross section", readOnlyHint: true, idempotentHint: true },
  read_superelevation: { title: "Read superelevation", readOnlyHint: true, idempotentHint: true },
  read_pending_changes: { title: "Read unconfirmed changes", readOnlyHint: true, idempotentHint: true },
  what_do_i_need: { title: "Ask what is wrong", readOnlyHint: true, idempotentHint: true },
  check_design_criteria: { title: "Judge against a design speed", readOnlyHint: true, idempotentHint: true },
  export_landxml: { title: "Export LandXML", readOnlyHint: true, idempotentHint: true },

  propose_full_design: { title: "Propose a whole road", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  set_project_setup: { title: "Set project setup", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  set_horizontal_element: { title: "Change an element", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  set_pvi: { title: "Change a PVI", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  set_template_segment: { title: "Change a template segment", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  set_template_drop: { title: "Change a template drop", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  set_superelevation: { title: "Set superelevation policy", readOnlyHint: false, destructiveHint: false, idempotentHint: true },

  add_horizontal_element: { title: "Append an element", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  add_pvi: { title: "Insert a PVI", readOnlyHint: false, destructiveHint: false, idempotentHint: false },

  remove_horizontal_element: { title: "Remove an element", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  remove_pvi: { title: "Remove a PVI", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

export function buildTools(host: StudioHost): WebMcpTool[] {
  const tools: WebMcpTool[] = [];
  const add = (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    run: (args: Record<string, unknown>) => unknown,
    annotations?: WebMcpToolAnnotations,
  ): void => {
    tools.push({
      name, description, inputSchema, annotations,
      execute: async (args) => {
        let payload: unknown;
        try { payload = run(args ?? {}); }
        catch (e) {
          // A thrown error is a bug in the bridge, not an engineering refusal.
          // Say which it is rather than letting the agent conflate them.
          payload = { error: true, code: "BridgeFault",
            detail: e instanceof Error ? e.message : String(e) };
        }
        host.onToolCall?.(name, payload);
        return ok(payload);
      },
    });
  };


  // ---------------------------------------------------------------- READ TOOLS

  add(
    "read_design",
    "Read the whole current road design: project setup, horizontal elements, vertical PVIs, " +
      "templates and template drops, plus whether it currently validates. Start here.",
    S.obj({}),
    () => {
      const form = host.readForm();
      const built = tryBuild(form);
      return {
        project: {
          name: form.name, beginStationFt: form.beginStation,
          startEastingFt: form.startE, startNorthingFt: form.startN,
          startAzimuthDeg: form.startAzimuthDeg,
        },
        horizontalElements: form.elements,
        pvis: form.pvis,
        templates: form.templates,
        drops: form.drops,
        valid: !isRefusal(built),
        refusal: isRefusal(built) ? built : undefined,
      };
    },
  );

  add(
    "read_alignment_range",
    "Read the alignment's begin station, end station and total length in US survey feet. " +
      "The vertical profile and the template drops are stationed BY this range, so any " +
      "horizontal edit moves the end station and the profile must follow it.",
    S.obj({}),
    () => {
      const form = host.readForm();
      try {
        const r = alignmentRangeFromForm(form);
        return { beginStationFt: r.begin, endStationFt: Number(r.end.toFixed(4)),
          lengthFt: Number((r.end - r.begin).toFixed(4)) };
      } catch (e) {
        return { unavailable: true, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  add(
    "read_curve_table",
    "Read the computed horizontal curve table: for each circular curve the PC and PT stations, " +
      "radius, delta, tangent, arc length and external distance. These are computed by the " +
      "deterministic kernel, not by the agent.",
    S.obj({}),
    () => {
      const built = tryBuild(host.readForm());
      if (isRefusal(built)) return built;
      const h = computeHorizontal(built.design.alignment);
      return { alignmentLengthFt: h.length, curves: curveRows(h),
        elements: h.elements.map((e) => ({ type: e.type, beginStationFt: e.beginStation,
          endStationFt: e.endStation, beginAzimuthDeg: e.beginAzimuthDeg })) };
    },
  );

  add(
    "read_profile_table",
    "Read the computed vertical profile: each vertical curve with its PVI station and elevation, " +
      "curve length, K value, PVC and PVT stations and the incoming/outgoing grades, plus the " +
      "high and low points. K = L / |g2 - g1| and governs stopping sight distance.",
    S.obj({}),
    () => {
      const built = tryBuild(host.readForm());
      if (isRefusal(built)) return built;
      const v = computeVertical(built.design.profile);
      return { curves: v.curves, highLowPoints: v.highLowPoints };
    },
  );

  add(
    "read_cross_section",
    "Read the corridor cross-section at one station: every template point with its offset from " +
      "centreline and its elevation. Use this to check what the road actually looks like at a " +
      "location, rather than inferring it from the template definition.",
    S.obj({ station: S.num("Station in feet, e.g. 2500 means 25+00.") }, ["station"]),
    (args) => {
      const station = readNumber(args, "station");
      if (station === undefined) return { error: true, code: "BadArgument", detail: "station must be a number" };
      const built = tryBuild(host.readForm());
      if (isRefusal(built)) return built;
      try {
        return crossSectionAt(built.design, station);
      } catch (e) {
        const r = alignmentRangeFromForm(host.readForm());
        return { refused: true, code: "StationOutsideCorridor",
          detail: e instanceof Error ? e.message : String(e),
          measurements: { requestedStationFt: station, beginStationFt: r.begin, endStationFt: r.end },
          resolvedBy: ["read_alignment_range"], authority: ["RoadDesign v0.2 template drops"] };
      }
    },
  );

  add(
    "what_do_i_need",
    "Ask the design what is currently wrong with it. Returns a typed refusal carrying the exact " +
      "numbers needed to fix it and the name of the tool that fixes it, or valid: true. " +
      "Call this whenever a change is refused.",
    S.obj({}),
    () => {
      const built = tryBuild(host.readForm());
      if (!isRefusal(built)) {
        const h = computeHorizontal(built.design.alignment);
        return { valid: true, alignmentLengthFt: h.length, curveCount: curveRows(h).length };
      }
      return built;
    },
  );

  add(
    "set_superelevation",
    "Turn on superelevation — banking the roadway through its horizontal curves — and set the " +
      "policy. Once on, every circular curve gets a superelevation rate computed from its radius " +
      "and the design speed, with a runoff and tangent runout sized from the maximum relative " +
      "gradient. The 3D corridor and the cross sections rotate accordingly. " +
      "A flatter curve that friction alone can carry stays at normal crown; a curve at or below " +
      "the minimum radius is banked at emax. " +
      "Pass enabled: false to remove banking and return the road to its template cross slopes. " +
      "Coefficients are inputs with illustrative defaults, NOT an adopted agency standard.",
    S.obj({
      enabled: { type: "boolean", description: "false removes banking entirely. Default true." },
      designSpeedMph: S.num("Design speed in mph. Required when enabling."),
      emax: S.num("Maximum superelevation rate as a decimal, e.g. 0.06. Default 0.06."),
      normalCrownPercent: S.num("Normal crown magnitude in percent. Default 2."),
      sideFriction: S.num("Side friction factor. Default is a fitted curve falling with speed."),
      laneWidthFt: S.num("Width of one rotated lane, ft. Default 12."),
      lanesRotated: S.num("Lanes rotated about the pivot. Default 1."),
      maxRelativeGradientPercent: S.num("Maximum relative gradient, percent. Default falls with speed."),
      commit: S.commit,
    }),
    (args) => {
      const next = clone(host.readForm());
      if (args.enabled === false) {
        delete next.superelevation;
        return applyOrPreview(host, next, args.commit === true, "remove superelevation");
      }
      const speed = readNumber(args, "designSpeedMph") ?? next.superelevation?.designSpeedMph;
      if (speed === undefined || speed <= 0) {
        return { error: true, code: "BadArgument",
          detail: "designSpeedMph is required to enable superelevation." };
      }
      const spec: SuperelevationSpec = {
        designSpeedMph: speed,
        emax: readNumber(args, "emax") ?? next.superelevation?.emax ?? 0.06,
        ...(readNumber(args, "normalCrownPercent") !== undefined
          ? { normalCrownPercent: readNumber(args, "normalCrownPercent") } : {}),
        ...(readNumber(args, "sideFriction") !== undefined
          ? { sideFriction: readNumber(args, "sideFriction") } : {}),
        ...(readNumber(args, "laneWidthFt") !== undefined
          ? { laneWidthFt: readNumber(args, "laneWidthFt") } : {}),
        ...(readNumber(args, "lanesRotated") !== undefined
          ? { lanesRotated: readNumber(args, "lanesRotated") } : {}),
        ...(readNumber(args, "maxRelativeGradientPercent") !== undefined
          ? { maxRelativeGradientPercent: readNumber(args, "maxRelativeGradientPercent") } : {}),
      };
      next.superelevation = spec;
      return applyOrPreview(host, next, args.commit === true,
        `superelevation at ${speed} mph, emax ${spec.emax}`);
    },
  );

  add(
    "read_superelevation",
    "Read the superelevation transition for every curve: the full superelevation rate, the " +
      "runoff and tangent runout lengths, and the station landmarks where normal crown ends, " +
      "the runoff begins, full banking is reached at the PC, held to the PT, and released. " +
      "Also reports the cross slope of each side at any station you ask about.",
    S.obj({
      atStation: S.num("Optional station in feet to report the left and right cross slope at."),
    }),
    () => {
      const form = host.readForm();
      if (!form.superelevation) {
        return { enabled: false,
          note: "No superelevation policy. Call set_superelevation to bank the curves." };
      }
      const built = tryBuild(form);
      if (isRefusal(built)) return built;
      const h = computeHorizontal(built.design.alignment);
      const spec = form.superelevation;
      const transitions: unknown[] = [];
      h.elements.forEach((report, i) => {
        if (report.type !== "arc" || report.curve === undefined) return;
        const authored = built.design.alignment.elements[i];
        const direction =
          authored !== undefined && "direction" in authored && authored.direction === "left"
            ? "left" as const : "right" as const;
        transitions.push(transitionFor({
          radiusFt: report.curve.radius, direction,
          pcStation: report.beginStation, ptStation: report.endStation,
        }, i, spec));
      });
      return { enabled: true, policy: spec, transitions };
    },
  );

  add(
    "read_pending_changes",
    "List the changes you have authored that a licensed engineer has NOT yet confirmed. " +
      "Everything an agent applies is stamped agent-proposed and held here until a person " +
      "confirms it in the Studio. While anything is pending, the LandXML deliverable cannot " +
      "be produced. ⛔ There is deliberately no tool that confirms them: an agent can never " +
      "be the confirming party. Report the list to the engineer and ask them to confirm.",
    S.obj({}),
    () => {
      const pending = host.pendingChanges();
      return {
        pendingCount: pending.length,
        pending: pending.map((c) => ({ id: c.id, description: c.description })),
        deliverableBlocked: pending.length > 0,
        note: pending.length === 0
          ? "Nothing outstanding. The design is confirmed and can be exported."
          : "A person must confirm these in the Studio before LandXML can be produced.",
        authority: ["ADR: an agent can never be the confirming party"],
      };
    },
  );

  add(
    "check_design_criteria",
    "Judge the whole design against a design speed and return a verdict for every horizontal " +
      "curve, every vertical curve and every grade. Each verdict says pass or fail, the value " +
      "the design has, the value the criterion requires, and the relationship used to get there. " +
      "Failing verdicts tell you what would comply -- a minimum radius, or the curve length that " +
      "would reach the required K. " +
      "IMPORTANT: this computes criteria from engineering relationships using the coefficients " +
      "you supply. The defaults are illustrative, NOT an adopted agency standard. Supply your " +
      "agency's side friction, reaction time, deceleration, sight heights and maximum grade to " +
      "judge against your own criteria. The app applies the engineering; it does not ship " +
      "somebody else's table.",
    S.obj({
      designSpeedMph: S.num("Design speed in mph. Required -- criteria are meaningless without it."),
      emax: S.num("Maximum superelevation rate as a decimal, e.g. 0.06 for 6 percent. Default 0.06."),
      sideFriction: S.num("Side friction factor at the design speed. Default is a fitted approximation."),
      reactionTimeS: S.num("Driver perception-reaction time in seconds. Default 2.5."),
      decelerationFtS2: S.num("Deceleration rate in ft/s^2. Default 11.2."),
      eyeHeightFt: S.num("Driver eye height in feet. Default 3.5."),
      objectHeightFt: S.num("Object height in feet. Default 2.0."),
      maxGradePercent: S.num("Maximum grade in percent. Default 8."),
    }, ["designSpeedMph"]),
    (args) => {
      const speed = readNumber(args, "designSpeedMph");
      if (speed === undefined || speed <= 0) {
        return { error: true, code: "BadArgument",
          detail: "designSpeedMph is required and must be positive; criteria cannot be judged without it." };
      }
      const built = tryBuild(host.readForm());
      if (isRefusal(built)) return built;

      // Built explicitly rather than by index assignment, so each optional
      // coefficient keeps its declared type instead of being cast through a
      // string-indexed record.
      const basis: CriteriaBasis = {
        designSpeedMph: speed,
        emax: readNumber(args, "emax") ?? 0.06,
        ...(readNumber(args, "sideFriction") !== undefined
          ? { sideFriction: readNumber(args, "sideFriction") } : {}),
        ...(readNumber(args, "reactionTimeS") !== undefined
          ? { reactionTimeS: readNumber(args, "reactionTimeS") } : {}),
        ...(readNumber(args, "decelerationFtS2") !== undefined
          ? { decelerationFtS2: readNumber(args, "decelerationFtS2") } : {}),
        ...(readNumber(args, "eyeHeightFt") !== undefined
          ? { eyeHeightFt: readNumber(args, "eyeHeightFt") } : {}),
        ...(readNumber(args, "objectHeightFt") !== undefined
          ? { objectHeightFt: readNumber(args, "objectHeightFt") } : {}),
        ...(readNumber(args, "maxGradePercent") !== undefined
          ? { maxGradePercent: readNumber(args, "maxGradePercent") } : {}),
      };

      const h = computeHorizontal(built.design.alignment);
      const v = computeVertical(built.design.profile);
      const verdicts: unknown[] = [];

      curveRows(h).forEach((row, i) => {
        verdicts.push(judgeCurveRadius(Number(row.radiusFt), `curve ${i + 1}`, basis));
      });
      v.curves.forEach((c, i) => {
        verdicts.push(judgeVerticalCurveK(c, `PVI at station ${c.pviStation}`, basis));
        verdicts.push(judgeGrade(c.g1Percent, `grade into PVI ${i + 1}`, basis));
        verdicts.push(judgeGrade(c.g2Percent, `grade out of PVI ${i + 1}`, basis));
      });

      const failed = verdicts.filter((x) => (x as { status: string }).status === "fail");
      return {
        designSpeedMph: speed,
        basisUsed: {
          ...basis,
          note: "Illustrative defaults where not supplied. NOT an adopted agency standard.",
        },
        checked: verdicts.length,
        failed: failed.length,
        compliant: failed.length === 0,
        verdicts,
      };
    },
  );

  add(
    "export_landxml",
    "Export the design as LandXML 1.2, ready to import into Bentley OpenRoads Designer " +
      "(Geometry -> Import Geometry) or Autodesk Civil 3D as a native alignment and profile. " +
      "This export has been field-tested: ORD reproduced the curve table to 0.01 ft.",
    S.obj({}),
    () => {
      const form = host.readForm();
      const built = tryBuild(form);
      if (isRefusal(built)) return built;
      // The deliverable is the seal boundary. An agent may design the whole road
      // and still cannot produce the file an engineer would hand to ORD.
      const pending = host.pendingChanges();
      if (pending.length > 0) {
        return {
          refused: true,
          code: "AwaitingEngineerConfirmation",
          detail:
            `${pending.length} agent-proposed change(s) have not been confirmed by a licensed ` +
            `engineer. The design can be read and inspected, but the LandXML deliverable ` +
            `cannot be produced until a person confirms them in the Studio. ` +
            `There is deliberately no tool that clears this.`,
          measurements: { pendingCount: pending.length },
          pendingChanges: pending.map((c) => c.description),
          resolvedBy: [],
          authority: ["ADR: an agent can never be the confirming party"],
        };
      }
      const xml = toLandXML({
        name: built.design.name,
        alignment: built.design.alignment,
        profile: built.design.profile,
        crs: host.readCrs() as never,
      });
      return { lengthBytes: xml.length, landxml: xml };
    },
  );

  // --------------------------------------------------------------- WRITE TOOLS

  add(
    "propose_full_design",
    "Propose an ENTIRE road at once: project setup, all horizontal elements and all PVIs. " +
      "⛔ DESTRUCTIVE: this REPLACES the existing geometry wholesale (templates and drops are " +
      "kept). Preview it first and show the engineer what changes. " +
      "Use this when the engineer describes a road in words rather than editing one value. " +
      "You supply the parameters and your engineering rationale; the deterministic kernel " +
      "computes every station, curve and elevation, and validates the result. " +
      "Conventions: US survey feet; stations in feet (1000 = 10+00); startAzimuthDeg is " +
      "clockwise from north. The profile must span the alignment exactly -- the first PVI at " +
      "the begin station and the last at the computed end station -- and end PVIs carry no " +
      "vertical curve. Prefer radii generous for the design speed (45 mph about 710 ft " +
      "minimum, 55 mph about 1060 ft; 1.5-3x minimum where right-of-way allows) and keep " +
      "grades under about 6-8 percent. State the K values you targeted in the rationale.",
    S.obj({
      name: S.str("Alignment name."),
      rationale: S.str("Brief engineering rationale: why these radii, grades and K values."),
      beginStation: S.num("Begin station in feet."),
      startE: S.num("Start easting, US survey feet."),
      startN: S.num("Start northing, US survey feet."),
      startAzimuthDeg: S.num("Start heading, degrees clockwise from north (0-360)."),
      elements: {
        type: "array",
        description:
          "Horizontal elements in order. Each is {type:'tangent',length} or " +
          "{type:'arc',radius,deltaDeg,direction} or {type:'deflection',deflectionDeg,direction}.",
        items: { type: "object" },
      },
      pvis: {
        type: "array",
        description:
          "Vertical PVIs in increasing station order, each {station,elevation,curveLength?}. " +
          "At least two. The first and last must not carry curveLength.",
        items: { type: "object" },
      },
      commit: S.commit,
    }, ["name", "rationale", "beginStation", "startE", "startN", "startAzimuthDeg", "elements", "pvis"]),
    (args) => {
      const parsed = AiDesignProposal.safeParse(args);
      if (!parsed.success) {
        return {
          refused: true,
          code: "ProposalSchemaViolation",
          detail: "The proposal does not match the RoadDesign proposal schema.",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."), code: i.code, message: i.message,
          })),
          measurements: {},
          resolvedBy: ["propose_full_design"],
          authority: ["RoadDesign v0.2 proposal schema"],
        };
      }
      const current = host.readForm();
      const proposed = proposalToForm(parsed.data);
      // Templates and drops are the engineer's standing setup: a design proposal
      // replaces geometry, never the typical sections, unless asked separately.
      const next: StudioForm = {
        ...proposed,
        templates: current.templates,
        drops: current.drops.length > 0 ? current.drops : proposed.drops,
      };
      const result = applyOrPreview(host, next, args.commit === true, "propose full design");
      return isRefusal(result) ? result : { ...(result as object), rationale: parsed.data.rationale };
    },
  );

  add(
    "set_project_setup",
    "Set the project name, begin station, start coordinates and start heading. " +
      "startAzimuthDeg is degrees clockwise from north (0 = N, 90 = E, 180 = S, 270 = W). " +
      "Coordinates are US survey feet in the selected state plane zone; for Georgia West, " +
      "easting is around 2,200,000 and northing around 1,350,000.",
    S.obj({
      name: S.str("Alignment name."),
      beginStationFt: S.num("Begin station in feet; 1000 means station 10+00."),
      startEastingFt: S.num("Start easting, US survey feet."),
      startNorthingFt: S.num("Start northing, US survey feet."),
      startAzimuthDeg: S.num("Start heading, degrees clockwise from north."),
      commit: S.commit,
    }),
    (args) => {
      const next = clone(host.readForm());
      if (typeof args.name === "string") next.name = args.name;
      const b = readNumber(args, "beginStationFt"); if (b !== undefined) next.beginStation = b;
      const e = readNumber(args, "startEastingFt"); if (e !== undefined) next.startE = e;
      const n = readNumber(args, "startNorthingFt"); if (n !== undefined) next.startN = n;
      const a = readNumber(args, "startAzimuthDeg"); if (a !== undefined) next.startAzimuthDeg = a;
      return applyOrPreview(host, next, args.commit === true, "project setup");
    },
  );

  add(
    "add_horizontal_element",
    "Append a horizontal element to the alignment. Elements run in order from the start point. " +
      "A tangent is a straight run of a given length. An arc is a circular curve with a radius " +
      "and a delta (deflection angle) turning left or right. A deflection is an angle point and " +
      "is only legal for small bearing changes under 10 degrees. " +
      "Radius guidance: for 45 mph prefer about 710 ft minimum, 55 mph about 1060 ft, and use " +
      "1.5 to 3 times the minimum where right-of-way allows. " +
      "NOTE: adding an element lengthens the alignment, and the profile is stationed BY the " +
      "alignment -- so you will normally need set_pvi to move the last PVI to the new end station.",
    S.obj({
      type: S.enum(["tangent", "arc", "deflection"], "Element type."),
      lengthFt: S.num("Tangent length in feet. Required for type tangent."),
      radiusFt: S.num("Curve radius in feet. Required for type arc."),
      deltaDeg: S.num("Curve deflection angle in degrees, 0 to 180. Required for type arc."),
      deflectionDeg: S.num("Angle point deflection in degrees, under 10. Required for type deflection."),
      direction: S.enum(["left", "right"], "Turn direction for arc or deflection."),
      commit: S.commit,
    }, ["type"]),
    (args) => {
      const next = clone(host.readForm());
      const row = elementRowFrom(args);
      if ("error" in row) return row;
      next.elements.push(row.row);
      return applyOrPreview(host, next, args.commit === true, `add ${row.row.kind}`);
    },
  );

  add(
    "set_horizontal_element",
    "Change one existing horizontal element, identified by its 1-based index in the alignment. " +
      "Only the fields you supply change. Changing a tangent length or an arc radius or delta " +
      "moves the alignment end station, so the profile normally needs updating too.",
    S.obj({
      index: S.int("1-based index of the element to change."),
      lengthFt: S.num("New tangent length in feet."),
      radiusFt: S.num("New curve radius in feet."),
      deltaDeg: S.num("New curve delta in degrees."),
      direction: S.enum(["left", "right"], "New turn direction."),
      commit: S.commit,
    }, ["index"]),
    (args) => {
      const next = clone(host.readForm());
      const i = (readNumber(args, "index") ?? 0) - 1;
      if (i < 0 || i >= next.elements.length) {
        return outOfRange("element", i + 1, next.elements.length, ["read_design"]);
      }
      const row = next.elements[i]!;
      const len = readNumber(args, "lengthFt"); if (len !== undefined) row.length = String(len);
      const rad = readNumber(args, "radiusFt"); if (rad !== undefined) row.radius = String(rad);
      const dl = readNumber(args, "deltaDeg"); if (dl !== undefined) row.deltaDeg = String(dl);
      if (args.direction === "left" || args.direction === "right") row.direction = args.direction;
      return applyOrPreview(host, next, args.commit === true, `set element ${i + 1}`);
    },
  );

  add(
    "remove_horizontal_element",
    "Remove one horizontal element by its 1-based index. ⛔ DESTRUCTIVE: the element and its " +
      "authored values are gone, and there is no undo tool. Preview first. This also shortens " +
      "the alignment, so the profile's last PVI moves to the new end station.",
    S.obj({ index: S.int("1-based index of the element to remove."), commit: S.commit }, ["index"]),
    (args) => {
      const next = clone(host.readForm());
      const i = (readNumber(args, "index") ?? 0) - 1;
      if (i < 0 || i >= next.elements.length) {
        return outOfRange("element", i + 1, next.elements.length, ["read_design"]);
      }
      next.elements.splice(i, 1);
      return applyOrPreview(host, next, args.commit === true, `remove element ${i + 1}`);
    },
  );

  add(
    "set_pvi",
    "Change one point of vertical intersection by its 1-based index: its station, its elevation, " +
      "or its vertical curve length. The first and last PVI must sit exactly at the alignment " +
      "begin and end stations and must NOT carry a curve. Interior PVIs may carry a symmetric " +
      "parabolic curve; adjacent curves must not overlap. " +
      "K guidance: at 45 mph aim for K of at least 61 on crests and 79 in sags, and scale with speed.",
    S.obj({
      index: S.int("1-based index of the PVI."),
      stationFt: S.num("New PVI station in feet."),
      elevationFt: S.num("New PVI elevation in feet."),
      curveLengthFt: S.num("New vertical curve length in feet. Use 0 to remove the curve."),
      commit: S.commit,
    }, ["index"]),
    (args) => {
      const next = clone(host.readForm());
      const i = (readNumber(args, "index") ?? 0) - 1;
      if (i < 0 || i >= next.pvis.length) {
        return outOfRange("PVI", i + 1, next.pvis.length, ["read_design", "read_profile_table"]);
      }
      const row = next.pvis[i]!;
      const sta = readNumber(args, "stationFt"); if (sta !== undefined) row.station = String(sta);
      const el = readNumber(args, "elevationFt"); if (el !== undefined) row.elevation = String(el);
      const L = readNumber(args, "curveLengthFt");
      if (L !== undefined) row.curveLength = L === 0 ? "" : String(L);
      return applyOrPreview(host, next, args.commit === true, `set PVI ${i + 1}`);
    },
  );

  add(
    "add_pvi",
    "Insert a new PVI. PVIs are kept in increasing station order automatically. A new interior " +
      "PVI may carry a vertical curve; the end PVIs may not.",
    S.obj({
      stationFt: S.num("PVI station in feet."),
      elevationFt: S.num("PVI elevation in feet."),
      curveLengthFt: S.num("Optional vertical curve length in feet."),
      commit: S.commit,
    }, ["stationFt", "elevationFt"]),
    (args) => {
      const next = clone(host.readForm());
      const sta = readNumber(args, "stationFt");
      const el = readNumber(args, "elevationFt");
      if (sta === undefined || el === undefined) {
        return { error: true, code: "BadArgument", detail: "stationFt and elevationFt are required numbers" };
      }
      const L = readNumber(args, "curveLengthFt");
      const row: FormPviRow = { station: String(sta), elevation: String(el) };
      if (L !== undefined && L > 0) row.curveLength = String(L);
      next.pvis.push(row);
      next.pvis.sort((a, b) => Number(a.station) - Number(b.station));
      return applyOrPreview(host, next, args.commit === true, `add PVI at ${sta}`);
    },
  );

  add(
    "remove_pvi",
    "Remove a PVI by its 1-based index. ⛔ DESTRUCTIVE: its station, elevation and vertical " +
      "curve are gone, and there is no undo tool. Preview first. The first and last PVI define " +
      "the profile's span, so removing one normally leaves the profile no longer matching the " +
      "alignment.",
    S.obj({ index: S.int("1-based index of the PVI to remove."), commit: S.commit }, ["index"]),
    (args) => {
      const next = clone(host.readForm());
      const i = (readNumber(args, "index") ?? 0) - 1;
      if (i < 0 || i >= next.pvis.length) {
        return outOfRange("PVI", i + 1, next.pvis.length, ["read_design"]);
      }
      next.pvis.splice(i, 1);
      return applyOrPreview(host, next, args.commit === true, `remove PVI ${i + 1}`);
    },
  );

  add(
    "set_template_segment",
    "Change one segment of a roadway template: its width or its cross slope. Segments are listed " +
      "outward from the centreline on each side. A normal travel lane is 12 ft at -2 percent; " +
      "a shoulder is commonly 6.5 ft at -4 percent. Negative slope falls away from the centreline.",
    S.obj({
      template: S.str("Template name, e.g. \"2-lane\"."),
      side: S.enum(["left", "right"], "Which side of the centreline."),
      index: S.int("1-based segment index, counting outward from the centreline."),
      widthFt: S.num("New segment width in feet."),
      slopePercent: S.num("New cross slope in percent; negative falls away from centreline."),
      commit: S.commit,
    }, ["template", "side", "index"]),
    (args) => {
      const next = clone(host.readForm());
      const t = next.templates.find((x) => x.name === args.template);
      if (!t) {
        return { refused: true, code: "UnknownTemplate",
          detail: `No template named "${String(args.template)}".`,
          measurements: { templateCount: next.templates.length },
          resolvedBy: ["read_design"], authority: ["RoadDesign v0.2 templates"] };
      }
      const side = args.side === "left" ? "left" : "right";
      const i = (readNumber(args, "index") ?? 0) - 1;
      if (i < 0 || i >= t[side].length) {
        return outOfRange(`${side} segment`, i + 1, t[side].length, ["read_design"]);
      }
      const seg = t[side][i]!;
      const w = readNumber(args, "widthFt"); if (w !== undefined) seg.width = String(w);
      const sp = readNumber(args, "slopePercent"); if (sp !== undefined) seg.slopePercent = String(sp);
      return applyOrPreview(host, next, args.commit === true, `set ${args.template} ${side} segment ${i + 1}`);
    },
  );

  add(
    "set_template_drop",
    "Change which template applies over a station range, or where a drop boundary sits. " +
      "Drops are stationed by the alignment: the first begins at the alignment begin station and " +
      "the last ends at the alignment end station, which is derived and cannot be set.",
    S.obj({
      index: S.int("1-based index of the drop."),
      template: S.str("Template name to apply over this range."),
      toStationFt: S.num("Boundary station in feet. Ignored for the last drop, which is derived."),
      transitionLengthFt: S.num("Optional taper length in feet, blending from the previous template."),
      commit: S.commit,
    }, ["index"]),
    (args) => {
      const next = clone(host.readForm());
      const i = (readNumber(args, "index") ?? 0) - 1;
      if (i < 0 || i >= next.drops.length) {
        return outOfRange("drop", i + 1, next.drops.length, ["read_design"]);
      }
      const row = next.drops[i]!;
      if (typeof args.template === "string") row.template = args.template;
      const to = readNumber(args, "toStationFt");
      if (to !== undefined && i !== next.drops.length - 1) row.toStation = String(to);
      const tr = readNumber(args, "transitionLengthFt");
      if (tr !== undefined) row.transition = tr === 0 ? "" : String(tr);
      return applyOrPreview(host, next, args.commit === true, `set drop ${i + 1}`);
    },
  );

  // Attach the annotation policy. Nothing here reaches the network, so
  // openWorldHint is false for every tool without exception.
  return tools.map((t) => ({
    ...t,
    annotations: { openWorldHint: false, ...(ANNOTATIONS[t.name] ?? {}) },
  }));
}

function outOfRange(what: string, got: number, count: number, resolvedBy: string[]): Refusal {
  return {
    refused: true,
    code: "IndexOutOfRange",
    detail: `There is no ${what} ${got}; the design has ${count}.`,
    measurements: { requestedIndex: got, count },
    resolvedBy,
    authority: ["RoadDesign v0.2"],
  };
}

function elementRowFrom(
  args: Record<string, unknown>,
): { row: FormElementRow } | { error: true; code: string; detail: string } {
  const dir = args.direction === "left" ? "left" : "right";
  if (args.type === "tangent") {
    const l = readNumber(args, "lengthFt");
    if (l === undefined) return { error: true, code: "BadArgument", detail: "a tangent needs lengthFt" };
    return { row: { kind: "tangent", length: String(l) } };
  }
  if (args.type === "arc") {
    const r = readNumber(args, "radiusFt");
    const d = readNumber(args, "deltaDeg");
    if (r === undefined || d === undefined) {
      return { error: true, code: "BadArgument", detail: "an arc needs radiusFt and deltaDeg" };
    }
    return { row: { kind: "arc", radius: String(r), deltaDeg: String(d), direction: dir } };
  }
  if (args.type === "deflection") {
    const d = readNumber(args, "deflectionDeg");
    if (d === undefined) return { error: true, code: "BadArgument", detail: "a deflection needs deflectionDeg" };
    return { row: { kind: "deflection", deflectionDeg: String(d), direction: dir } };
  }
  return { error: true, code: "BadArgument", detail: 'type must be "tangent", "arc" or "deflection"' };
}

/** Register every tool. Returns the names registered. */
export function registerWebMcp(host: StudioHost): string[] {
  const mc = document.modelContext ?? navigator.modelContext;
  if (mc === undefined) return [];
  const tools = buildTools(host);
  for (const tool of tools) void mc.registerTool(tool);
  return tools.map((t) => t.name);
}
