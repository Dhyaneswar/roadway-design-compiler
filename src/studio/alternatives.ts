// Design alternatives — the agent generates options, the engineer chooses.
//
// This is the shape of human-agent collaboration that actually fits engineering
// practice. A designer rarely wants "the answer"; they want two or three defensible
// options with the trade-offs computed, so they can apply judgement to the one that
// suits the site, the budget and the right-of-way they can actually get.
//
// So an agent may PROPOSE a set of alternatives, and the app computes each one
// honestly -- length, curve table, criteria compliance at the stated design speed --
// without applying any of them. Nothing changes until a person picks one.
//
// ⛔ There is deliberately no "adopt the best alternative" tool. Ranking these
// requires judgement about context the model does not have, and adopting one is
// exactly the decision a licensed engineer is paid to make.

import { computeHorizontal } from "../kernel/horizontal";
import { computeVertical } from "../kernel/vertical";
import { judgeCurveRadius, judgeGrade, judgeVerticalCurveK, type Verdict } from "../kernel/criteria";
import type { StudioForm } from "./form-to-design";
import { isRefusal, tryBuild, type Refusal } from "./webmcp-refusals";

export interface AlternativeInput {
  /** Short name the engineer will see on the button. */
  label: string;
  /** Why the agent thinks this one is worth considering. */
  rationale: string;
  /** The design this alternative would produce. */
  form: StudioForm;
}

export interface EvaluatedAlternative {
  label: string;
  rationale: string;
  /** Present when this alternative does not validate -- it is still shown. */
  refusal?: Refusal;
  alignmentLengthFt?: number;
  endStationFt?: number;
  curveCount?: number;
  /** Tightest radius in the alternative, the number that usually decides it. */
  minRadiusFt?: number;
  /** Lowest K, the vertical equivalent. */
  minK?: number;
  criteriaChecked?: number;
  criteriaFailed?: number;
  /** The failing verdicts, so the engineer sees WHY rather than just a count. */
  failures?: Verdict[];
}

/**
 * Evaluate each alternative against the kernel and, when a design speed is given,
 * against the criteria. Never mutates anything: each alternative is measured on
 * its own copy and discarded.
 */
export function evaluateAlternatives(
  alternatives: readonly AlternativeInput[],
  designSpeedMph?: number,
  emax = 0.06,
): EvaluatedAlternative[] {
  return alternatives.map((alt) => {
    const built = tryBuild(JSON.parse(JSON.stringify(alt.form)) as StudioForm);
    if (isRefusal(built)) {
      return { label: alt.label, rationale: alt.rationale, refusal: built };
    }
    const h = computeHorizontal(built.design.alignment);
    const v = computeVertical(built.design.profile);

    const radii: number[] = [];
    for (const el of h.elements) {
      if (el.type === "arc" && el.curve !== undefined) radii.push(el.curve.radius);
    }
    const ks = v.curves.map((c) => c.K);

    const out: EvaluatedAlternative = {
      label: alt.label,
      rationale: alt.rationale,
      alignmentLengthFt: Number(h.length.toFixed(3)),
      endStationFt: Number((built.design.alignment.beginStation + h.length).toFixed(3)),
      curveCount: radii.length,
      minRadiusFt: radii.length > 0 ? Math.min(...radii) : undefined,
      minK: ks.length > 0 ? Number(Math.min(...ks).toFixed(2)) : undefined,
    };

    if (designSpeedMph !== undefined && designSpeedMph > 0) {
      const basis = { designSpeedMph, emax };
      const verdicts: Verdict[] = [];
      h.elements.forEach((el, i) => {
        if (el.type === "arc" && el.curve !== undefined) {
          verdicts.push(judgeCurveRadius(el.curve.radius, `curve ${i + 1}`, basis));
        }
      });
      v.curves.forEach((c, i) => {
        verdicts.push(judgeVerticalCurveK(c, `PVI at ${c.pviStation}`, basis));
        verdicts.push(judgeGrade(c.g1Percent, `grade into PVI ${i + 1}`, basis));
        verdicts.push(judgeGrade(c.g2Percent, `grade out of PVI ${i + 1}`, basis));
      });
      const failures = verdicts.filter((x) => x.status === "fail");
      out.criteriaChecked = verdicts.length;
      out.criteriaFailed = failures.length;
      out.failures = failures;
    }
    return out;
  });
}

/** Alternatives currently on the table, awaiting an engineer's choice. */
export class AlternativeSet {
  /** The speed these were judged at, so the panel can say so. */
  designSpeedMph?: number;
  private question = "";
  private evaluated: EvaluatedAlternative[] = [];
  private forms: StudioForm[] = [];

  offer(question: string, inputs: readonly AlternativeInput[], evaluated: EvaluatedAlternative[]): void {
    this.question = question;
    this.evaluated = evaluated;
    this.forms = inputs.map((a) => a.form);
  }

  get prompt(): string {
    return this.question;
  }

  list(): readonly EvaluatedAlternative[] {
    return this.evaluated;
  }

  /** The form behind one alternative, by index. Only a person calls this path. */
  formAt(index: number): StudioForm | undefined {
    return this.forms[index];
  }

  count(): number {
    return this.evaluated.length;
  }

  clear(): void {
    this.designSpeedMph = undefined;
    this.question = "";
    this.evaluated = [];
    this.forms = [];
  }
}
