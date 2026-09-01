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
import { transitionFor, crossSlopeAt,
  type SuperelevationTransition } from "../kernel/superelevation";
import type { RoadDesign, SuperelevationSpec } from "../schema/road-design";
import { AiDesignProposal, proposalToForm } from "./ai-design";
import { toStakingCsv, stakingRows } from "../exporters/staking";
import { evaluateAlternatives, type AlternativeInput } from "./alternatives";
import { fromDocument, toDocument,
  type DesignDocument } from "./design-document";
import { parseLandXML } from "../importers/landxml";
import { crsSelectionProblem } from "./crs";
import { summariseEarthwork, type GroundSample, type Tin } from "../kernel/terrain";
import { checkRoadside, lengthOf, roadsideQuantities, type RoadsideItem } from "../schema/roadside";
import type { DesignSectionSurface } from "../importers/design-sections";
import { summarisePlanFeatures, type PlanFeatureSet } from "../importers/plan-features";
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
  /**
   * ⛔ `description` is CANONICAL: the words the tool used, with no origin
   * label. The label belongs to presentation and is rendered from `inherited`.
   * Baking it into the text put it in the portable document, which then carried
   * a display string back in on the next open.
   */
  pendingChanges(): readonly {
    readonly id: number;
    readonly description: string;
    /** True when this arrived already unconfirmed, from a link or a reload. */
    readonly inherited?: boolean;
  }[];
  /** Called for EVERY tool invocation. This is what proves, from inside the
   *  tool surface, that an agent used WebMCP rather than driving the DOM. */
  onToolCall?(tool: string, result: unknown): void;
  /** Undo the most recent agent change. The host owns the history. */
  undoLastAgentChange(): { ok: true; description: string } | { ok: false; reason: string };
  /** The existing site: buildings, kerbs, lot lines, read from a survey LandXML. */
  planFeatures(): PlanFeatureSet | undefined;
  setPlanFeatures(f: PlanFeatureSet | undefined): void;
  /** As-designed cross sections read from an imported LandXML. */
  designSections(): readonly DesignSectionSurface[];
  setDesignSections(s: readonly DesignSectionSurface[]): void;
  /** The imported ground surface, if one has been loaded. */
  terrain(): Tin | undefined;
  /** Load or clear the ground surface. */
  setTerrain(tin: Tin | undefined): void;
  /** Ground against the design along the alignment, or undefined with no terrain. */
  groundProfile(intervalFt?: number): GroundSample[] | undefined;
  /** A link that reproduces the current design exactly. */
  shareLink(): string;
  /**
   * Set the coordinate reference system by zone key, e.g. GA-West.
   *
   * `agentChange` records it in the change ledger, exactly as writeForm does, so
   * the CRS participates in the same unconfirmed-change and undo workflow as
   * everything else. Without it a CRS change bypassed the ledger entirely and
   * undo silently acted on some older, unrelated change.
   */
  setCrs(
    zone: string,
    basis: "grid" | "ground",
    combinedScaleFactor?: number,
    agentChange?: string,
  ): boolean;
  /** The CRS zone keys this app offers. */
  crsZones(): readonly { readonly value: string; readonly label: string }[];
  /** Put a set of alternatives in front of the engineer. Applies nothing.
   *  The design speed goes through too: the engineer's panel must not show
   *  LESS than the agent's own response did. */
  offerAlternatives(
    question: string,
    alts: readonly AlternativeInput[],
    designSpeedMph?: number,
    emax?: number,
  ): number;
  /** The selected coordinate reference system, so LandXML matches the app exactly. */
  readCrs(): unknown;
  /**
   * Which build is serving this page.
   *
   * Optional so a test host need not fake it. Without this an independent tester
   * cannot tell which build answered -- a green result that cannot be attributed
   * to a commit is not evidence of a fix.
   */
  buildInfo?(): { commit: string; builtAt: string };
  /**
   * Re-record changes a loaded document says were never confirmed.
   *
   * Optional so a test host need not fake it. Without it, loading a document
   * through the tool surface keeps the incoming design but drops the fact that
   * part of it was never reviewed -- the browser load path already carries it.
   */
  recordInherited?(descriptions: readonly string[]): void;
  /**
   * Names and counts of the imported context this design was worked against,
   * whether or not it is currently loaded. Optional so a test host can skip it.
   */
  contextSummary?(): DesignDocument["context"];
  /**
   * Remember that a loaded document was worked against context we do not have,
   * so the app can say so instead of reopening silently on missing ground.
   */
  setKnownMissingContext?(ctx: DesignDocument["context"]): void;
  /**
   * Replace imported context layers, recording it as an agent change.
   *
   * Only the keys present are replaced. `agentChange` puts it in the ledger so a
   * context-only import can be undone -- it used to call the three setters
   * directly, so a terrain-only commit left pending at zero and undo had nothing
   * to act on while the new surface stayed loaded.
   */
  setImportedContext?(
    ctx: {
      terrain?: Tin;
      planFeatures?: PlanFeatureSet;
      designSections?: readonly DesignSectionSurface[];
    },
    agentChange?: string,
  ): void;
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

  // Read it back and prove the change survived.
  //
  // ⚠ This guard exists because set_segment_material once reported `committed`
  // while the value was silently discarded: FormSegmentRow had no `material`
  // field, so formToDesign dropped it on the floor. The tool lied, every test
  // passed, and only the 3D legend showed it. That is a CLASS of bug -- any
  // field added to the form and not threaded through the mapping vanishes the
  // same way -- so success is now measured rather than assumed.
  const readBack = tryBuild(host.readForm());
  if (isRefusal(readBack)) {
    return {
      error: true,
      code: "WriteNotReadable",
      detail: `The change was applied but the design no longer builds: ${readBack.detail}`,
    };
  }
  if (JSON.stringify(readBack.design) !== JSON.stringify(built.design)) {
    return {
      error: true,
      code: "LossyWrite",
      detail:
        `"${what}" was applied but did not survive the round trip -- the design read back ` +
        `differs from the one that was validated. Some authored field is being dropped ` +
        `between the form and the design. This is a defect in the app, not in your request.`,
    };
  }

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
 * The size of a string AS A FILE, in UTF-8 bytes.
 *
 * ⚠ String.length counts UTF-16 code units, which is not the size of anything
 * written to disk. The baseline staking CSV reported 1180 while the file was
 * 1186 bytes: every degree sign, en dash and accented place name in a survey
 * costs bytes the count never saw. A field named lengthBytes has to be bytes.
 */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Roadside furniture a wholesale replacement is about to remove.
 *
 * Both destructive paths -- import_landxml with an alignment, and
 * propose_full_design -- drop roadside items, because they are stationed
 * against the road being replaced. That is intended. Being SILENT about it was
 * not: the import path was fixed and the proposal path was left behind, so the
 * disclosure lives here and both call it.
 */
function roadsideRemovedBy(current: StudioForm): {
  removesRoadsideItems: number;
  removedRoadside?: { id: string; kind: string; side: string;
    beginStationFt: number; endStationFt: number }[];
} {
  const items = (current.roadside ?? []).map((r) => ({
    id: r.id, kind: r.kind, side: r.side,
    beginStationFt: r.beginStation, endStationFt: r.endStation,
  }));
  return {
    removesRoadsideItems: items.length,
    ...(items.length > 0 ? { removedRoadside: items } : {}),
  };
}

/** How many station rows one read_ground reply carries. */
const GROUND_PAGE = 60;

/**
 * One page of station samples, and the truth about the rest.
 *
 * ⚠ This used to be a bare `.slice(0, 60)`. The reply said `sampled: 106` and
 * carried 60 rows ending at station 3950 on a road that runs to 6225.29, with
 * nothing to say the tail was missing -- so an agent reading the last row
 * believed it had reached the end of the road and reasoned about cut and fill
 * that it had never been shown. Silently returning part of an answer is the
 * same defect class as silently ignoring a parameter.
 */
function pageOf(rows: readonly GroundSample[], fromStationFt: number | undefined): {
  samples: readonly GroundSample[];
  returned: number;
  returnedStationRangeFt: [number, number] | undefined;
  complete: boolean;
  nextFromStationFt?: number;
  truncation?: string;
} {
  // ⚠ findIndex returns -1 for "no station at or after that one". Clamping it
  // with Math.max(0, ...) turned that into index 0, so paging past the end of
  // the road silently served page ONE again -- an agent walking the pages would
  // loop forever and never learn it had finished.
  const found = fromStationFt === undefined
    ? 0
    : rows.findIndex((r) => r.station >= fromStationFt - 1e-6);
  const from = found === -1 ? rows.length : found;
  const page = rows.slice(from, from + GROUND_PAGE);
  const complete = from + page.length >= rows.length;
  const next = complete ? undefined : rows[from + page.length]!.station;
  if (page.length === 0) {
    return {
      samples: page,
      returned: 0,
      returnedStationRangeFt: undefined,
      complete: true,
      truncation:
        `No stations at or after ${fromStationFt}. The sampled road ends at ` +
        `${rows.length > 0 ? rows[rows.length - 1]!.station : "no stations"}; ` +
        "you have already seen the last page.",
    };
  }
  return {
    samples: page,
    returned: page.length,
    returnedStationRangeFt: page.length > 0
      ? [page[0]!.station, page[page.length - 1]!.station]
      : undefined,
    complete,
    ...(next !== undefined ? { nextFromStationFt: next } : {}),
    ...(complete ? {} : {
      truncation:
        `This reply carries ${page.length} of ${rows.length} stations, ending at ` +
        `${page[page.length - 1]!.station}. Call again with fromStationFt: ${next} for the ` +
        `next page, or ask for a wider intervalFt to see the whole road in one reply.`,
    }),
  };
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
  export_staking_csv: { title: "Export staking CSV", readOnlyHint: true, idempotentHint: true },
  read_design_document: { title: "Save or share the design", readOnlyHint: true, idempotentHint: true },
  read_coordinate_systems: { title: "List coordinate systems", readOnlyHint: true, idempotentHint: true },
  load_design_document: { title: "Load a design", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  import_landxml: { title: "Import a LandXML alignment", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  read_ground: { title: "Read cut and fill", readOnlyHint: true, idempotentHint: true },
  read_roadside: { title: "Read roadside furniture", readOnlyHint: true, idempotentHint: true },
  read_design_sections: { title: "Read as-designed sections", readOnlyHint: true, idempotentHint: true },
  read_site_features: { title: "Read the existing site", readOnlyHint: true, idempotentHint: true },
  place_roadside_item: { title: "Place roadside furniture", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  remove_roadside_item: { title: "Remove a roadside item", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  set_segment_material: { title: "Set a segment material", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  read_terrain_extent: { title: "Read the ground extent", readOnlyHint: true, idempotentHint: true },
  set_coordinate_system: { title: "Set the coordinate system", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  propose_alternatives: { title: "Offer the engineer options", readOnlyHint: true, idempotentHint: true },
  undo_last_change: { title: "Undo your last change", readOnlyHint: false, destructiveHint: false, idempotentHint: false },

  propose_full_design: { title: "Propose a whole road", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  set_project_setup: { title: "Set project setup", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  set_horizontal_element: { title: "Change an element", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  set_pvi: { title: "Change a PVI", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  set_template_segment: { title: "Change a template segment", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  // Destructive: it REPLACES a template's whole stack, so the previous one is
  // gone. Idempotent: the same stack applied twice is the same stack.
  set_pavement_layers: { title: "Set the pavement structure", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  read_pavement_layers: { title: "Read the pavement structure", readOnlyHint: true, idempotentHint: true },
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
        // Which build answered. A tester cannot attribute a result to a fix
        // without this, and hashing the tool catalogue only fingerprints the
        // contract -- two different builds with identical tool shapes hash the same.
        build: host.buildInfo?.() ?? { commit: "unknown", builtAt: "unknown" },
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
      atStation: S.num(
        "Optional station in feet. Returns the left and right cross slope THERE, plus which " +
          "phase of the rotation that station is in -- normal crown, runout, runoff, or full " +
          "super. Must lie within the alignment, and is range-checked even when no banking " +
          "policy is set. ⛔ With NO policy there is no banking anywhere, so no slopes are " +
          "returned: the cross slope is then the template's own and read_cross_section reports " +
          "the actual section.",
      ),
    }),
    (args) => {
      const form = host.readForm();
      const askedAt = readNumber(args, "atStation");
      if (!form.superelevation) {
        // ⚠ atStation is still VALIDATED with no policy, and the reply says where
        // the cross slope actually comes from. It used to return one generic note
        // for any station, in range or not, while the schema promised slopes
        // there -- so 999, 1000 and 6226 were indistinguishable.
        if (askedAt !== undefined) {
          const r = alignmentRangeFromForm(form);
          if (askedAt < r.begin - 1e-6 || askedAt > r.end + 1e-6) {
            return {
              refused: true,
              code: "StationOutsideAlignment",
              detail: `Station ${askedAt} is outside the alignment, which runs ${r.begin} to ` +
                `${Number(r.end.toFixed(4))} ft.`,
              measurements: { requestedStationFt: askedAt,
                beginStationFt: r.begin, endStationFt: Number(r.end.toFixed(4)) },
              resolvedBy: ["read_alignment_range"],
              authority: ["Alignment extents"],
            };
          }
        }
        return {
          enabled: false,
          ...(askedAt !== undefined ? { atStationFt: askedAt } : {}),
          note:
            "No superelevation policy, so there is no banking to report" +
            (askedAt !== undefined
              ? ` at station ${askedAt} or anywhere else. With no policy the cross slope is the` +
                " template's own, unchanged along the road -- read_cross_section returns the"
              : ". With no policy the cross slope is the template's own -- read_cross_section" +
                " returns the") +
            " actual section. Call set_superelevation to bank the curves.",
          resolvedBy: ["read_cross_section", "set_superelevation"],
        };
      }
      const built = tryBuild(form);
      if (isRefusal(built)) return built;
      const h = computeHorizontal(built.design.alignment);
      const spec = form.superelevation;
      const transitions: SuperelevationTransition[] = [];
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

      // ⚠ atStation was declared, documented -- "the cross slope of each side at
      // any station you ask about" -- and then dropped: this handler took no
      // args at all, so 0 and 750 returned byte-identical policy objects. The
      // kernel had crossSlopeAt() the whole time; nothing called it from here.
      const atStation = askedAt;
      if (atStation === undefined) {
        return { enabled: true, policy: spec, transitions };
      }
      const range = alignmentRangeFromForm(form);
      if (atStation < range.begin - 1e-6 || atStation > range.end + 1e-6) {
        return {
          refused: true,
          code: "StationOutsideAlignment",
          detail:
            `Station ${atStation} is outside the alignment, which runs ${range.begin} to ` +
            `${Number(range.end.toFixed(4))} ft. There is no cross slope there to report.`,
          measurements: { requestedStationFt: atStation,
            beginStationFt: range.begin, endStationFt: Number(range.end.toFixed(4)) },
          resolvedBy: ["read_alignment_range"],
          authority: ["Alignment extents"],
        };
      }
      const at = crossSlopeAt(atStation, transitions, spec);
      return {
        enabled: true,
        policy: spec,
        transitions,
        atStation: {
          stationFt: at.station,
          phase: at.phase,
          leftPercent: at.leftPercent,
          rightPercent: at.rightPercent,
          curveIndex: at.curveIndex,
        },
        note:
          `At station ${at.station} the section is in "${at.phase}": left ${at.leftPercent}%, ` +
          `right ${at.rightPercent}%. Negative is falling away from the centreline.`,
      };
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
        pending: pending.map((c) => ({
          id: c.id,
          description: c.description,
          inherited: c.inherited === true,
          // Rendered here, from the flag -- never stored in the description.
          origin: c.inherited === true
            ? "arrived already unconfirmed from a link or a reload; you have not reviewed it"
            : "authored in this session",
        })),
        deliverableBlocked: pending.length > 0,
        note: pending.length === 0
          ? "Nothing outstanding. The design is confirmed and can be exported."
          : "A person must confirm these in the Studio before LandXML can be produced.",
        authority: ["ADR: an agent can never be the confirming party"],
      };
    },
  );

  add(
    "undo_last_change",
    "Undo the most recent change YOU made, restoring the design exactly as it was before it. " +
      "\u26d4 This only works while the change is still unconfirmed. Once a licensed engineer has " +
      "confirmed your work you cannot silently revert it -- that would undo something a person " +
      "has already stood behind. Author a new, visible change instead, which lands in the ledger " +
      "and needs its own confirmation.",
    S.obj({}),
    () => {
      const r = host.undoLastAgentChange();
      if (r.ok) {
        return { undone: true, change: r.description,
          pendingEngineerConfirmation: host.pendingChanges().length,
          note: "The design is back to its state before that change." };
      }
      const confirmed = r.reason === "last-change-confirmed";
      return {
        refused: true,
        code: confirmed ? "ChangeAlreadyConfirmed" : "NothingToUndo",
        detail: confirmed
          ? "The most recent change has been confirmed by a licensed engineer. An agent cannot " +
            "revert confirmed work. Author a new change instead."
          : "There is no agent-authored change to undo.",
        measurements: { pendingCount: host.pendingChanges().length },
        resolvedBy: confirmed ? [] : ["read_pending_changes"],
        authority: ["ADR: an agent can never be the confirming party"],
      };
    },
  );

  add(
    "propose_alternatives",
    "Offer the engineer two to four DIFFERENT versions of the design and let them choose. " +
      "Each alternative is a complete road plus a short rationale; the app computes every one " +
      "honestly -- length, curve count, tightest radius, lowest K, and criteria compliance at a " +
      "design speed -- and shows them side by side. " +
      "\u26d4 NOTHING is applied, and there is deliberately no tool that adopts an alternative: " +
      "ranking them needs judgement about site, budget and right-of-way that you do not have, " +
      "and choosing one is the decision a licensed engineer is paid to make. Present the " +
      "comparison and let them pick. " +
      "Use this when the engineer asks an open question -- what are my options for this curve, " +
      "show me a cheaper alignment -- rather than naming a specific value.",
    S.obj({
      question: S.str("The choice being put to the engineer, e.g. three alignments for the river crossing."),
      designSpeedMph: S.num("Optional. When given, each alternative is also judged against it."),
      emax: S.num("Maximum superelevation rate as a decimal for the criteria check. Default 0.06."),
      alternatives: {
        type: "array",
        description:
          "Two to four alternatives. Each is { label, rationale, design } where design has the " +
          "same shape propose_full_design takes: name, beginStation, startE, startN, " +
          "startAzimuthDeg, elements, pvis.",
        items: { type: "object" },
      },
    }, ["question", "alternatives"]),
    (args) => {
      const raw = Array.isArray(args.alternatives) ? args.alternatives : [];
      if (raw.length < 2 || raw.length > 4) {
        return { error: true, code: "BadArgument",
          detail: "propose_alternatives needs between 2 and 4 alternatives; got " + raw.length + "." };
      }
      const current = host.readForm();
      const parsed: AlternativeInput[] = [];
      for (let i = 0; i < raw.length; i += 1) {
        const a = raw[i] as Record<string, unknown>;
        const design = (a.design ?? a) as Record<string, unknown>;
        const check = AiDesignProposal.safeParse({
          ...design,
          rationale: String(a.rationale ?? design.rationale ?? ""),
        });
        if (!check.success) {
          return {
            refused: true,
            code: "AlternativeSchemaViolation",
            detail: "Alternative " + (i + 1) + " (" + String(a.label ?? "unlabelled") +
              ") does not match the design schema.",
            issues: check.error.issues.map((x) => ({ path: x.path.join("."), message: x.message })),
            measurements: { alternativeIndex: i },
            resolvedBy: ["propose_alternatives"],
            authority: ["RoadDesign v0.2 proposal schema"],
          };
        }
        const form = proposalToForm(check.data);
        parsed.push({
          label: String(a.label ?? "option " + (i + 1)),
          rationale: check.data.rationale,
          // The engineer's standing typical sections are theirs, not the agent's to swap.
          form: { ...form, templates: current.templates, drops: current.drops },
        });
      }
      const speed = readNumber(args, "designSpeedMph");
      const emax = readNumber(args, "emax") ?? 0.06;
      const evaluated = evaluateAlternatives(parsed, speed, emax);
      const shown = host.offerAlternatives(
        String(args.question ?? "Choose an alternative"), parsed, speed, emax);
      return {
        offered: shown,
        question: String(args.question ?? ""),
        appliedAnything: false,
        alternatives: evaluated,
        note:
          "Shown to the engineer for a decision. Nothing has changed. There is no tool that " +
          "adopts one -- a person clicks the option they want.",
      };
    },
  );

  add(
    "export_staking_csv",
    "Export construction staking: for every station at the interval you choose, the coordinates " +
      "and elevation of the centreline and of each template point, as CSV a survey crew can load. " +
      "Offsets are signed -- negative left of centreline, positive right. " +
      "This is the file a crew physically sets the road out from, so like the LandXML it is " +
      "refused until a licensed engineer has confirmed every outstanding change.",
    S.obj({
      intervalFt: S.num("Station interval in feet. 25 or 50 is typical; 10 for tight urban work."),
      includeOffsets: { type: "boolean",
        description: "false gives centreline only. Default true (every template point)." },
    }, ["intervalFt"]),
    (args) => {
      const interval = readNumber(args, "intervalFt");
      if (interval === undefined || interval <= 0) {
        return { error: true, code: "BadArgument", detail: "intervalFt must be a positive number." };
      }
      const built = tryBuild(host.readForm());
      if (isRefusal(built)) return built;
      const pending = host.pendingChanges();
      if (pending.length > 0) {
        return {
          refused: true,
          code: "AwaitingEngineerConfirmation",
          detail: pending.length + " agent-proposed change(s) are unconfirmed. Staking data is " +
            "what a crew builds from, so it cannot be produced until a licensed engineer " +
            "confirms them in the Studio. There is deliberately no tool that clears this.",
          measurements: { pendingCount: pending.length },
          pendingChanges: pending.map((c) => c.description),
          resolvedBy: [],
          authority: ["ADR: an agent can never be the confirming party"],
        };
      }
      const includeOffsets = args.includeOffsets !== false;
      const opts = { intervalFt: interval, includeOffsets };
      // ⛔ One source. The CRS rides the form into the design, so this export,
      // the LandXML, the saved document and the Studio's own download all read
      // the same value. They used to disagree: the human download passed a CRS
      // the tool path never did, so the agent's CSV said "CRS not set" while the
      // LandXML carried EPSG:2240.
      const rows = stakingRows(built.design, opts);
      const csv = toStakingCsv(built.design, opts);
      return { pointCount: rows.length, intervalFt: interval, includeOffsets,
        coordinateSystem: built.design.crs ?? null,
        lengthBytes: utf8ByteLength(csv), lengthChars: csv.length, csv };
    },
  );

  add(
    "read_design_document",
    "Read the whole design as a portable document, plus a link that reproduces it exactly. " +
      "Send that link to the licensed engineer who has to review and seal the work -- it carries " +
      "the entire design in the URL fragment, so nothing is uploaded anywhere and no account is " +
      "needed. Use this whenever the engineer asks to save, share, hand off or keep a copy.",
    S.obj({}),
    () => {
      const form = host.readForm();
      const built = tryBuild(form);
      // The document carries what is still UNCONFIRMED. A design handed on with
      // that stripped arrives looking reviewed, which is how unconfirmed agent
      // work would reach a deliverable through a link.
      const unconfirmed = host.pendingChanges().map((c) => c.description);
      const url = host.shareLink();
      // ⛔ The document must carry the context summary too. It was built without
      // it, so a design read as JSON, loaded elsewhere and re-shared lost all
      // trace of the ground it was fitted to -- while the share URL beside it
      // carried it. Two serialisations of one design disagreeing is the same
      // defect as two exports disagreeing about the CRS.
      // ⛔ The document carries the context summary too. It was built without
      // it, so a design read as JSON, loaded elsewhere and re-shared lost all
      // trace of the ground it was fitted to -- while the share URL beside it
      // carried it. Two serialisations of one design disagreeing is the same
      // defect as two exports disagreeing about the CRS.
      const doc = toDocument(form, undefined, unconfirmed, host.contextSummary?.());
      return {
        document: doc,
        designedAgainstContext: doc.context,
        shareUrl: url,
        shareUrlLength: url.length,
        // ⚠ A link long enough to carry a design can disable WebMCP on the page
        // it opens. Measured on one browser connector: a 64 KiB configuration
        // budget, with the page URL repeated once per tool -- so at 37 tools
        // every URL character costs 37 bytes and the ceiling arrives at ~814
        // characters. A design fragment is 1,300+.
        //
        // This is not something the page can shrink its way out of: with every
        // tool description removed the ceiling would still be ~1,771 characters,
        // below the smallest real design link. Reported rather than worked
        // around, because the design itself travels fine -- it is the AGENT
        // surface on the recipient's page that may not come with it.
        agentSurfaceOnSharedPage:
          url.length > 800
            ? "The design in this link opens and edits normally in the Studio, but the link is " +
              "long enough that some browser connectors will refuse to enable WebMCP on the page " +
              "it opens -- an agent may not be able to drive the design there. Hand the link to " +
              "a person; do not assume you can follow it."
            : "short enough that the agent surface should come with it",
        valid: !isRefusal(built),
        unconfirmedCarried: unconfirmed.length,
        note: "The link carries the design in the fragment, which browsers never send to a server." +
          (unconfirmed.length > 0
            ? ` It also carries ${unconfirmed.length} unconfirmed change(s): whoever opens it sees` +
              " them as still awaiting a licensed engineer, because your confirmation is not theirs."
            : ""),
      };
    },
  );

  add(
    "load_design_document",
    "Replace the current design with one from a saved document or a shared link. " +
      "\u26d4 DESTRUCTIVE: everything currently on screen is replaced. Preview first (omit commit) " +
      "to see what the incoming design computes to before you apply it. " +
      "Accepts either the document read_design_document returns, or the bare design inside it.",
    S.obj({
      document: { type: "object",
        description: "The document to load, as returned by read_design_document." },
      commit: S.commit,
    }, ["document"]),
    (args) => {
      const loaded = fromDocument(args.document);
      if (!loaded.ok) {
        return {
          refused: true,
          code: "DocumentNotLoadable",
          detail: `That document cannot be loaded: ${loaded.reason}.`,
          measurements: {},
          resolvedBy: ["read_design_document"],
          authority: ["RoadDesign document v1"],
        };
      }
      const result = applyOrPreview(host, loaded.form, args.commit === true,
        loaded.savedAt ? `loaded a design saved ${loaded.savedAt}` : "loaded a design");
      if (isRefusal(result)) return result;
      if (args.commit === true && loaded.unconfirmed.length > 0) {
        host.recordInherited?.(loaded.unconfirmed);
      }
      // The incoming design's context summary comes with it: this app does not
      // have that ground, and the engineer needs to know the design was fitted
      // to it. Parsed here since v2 and previously thrown away.
      if (args.commit === true && loaded.context !== undefined) {
        host.setKnownMissingContext?.(loaded.context);
      }
      return {
        ...(result as object),
        // ⚠ Recounted AFTER the inherited entries land. applyOrPreview reports
        // the count as it stood when it ran, so the reply said 2 while
        // read_pending_changes said 4 a moment later. A tool that disagrees with
        // the reader about the gate is worse than one that stays quiet.
        ...(args.commit === true
          ? { pendingEngineerConfirmation: host.pendingChanges().length }
          : {}),
        inheritsUnconfirmed: loaded.unconfirmed.length,
        ...(loaded.context !== undefined ? { designedAgainstContext: loaded.context } : {}),
        ...(loaded.unconfirmed.length > 0
          ? {
              inheritedUnconfirmed: loaded.unconfirmed,
              note:
                `That document carries ${loaded.unconfirmed.length} change(s) its author had not ` +
                "had confirmed. They stay unconfirmed here: a confirmation belongs to the " +
                "engineer who gave it, on the design they were looking at. The deliverable " +
                "remains blocked until a licensed engineer confirms them in this Studio.",
            }
          : {}),
      };
    },
  );

  add(
    "set_coordinate_system",
    "Set the project coordinate reference system. This is what georeferences the LandXML, so " +
      "OpenRoads or Civil 3D places the alignment in the right part of the world rather than at " +
      "an arbitrary origin. Call read_coordinate_systems first to see the zones this project " +
      "offers. Grid coordinates are state-plane; ground coordinates are scaled to surface " +
      "distances, which is what a survey crew measures.",
    S.obj({
      zone: S.str(
        "Zone key, e.g. GA-West. Get the list from read_coordinate_systems. Pass an EMPTY " +
          "STRING for local coordinates -- no georeferencing, which is what the Studio's " +
          "\"None\" option selects.",
      ),
      basis: S.enum(["grid", "ground"], "Grid (state plane) or ground (surface) distances."),
      combinedScaleFactor: S.num(
        "REQUIRED when basis is \"ground\": ground distances are grid distances divided by " +
          "this. Ground coordinates without it cannot be reconciled with a grid or with what " +
          "a survey crew measures, and the schema refuses them.",
      ),
      commit: S.commit,
    }, ["zone"]),
    (args) => {
      const zone = String(args.zone ?? "");
      const known = host.crsZones().map((z) => z.value);
      // "" is local coordinates, which the Studio offers as "None". Refusing it
      // here left the human able to choose something the agent could not --
      // a parity breach in the direction that is easy to miss.
      if (zone !== "" && !known.includes(zone)) {
        return {
          refused: true,
          code: "UnknownCoordinateZone",
          detail: `"${zone}" is not one of the zones this project offers.`,
          measurements: { zoneCount: known.length },
          available: known,
          resolvedBy: ["read_coordinate_systems"],
          authority: ["Project CRS"],
        };
      }
      const basis = args.basis === "ground" ? "ground" : "grid";
      const csf = readNumber(args, "combinedScaleFactor");
      // ⛔ A ground CRS with no scale factor is refused rather than written and
      // left to fail later. The UI had no control for it at all, so "ground"
      // produced a coordinate system the app's own schema rejects -- it only
      // escaped because the CRS never reached the design to be validated.
      const problem = crsSelectionProblem({ zone, basis, ...(csf !== undefined
        ? { combinedScaleFactor: csf } : {}) });
      if (problem) {
        return {
          refused: true,
          code: basis === "ground" && csf === undefined
            ? "GroundBasisNeedsScaleFactor" : "InvalidCoordinateSystem",
          detail: problem,
          measurements: { ...(csf !== undefined ? { combinedScaleFactor: csf } : {}) },
          resolvedBy: ["set_coordinate_system"],
          authority: ["RoadDesign v0.2 crs"],
        };
      }

      const change = zone === ""
        ? "coordinate system cleared to local coordinates"
        : `coordinate system ${zone} (${basis}` +
          `${csf !== undefined ? `, CSF ${csf}` : ""})`;
      if (args.commit !== true) {
        return { previewed: true, committed: false, change,
          note: "Nothing changed. Call again with commit: true to apply." };
      }
      const ok = host.setCrs(zone, basis, csf, change);
      return ok
        ? { committed: true, change,
            provenance: AGENT_PROVENANCE,
            pendingEngineerConfirmation: host.pendingChanges().length,
            note: "Both exports and the saved design document now carry this coordinate " +
              "system. It is stamped agent-proposed and undo_last_change reverts it." }
        : { error: true, code: "BridgeFault", detail: "the CRS control rejected that value" };
    },
  );

  add(
    "read_coordinate_systems",
    "List the coordinate reference systems this project offers, and which one is selected. " +
      "The CRS georeferences the LandXML export.",
    S.obj({}),
    () => ({ available: host.crsZones(), selected: host.readCrs() ?? null }),
  );

  add(
    "import_landxml",
    "Read an existing alignment out of a LandXML file and load it as the design. This is how a " +
      "road that already exists -- in OpenRoads, in Civil 3D, in a survey deliverable -- gets in " +
      "here, instead of starting from scratch. " +
      "Give it the file's text. If the file holds several alignments, name the one you want or " +
      "take the first. " +
      "\u26d4 DESTRUCTIVE: this replaces the current design. Preview first (omit commit). " +
      "\u26d4 It REFUSES rather than approximating: a file using spiral transitions is rejected " +
      "with the count, because this kernel models tangents and circular curves only and quietly " +
      "dropping a spiral would change the geometry of a road somebody is going to build. " +
      "Metric files are converted to US survey feet and say so.",
    S.obj({
      xml: S.str("The full text of the LandXML file."),
      alignmentName: S.str("Optional. Which alignment to take when the file holds several."),
      commit: S.commit,
    }, ["xml"]),
    (args) => {
      const xml = typeof args.xml === "string" ? args.xml : "";
      if (xml.trim() === "") {
        return { error: true, code: "BadArgument", detail: "xml must be the text of a LandXML file." };
      }
      const parsed = parseLandXML(xml);
      if (!parsed.ok) {
        return {
          refused: true,
          code: parsed.code,
          detail: parsed.detail,
          measurements: parsed.measurements ?? {},
          resolvedBy: [],
          authority: ["LandXML 1.1 / 1.2"],
        };
      }
      const committing = args.commit === true;

      // Which CONTEXT LAYERS does this file actually carry?
      //
      // A file replaces the layers it has and leaves the others alone. Terrain,
      // site features and as-designed sections routinely arrive in SEPARATE
      // files -- ground from one export, the survey from another -- so wiping a
      // layer because a different file happens to lack it destroys imported work
      // for no engineering reason. Terrain was already guarded this way; the
      // other two were not, which is exactly how an alignment-only import
      // silently cleared an imported survey.
      const carries = {
        terrain: parsed.surfaces.length > 0,
        siteFeatures: parsed.planFeatures.features.length > 0,
        designSections: parsed.designSections.length > 0,
      };
      const applyContext = (agentChange?: string): void => {
        const ctx = {
          ...(carries.terrain ? { terrain: parsed.surfaces[0]! } : {}),
          ...(carries.siteFeatures ? { planFeatures: parsed.planFeatures } : {}),
          ...(carries.designSections ? { designSections: parsed.designSections } : {}),
        };
        if (host.setImportedContext) {
          host.setImportedContext(ctx, agentChange);
          return;
        }
        // Hosts that predate the transactional setter still get the layers.
        if (ctx.terrain) host.setTerrain(ctx.terrain);
        if (ctx.planFeatures) host.setPlanFeatures(ctx.planFeatures);
        if (ctx.designSections) host.setDesignSections(ctx.designSections);
      };
      const contextLayers = {
        replaces: Object.entries(carries).filter(([, v]) => v).map(([k]) => k),
        leavesAlone: Object.entries(carries).filter(([, v]) => !v).map(([k]) => k),
      };

      // A file with no alignment still carries CONTEXT worth having: a survey is
      // mostly plan features, and a terrain export is mostly a surface. Refusing
      // it for want of an alignment threw away the whole reason to open it.
      if (parsed.alignments.length === 0) {
        const tin = parsed.surfaces[0];
        const loaded: string[] = [];
        if (tin) loaded.push(`ground surface "${tin.name}" (${tin.faces.length} triangles)`);
        if (parsed.planFeatures.features.length > 0) {
          loaded.push(`${parsed.planFeatures.features.length} site features`);
        }
        if (parsed.designSections.length > 0) {
          loaded.push(`${parsed.designSections.length} as-designed section surface(s)`);
        }
        if (loaded.length === 0) {
          return {
            refused: true,
            code: "NothingToImport",
            detail: "That file has no alignment, no surface and no plan features.",
            measurements: {},
            resolvedBy: [],
            authority: ["LandXML 1.1 / 1.2"],
          };
        }

        const report = {
          groundSurface: tin
            ? { name: tin.name, triangles: tin.faces.length, points: tin.points.length }
            : undefined,
          siteFeatures: parsed.planFeatures.features.length,
          siteExtentFt: parsed.planFeatures.bounds,
          designSectionSurfaces: parsed.designSections.length,
          contextLayers,
        };

        // ⚠ This branch used to load the context and report committed: true
        // whatever `commit` said, so a preview mutated the page. Preview is the
        // default for every other write tool in this surface; an import that
        // ignores it is not a lesser bug for being an import.
        if (!committing) {
          return {
            previewed: true,
            committed: false,
            change: `would load ${loaded.join(" and ")}`,
            ...report,
            note:
              "Nothing changed. Call again with commit: true to apply. That file carries no " +
              "alignment, so committing loads context only -- the site as it already is -- and " +
              "leaves the design untouched.",
          };
        }
        applyContext(`loaded ${loaded.join(" and ")}`);
        return {
          committed: true,
          change: `loaded ${loaded.join(" and ")}`,
          pendingEngineerConfirmation: host.pendingChanges().length,
          ...report,
          provenance: AGENT_PROVENANCE,
          note:
            "That file carried context but no alignment, so nothing was designed -- this is the " +
            "site as it already is. Place an alignment inside the extent above to design into it.",
        };
      }

      const wanted = typeof args.alignmentName === "string" ? args.alignmentName : undefined;
      const picked = wanted
        ? parsed.alignments.find((a) => a.name === wanted)
        : parsed.alignments[0];
      if (!picked) {
        return {
          refused: true,
          code: "AlignmentNotInFile",
          detail: `That file has no alignment called "${String(wanted)}".`,
          measurements: { alignmentCount: parsed.alignments.length },
          available: parsed.alignments.map((a) => a.name),
          resolvedBy: ["import_landxml"],
          authority: ["LandXML 1.1 / 1.2"],
        };
      }

      const current = host.readForm();
      // A profile must span the alignment; an imported file often carries none, or
      // one stationed differently. Rather than refuse the whole import, seed a flat
      // profile at the imported extents and say so -- the engineer then authors the
      // real one, which is the honest division of labour.
      const pvis = picked.pvis.length >= 2
        ? picked.pvis.map((v) => ({
            station: String(v.station),
            elevation: String(v.elevation),
            ...(v.curveLength !== undefined ? { curveLength: String(v.curveLength) } : {}),
          }))
        : [
            { station: String(picked.beginStation), elevation: "0" },
            { station: String(picked.beginStation + 1), elevation: "0" },
          ];

      const next: StudioForm = {
        name: picked.name,
        beginStation: picked.beginStation,
        startE: picked.start.e,
        startN: picked.start.n,
        startAzimuthDeg: picked.startAzimuthDeg,
        elements: picked.elements.map((el) =>
          el.type === "tangent"
            ? { kind: "tangent" as const, length: String(el.length) }
            : el.type === "arc"
              ? { kind: "arc" as const, radius: String(el.radius),
                  deltaDeg: String(el.deltaDeg), direction: el.direction }
              : { kind: "deflection" as const, deflectionDeg: String(el.deflectionDeg),
                  direction: el.direction }),
        pvis,
        // The engineer's typical sections are theirs; a LandXML alignment carries none.
        templates: current.templates,
        drops: current.drops,
      };

      // ⛔ A new alignment brings a new station range, so roadside furniture
      // stationed against the OLD one cannot be carried across: a guardrail at
      // 20+00-34+00 may not exist on the road that replaces it. Clearing is the
      // honest default for a destructive replacement -- but it must be SAID, in
      // the preview as well as the commit, and not discovered afterwards.
      const removed = roadsideRemovedBy(current);
      const droppedRoadside = removed.removedRoadside ?? [];

      const result = applyOrPreview(host, next, committing,
        `imported "${picked.name}" from LandXML`);
      if (isRefusal(result)) return result;
      // Context follows the SAME preview/commit contract as the geometry, and
      // only after the write has been validated and proved to round-trip. It
      // used to run before this call and unconditionally, so a preview replaced
      // the terrain and the survey it was only supposed to describe.
      // No agentChange here: applyOrPreview already recorded this import, and its
      // snapshot was taken before the context moved, so one undo puts both back.
      if (committing) applyContext();

      return {
        ...(result as object),
        contextLayers,
        ...removed,
        importedFrom: {
          alignmentName: picked.name,
          alignmentsInFile: parsed.alignments.map((a) => a.name),
          sourceUnit: picked.sourceUnit,
          elementCount: picked.elements.length,
          pviCount: picked.pvis.length,
          notes: [
            ...picked.notes,
            ...(picked.pvis.length < 2
              ? ["the file carried no usable profile; a flat placeholder was seeded, author the real one"]
              : []),
            "cross-section templates are yours, not the file's -- LandXML alignments carry none",
            ...(droppedRoadside.length > 0
              ? [`${droppedRoadside.length} roadside item(s) are stationed against the road being ` +
                 `replaced and are REMOVED by this import; undo_last_change restores them`]
              : []),
            ...(contextLayers.leavesAlone.length > 0
              ? [`this file carries no ${contextLayers.leavesAlone.join(", ")}; those layers are ` +
                 `left exactly as they are rather than cleared`]
              : []),
          ],
        },
      };
    },
  );

  add(
    "read_ground",
    "Read the existing ground under the road: for each station, the ground elevation, the design " +
      "elevation, and the difference. POSITIVE is FILL (the road sits above ground), NEGATIVE is " +
      "CUT (it sits below). Also returns the extremes and the balance points where the road " +
      "crosses ground level. " +
      "Stations that fall outside the surveyed surface report no ground rather than a guess -- a " +
      "road can run past the edge of a survey, and inventing ground there is how a design gets " +
      "built wrong. Requires a ground surface: import one with import_landxml.",
    S.obj({
      fromStationFt: S.num(
        "Start the returned rows at this station. Replies carry at most " + String(GROUND_PAGE) +
          " stations; when the road needs more, the reply says so and gives the station to " +
          "resume from. The summary figures always describe the WHOLE road, not the page.",
      ),
      intervalFt: S.num(
        "Station interval to sample at, in feet. Default 50. Stations land on whole multiples " +
          "of this from the begin station -- 50 gives 25+00, 25+50, 26+00 -- the way cross " +
          "sections are cut on a plan set. The end station is always sampled, so the LAST " +
          "interval is usually shorter than the rest. Sampling is capped at 400 stations, so on " +
          "a long road the step is widened to fit; intervalFt in the reply is the step actually " +
          "used and requestedIntervalFt is what was asked for.",
      ),
    }),
    (args) => {
      const tin = host.terrain();
      if (!tin) {
        return {
          refused: true,
          code: "NoGroundSurface",
          detail:
            "No existing ground has been loaded. Import a LandXML containing a TIN surface with " +
            "import_landxml; cut and fill cannot be computed against nothing.",
          measurements: {},
          resolvedBy: ["import_landxml"],
          authority: ["Existing ground"],
        };
      }
      // A nonsense interval is refused rather than quietly replaced by the default:
      // an agent that asked for 0 ft and silently got 50 ft would report a spacing
      // it never requested and cannot detect.
      const requested = readNumber(args, "intervalFt");
      if (requested !== undefined && !(requested > 0)) {
        return { error: true, code: "BadArgument",
          detail: "intervalFt must be greater than zero." };
      }
      const intervalFt = requested ?? 50;
      const samples = host.groundProfile(intervalFt);
      if (!samples) {
        return { error: true, code: "BridgeFault", detail: "ground could not be sampled" };
      }
      const summary = summariseEarthwork(samples);
      // The station cap can widen the spacing past what was asked for. Measure what
      // actually came back rather than echoing the request: reporting a 25 ft
      // interval while serving 50 ft is the failure this tool already had once.
      const effectiveFt = samples.length >= 2
        ? Number((samples[1]!.station - samples[0]!.station).toFixed(3))
        : undefined;
      const widened = effectiveFt !== undefined && effectiveFt > intervalFt + 1e-6;
      return {
        surface: { name: tin.name, triangles: tin.faces.length, points: tin.points.length },
        requestedIntervalFt: intervalFt,
        intervalFt: effectiveFt,
        ...summary,
        note: [
          summary.offSurface > 0
            ? `${summary.offSurface} of ${summary.sampled} stations fall outside the surveyed ` +
              `surface and report no ground.`
            : "Every station sits on the surveyed surface.",
          widened
            ? `Sampling is capped at 400 stations, so the ${intervalFt} ft interval you asked ` +
              `for was widened to ${effectiveFt} ft.`
            : undefined,
        ].filter(Boolean).join(" "),
        // ⛔ Off-surface stations are RETURNED, not filtered out. The tool's own
        // description promises they "report no ground rather than a guess", and
        // dropping them broke that: a road running past the edge of a survey
        // came back as a shorter road with no gap in it.
        ...pageOf(samples, readNumber(args, "fromStationFt")),
      };
    },
  );

  add(
    "read_terrain_extent",
    "Read the bounds of the loaded ground surface, and whether the alignment sits inside it. " +
      "Use this before reasoning about cut and fill: a road that leaves the survey has no ground " +
      "to be compared against for part of its length.",
    S.obj({}),
    () => {
      const tin = host.terrain();
      if (!tin) return { loaded: false, note: "No ground surface. Import one with import_landxml." };
      const b = tin.bounds;
      const samples = host.groundProfile();
      const off = samples ? samples.filter((s) => s.groundZ === undefined).length : undefined;
      const app = tin.appearance;
      return {
        loaded: true,
        name: tin.name,
        triangles: tin.faces.length,
        points: tin.points.length,
        // What the file said about how this surface looks, and what was done
        // with it. Held so a reference that cannot be painted is still visible
        // rather than silently dropped.
        appearance: app ? {
          source: app.source,
          colorHex: `#${app.colorHex.toString(16).padStart(6, "0")}`,
          note: app.note,
          authoredMaterialRegions: app.regionCount,
          // Two DIFFERENT facts, kept apart: what this surface's boundaries
          // point at, and what the file declares. A file can declare a
          // symbol-only material no boundary uses, and reporting only the
          // referenced subset made it vanish.
          authoredMaterials: app.authoredMaterials?.map((m) => ({
            index: m.index,
            color: m.color ? `rgb(${m.color.join(",")})` : undefined,
            textureImageRef: m.textureImageRef,
            symbolRef: m.symbolRef,
            rendered: app.source === "authored-material" && !!m.color,
          })),
          declaredMaterials: app.declaredMaterials?.map((m) => ({
            index: m.index,
            color: m.color ? `rgb(${m.color.join(",")})` : undefined,
            textureImageRef: m.textureImageRef,
            symbolRef: m.symbolRef,
            referencedByThisSurface:
              (app.authoredMaterials ?? []).some((r) => r.index === m.index),
          })),
          declaredMaterialCount: app.declaredMaterials?.length,
        } : undefined,
        boundsFt: {
          northing: [b.minN, b.maxN], easting: [b.minE, b.maxE], elevation: [b.minZ, b.maxZ],
        },
        stationsOffSurface: off,
        alignmentFullyOnSurface: off === 0,
      };
    },
  );

  add(
    "place_roadside_item",
    "Place guardrail, concrete barrier, a pavement marking or curb along the road, between two " +
      "stations, on one side, at an offset from the centreline. It is drawn in 3D exactly where " +
      "you put it. " +
      "Offset is a positive distance -- side carries the direction. A pavement marking must state " +
      "its pattern, because solid and dashed mean different things to a driver. " +
      "\u26d4 This tool does NOT decide whether a guardrail is WARRANTED. Warrant depends on fill " +
      "height, side slope and clear zone, and is a judgement a licensed engineer is paid to make. " +
      "You may place what the engineer asks for and report what you placed; you may not conclude " +
      "that a road needs protection.",
    S.obj({
      id: S.str("Short stable id, e.g. gr-left-1. Used to change or remove this item later."),
      kind: S.enum(["guardrail", "concrete-barrier", "pavement-marking", "curb"], "What it is."),
      side: S.enum(["left", "right"], "Which side of the centreline it runs along."),
      beginStationFt: S.num("Station where it starts, in feet."),
      endStationFt: S.num("Station where it ends, in feet. Must be greater than the start."),
      offsetFt: S.num("Distance from centreline in feet, always positive."),
      heightFt: S.num("Height above the road surface in feet. Defaults by kind."),
      pattern: S.enum(["solid", "dashed", "double-solid"], "Required for a pavement marking."),
      note: S.str("Optional note, e.g. a standard detail number."),
      commit: S.commit,
    }, ["id", "kind", "side", "beginStationFt", "endStationFt", "offsetFt"]),
    (args) => {
      const next = clone(host.readForm());
      const begin = readNumber(args, "beginStationFt");
      const end = readNumber(args, "endStationFt");
      const offset = readNumber(args, "offsetFt");
      if (begin === undefined || end === undefined || offset === undefined) {
        return { error: true, code: "BadArgument",
          detail: "beginStationFt, endStationFt and offsetFt must all be numbers." };
      }
      const item: RoadsideItem = {
        id: String(args.id ?? ""),
        kind: args.kind as RoadsideItem["kind"],
        side: args.side === "left" ? "left" : "right",
        beginStation: begin,
        endStation: end,
        offsetFt: offset,
        ...(readNumber(args, "heightFt") !== undefined ? { heightFt: readNumber(args, "heightFt") } : {}),
        ...(typeof args.pattern === "string" ? { pattern: args.pattern as RoadsideItem["pattern"] } : {}),
        ...(typeof args.note === "string" ? { note: args.note } : {}),
      };
      next.roadside = [...(next.roadside ?? []), item];

      const range = alignmentRangeFromForm(next);
      const problems = checkRoadside(next.roadside, range.begin, range.end);
      if (problems.length > 0) {
        const p0 = problems[0]!;
        return {
          refused: true, code: p0.code, detail: p0.detail,
          measurements: p0.measurements, allProblems: problems,
          resolvedBy: ["place_roadside_item", "read_roadside"],
          authority: ["RoadDesign v0.2 roadside"],
        };
      }
      const result = applyOrPreview(host, next, args.commit === true,
        `place ${item.kind} "${item.id}" ${item.side} ${begin}-${end} at ${offset} ft`);
      return isRefusal(result) ? result
        : { ...(result as object), placed: { ...item, lengthFt: lengthOf(item) } };
    },
  );

  add(
    "remove_roadside_item",
    "Remove one roadside item by its id. \u26d4 DESTRUCTIVE: the item and its authored placement " +
      "are gone. Preview first.",
    S.obj({ id: S.str("The item's id."), commit: S.commit }, ["id"]),
    (args) => {
      const next = clone(host.readForm());
      const id = String(args.id ?? "");
      const before = next.roadside ?? [];
      const after = before.filter((r) => r.id !== id);
      if (after.length === before.length) {
        return {
          refused: true, code: "NoSuchRoadsideItem",
          detail: `Nothing on the roadside is called "${id}".`,
          measurements: { itemCount: before.length },
          available: before.map((r) => r.id),
          resolvedBy: ["read_roadside"],
          authority: ["RoadDesign v0.2 roadside"],
        };
      }
      next.roadside = after;
      return applyOrPreview(host, next, args.commit === true, `remove roadside item "${id}"`);
    },
  );

  add(
    "read_roadside",
    "Read every roadside item on the design, with a quantity take-off by kind -- count and total " +
      "length in feet, which is what goes on a bid schedule. Also reports any placement problems.",
    S.obj({}),
    () => {
      const form = host.readForm();
      const items = form.roadside ?? [];
      let problems: unknown[] = [];
      try {
        const range = alignmentRangeFromForm(form);
        problems = checkRoadside(items, range.begin, range.end);
      } catch { /* an invalid alignment is reported by what_do_i_need */ }
      return {
        count: items.length,
        items: items.map((r) => ({ ...r, lengthFt: lengthOf(r) })),
        quantities: roadsideQuantities(items),
        problems,
        note: items.length === 0
          ? "Nothing has been placed. That means none was authored, not that none is needed."
          : undefined,
      };
    },
  );

  add(
    "set_segment_material",
    "State what a template segment is made of -- asphalt, concrete, gravel, grass or earth. The " +
      "3D view draws each material differently and puts an edge line where pavement meets " +
      "something that is not pavement. " +
      "\u26d4 Material is never inferred from a segment's NAME: a shoulder is asphalt on one " +
      "project and gravel on the next, and guessing would put a surface on the drawing that " +
      "nobody authored. A segment with no material stated is drawn neutrally.",
    S.obj({
      template: S.str("Template name, e.g. 2-lane."),
      side: S.enum(["left", "right"], "Which side of the centreline."),
      index: S.int("1-based segment index, counting outward from the centreline."),
      material: S.enum(["asphalt", "concrete", "gravel", "grass", "earth"], "What it is made of."),
      commit: S.commit,
    }, ["template", "side", "index", "material"]),
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
      t[side][i]!.material = args.material as NonNullable<typeof t[typeof side][number]["material"]>;
      return applyOrPreview(host, next, args.commit === true,
        `${args.template} ${side} segment ${i + 1} is ${args.material}`);
    },
  );

  add(
    "read_design_sections",
    "Read the AS-DESIGNED cross sections that came with an imported LandXML -- the surfaces the " +
      "original designer produced, station by station, each named and sided. On a real file these " +
      "are the pavement structure: a wearing course, a formation level, and the ground beneath. " +
      "\u26a0 Not every named surface is roadway. Width tells them apart, and is reported for each: " +
      "on the file this was measured against, the wearing course spans 38.6 ft and the soil " +
      "section spans 10,208 ft. Narrowest first, so the pavement comes to hand. " +
      "\u26d4 These are REFERENCE, not your design. They are the original designer's sections, held " +
      "separately so they cannot be confused with the corridor this app sweeps from a template.",
    S.obj({}),
    () => {
      const sections = host.designSections();
      if (sections.length === 0) {
        return { loaded: false,
          note: "No as-designed sections. Import a LandXML that carries CrossSect elements." };
      }
      return {
        loaded: true,
        count: sections.length,
        surfaces: sections.map((d) => ({
          name: d.name,
          stationCount: d.stationCount,
          maxWidthFt: d.maxWidthFt,
          offsetRangeFt: [d.minOffsetFt, d.maxOffsetFt],
          elevationRangeFt: [d.minElevationFt, d.maxElevationFt],
          looksLikeRoadway: d.maxWidthFt < 200,
          // The designer's own point codes, verbatim, with the uncoded count
          // beside them. On the measured file one surface carries 2,873 coded
          // points and 221 uncoded, and another carries 4,499 with no code at
          // all -- a reader that only reported codes would describe the second
          // surface as having nothing on it.
          pointCodes: d.codes,
          codedPointCount: d.codedPointCount,
          uncodedPointCount: d.uncodedPointCount,
          displayedInViewer: d.maxWidthFt < 200,
        })),
        note:
          "looksLikeRoadway is a width test, not a reading of the name -- surface names are in " +
          "whatever language the designer used. Point codes are carried EXACTLY as written and " +
          "are never interpreted: they group and label, and nothing maps a code to a material or " +
          "an engineering meaning. Only roadway-width surfaces are drawn in the 3D view; the " +
          "rest are parsed and reported here.",
      };
    },
  );

  add(
    "read_site_features",
    "Read the EXISTING site imported from a survey LandXML -- buildings, kerbs, sidewalks, lot " +
      "lines, edge of pavement. This is what is already on the ground before anything is designed, " +
      "and it is the context a new alignment has to fit into. " +
      "Returns the site extent, so you can place an alignment inside it rather than guessing at " +
      "coordinates. " +
      "\u26d4 Feature names are carried exactly as the file wrote them and are NOT interpreted. " +
      "\"BLDG1|1094\" is a building on one survey and could be anything on the next; the grouping " +
      "in the summary is a label taken from the file's own separator, not a classification.",
    S.obj({}),
    () => {
      const set = host.planFeatures();
      if (!set || set.features.length === 0) {
        return { loaded: false,
          note: "No site features. Import a survey LandXML carrying PlanFeature elements." };
      }
      return {
        loaded: true,
        featureCount: set.features.length,
        pointCount: set.features.reduce((n, f) => n + f.points.length, 0),
        unresolvedRefs: set.unresolvedRefs,
        siteExtentFt: set.bounds,
        groups: summarisePlanFeatures(set),
        note:
          set.unresolvedRefs > 0
            ? `${set.unresolvedRefs} point reference(s) could not be resolved and those segments ` +
              `were dropped rather than drawn to a guessed position.`
            : "Every point reference resolved.",
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
        // From the DESIGN, not from a separate host call. The CRS is part of the
        // form now, so formToDesign has already put it here and validated it.
        crs: built.design.crs as never,
      });
      // ⛔ Authored pavement layers are NOT in the file, and that is said out
      // loud. LandXML 1.2 has no standard place for a course stack, and
      // inventing a vendor Property to claim export support would produce a
      // file that only this app can read while looking like an interchange.
      const stacked = built.design.templates
        ? Object.values(built.design.templates).filter((t) => (t.pavementLayers?.length ?? 0) > 0)
        : [];
      return {
        lengthBytes: utf8ByteLength(xml),
        lengthChars: xml.length,
        ...(stacked.length > 0
          ? {
              omittedFromFile: {
                pavementLayers: stacked.map((t) => ({
                  template: t.name,
                  layerCount: t.pavementLayers!.length,
                })),
                why:
                  "LandXML 1.2 has no standard element for an authored pavement course stack. " +
                  "Rather than invent a vendor-specific property that only this app could read, " +
                  "the layers are left out of the file. They remain in the design, in the shared " +
                  "document and in read_pavement_layers.",
              },
            }
          : {}),
        landxml: xml,
      };
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
      const removed = roadsideRemovedBy(current);
      const result = applyOrPreview(host, next, args.commit === true, "propose full design");
      return isRefusal(result) ? result : {
        ...(result as object),
        rationale: parsed.data.rationale,
        ...removed,
        ...(removed.removesRoadsideItems > 0
          ? {
              note:
                `⛔ This replaces the road wholesale, so ${removed.removesRoadsideItems} ` +
                "roadside item(s) stationed against the current alignment are REMOVED. " +
                "undo_last_change restores them.",
            }
          : {}),
      };
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
      deltaDeg: S.num(
        "Curve deflection angle in degrees. Greater than 0 and LESS THAN 180 -- at exactly "
          + "180 the two tangents are parallel, never meet, and the tangent and external "
          + "distances are undefined. Required for type arc.",
      ),
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
      stationFt: S.num(
        "New PVI station in feet. ⛔ NOT settable on the FIRST or LAST PVI: those are derived " +
          "from the alignment, and passing a different value is refused rather than quietly " +
          "normalised. Change the road's begin station or its element lengths instead.",
      ),
      elevationFt: S.num("New PVI elevation in feet. Settable on every PVI, endpoints included."),
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
      const sta = readNumber(args, "stationFt");

      // ⛔ The first and last PVI stations are DERIVED from the alignment -- the
      // profile is stationed BY the road it describes -- so they are not
      // independently settable. This used to accept the value, write it, have it
      // normalised back on the way through, and report `committed: true` with
      // the saved endpoint unchanged: a no-op disguised as an honoured request.
      // Refuse instead, and say which number would actually move it.
      const isEndpoint = i === 0 || i === next.pvis.length - 1;
      if (sta !== undefined && isEndpoint) {
        const range = alignmentRangeFromForm(next);
        const derived = i === 0 ? range.begin : range.end;
        if (Math.abs(sta - derived) > 0.01) {
          return {
            refused: true,
            code: "DerivedStationNotSettable",
            detail:
              `PVI ${i + 1} is the ${i === 0 ? "first" : "last"} PVI, so its station is derived ` +
              `from the alignment and is ${Number(derived.toFixed(4))} ft, not ${sta}. The ` +
              `profile is stationed by the road it describes. To move it, change the road: ` +
              `the begin station, or the element lengths that set where it ends.`,
            measurements: {
              requestedStationFt: sta,
              derivedStationFt: Number(derived.toFixed(4)),
              differenceFt: Number((sta - derived).toFixed(4)),
              beginStationFt: range.begin,
              endStationFt: Number(range.end.toFixed(4)),
            },
            resolvedBy: i === 0
              ? ["set_project_setup"]
              : ["set_horizontal_element", "add_horizontal_element", "remove_horizontal_element"],
            authority: ["Profile is stationed by the alignment"],
          };
        }
      }

      if (sta !== undefined) row.station = String(sta);
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
    "read_pavement_layers",
    "Read the AUTHORED pavement structure of every template: the ordered courses an engineer " +
      "stated, top course first, with each thickness in inches exactly as authored and the total. " +
      "⛔ Nothing here is designed or recommended. This app does not compute a required " +
      "structure, a structural number, a pavement life, or compliance with any standard -- it " +
      "reports what a person stated and what it adds up to. A template with no stack has not had " +
      "one authored; that is not a claim that it needs none.",
    S.obj({}),
    () => {
      const form = host.readForm();
      return {
        templates: form.templates.map((t) => {
          const layers = (t.pavementLayers ?? []).map((L) => ({
            name: L.name,
            thicknessIn: Number(L.thicknessIn),
            material: L.material && L.material.trim() !== "" ? L.material : undefined,
          }));
          return {
            template: t.name,
            layerCount: layers.length,
            layers,
            totalThicknessIn: layers.reduce((a, L) => a + L.thicknessIn, 0),
            authored: layers.length > 0,
          };
        }),
        note:
          "Order is the structure, top course first. Thicknesses are inches, exactly as " +
          "authored. NO structural adequacy was calculated: this is a record of what the " +
          "engineer stated, not an assessment of whether it is sufficient.",
        authority: ["Authored by the engineer; not a pavement design"],
      };
    },
  );

  add(
    "set_pavement_layers",
    "Replace one template's COMPLETE ordered pavement structure. Give the courses top first, " +
      "each with a name and a thickness in inches, and optionally the material as free text. " +
      "⛔ DESTRUCTIVE: this replaces the whole stack, it does not merge into it. Preview " +
      "first (omit commit). An EMPTY array is a deliberate remove-all. " +
      "⛔ This is AUTHORING, not designing. Do not propose a structure as though the app had " +
      "computed one: thicknesses come from the engineer or from a standard they are applying, " +
      "and nothing here checks adequacy. Material is free text and is never inferred from a " +
      "layer's name. Duplicate names are allowed -- order is what identifies a course.",
    S.obj({
      template: S.str("Which template's structure to replace. See read_design or read_pavement_layers."),
      layers: {
        type: "array",
        description:
          "The complete stack, TOP COURSE FIRST. Each item is " +
          "{name, thicknessIn, material?}. thicknessIn is inches and must be greater than zero. " +
          "An empty array removes every layer.",
        items: { type: "object" },
      },
      commit: S.commit,
    }, ["template", "layers"]),
    (args) => {
      const next = clone(host.readForm());
      const name = String(args.template ?? "");
      const ti = next.templates.findIndex((t) => t.name === name);
      if (ti < 0) {
        return {
          refused: true,
          code: "TemplateNotFound",
          detail: `No template called "${name}".`,
          measurements: { templateCount: next.templates.length },
          available: next.templates.map((t) => t.name),
          resolvedBy: ["read_design", "read_pavement_layers"],
          authority: ["RoadDesign v0.2 templates"],
        };
      }
      if (!Array.isArray(args.layers)) {
        return { error: true, code: "BadArgument",
          detail: "layers must be an array; pass [] to remove every layer." };
      }

      const rows: { name: string; thicknessIn: string; material?: string }[] = [];
      for (const [i, raw] of (args.layers as unknown[]).entries()) {
        if (typeof raw !== "object" || raw === null) {
          return { error: true, code: "BadArgument",
            detail: `layer ${i + 1} is not an object.` };
        }
        const L = raw as Record<string, unknown>;
        const lname = typeof L.name === "string" ? L.name.trim() : "";
        if (lname === "") {
          return { error: true, code: "BadArgument",
            detail: `layer ${i + 1} needs a name -- the engineer's own word for the course.` };
        }
        const th = L.thicknessIn;
        if (typeof th !== "number" || !Number.isFinite(th) || th <= 0) {
          return {
            refused: true,
            code: "PavementThicknessNotPositive",
            detail: `Layer ${i + 1} ("${lname}") has thickness ${String(th)}. A course must ` +
              "have a finite thickness greater than zero: a zero or negative course is not a " +
              "thin course, and this app never supplies one for you.",
            measurements: { layerIndex: i + 1, thicknessIn: typeof th === "number" ? th : null },
            resolvedBy: ["set_pavement_layers"],
            authority: ["RoadDesign v0.2 pavement layer"],
          };
        }
        const mat = typeof L.material === "string" && L.material.trim() !== ""
          ? L.material.trim() : undefined;
        rows.push({ name: lname, thicknessIn: String(th), ...(mat ? { material: mat } : {}) });
      }

      const before = next.templates[ti]!.pavementLayers ?? [];
      if (rows.length > 0) next.templates[ti]!.pavementLayers = rows;
      else delete next.templates[ti]!.pavementLayers;

      const total = rows.reduce((a, L) => a + Number(L.thicknessIn), 0);
      const what = rows.length > 0
        ? `set ${rows.length} pavement layer(s) on "${name}"`
        : `removed all pavement layers from "${name}"`;
      const result = applyOrPreview(host, next, args.commit === true, what);
      return isRefusal(result) ? result : {
        ...(result as object),
        template: name,
        replacedLayerCount: before.length,
        layers: rows.map((L) => ({
          name: L.name, thicknessIn: Number(L.thicknessIn), material: L.material,
        })),
        totalThicknessIn: total,
        note:
          "Authored, not designed. No structural adequacy, pavement life, structural number or " +
          "standard compliance was calculated. " +
          (before.length > 0 && rows.length > 0
            ? `The previous ${before.length}-layer stack was replaced, not merged; ` +
              "undo_last_change restores it."
            : before.length > 0
              ? `All ${before.length} layer(s) were removed; undo_last_change restores them.`
              : ""),
      };
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
