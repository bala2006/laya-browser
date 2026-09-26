/**
 * The deterministic-rule policy layer applied AROUND the narrow Laya decision.
 *
 * This encodes the AUTHORITATIVE laya-ultrafast design lesson: Laya answers NARROW
 * questions reliably (which element? which operation for THIS control?) but is NOT good at
 * the open-ended "what should I do next?". So the working policy is:
 *
 *   1. Fill the values the goal states, mapping each to a field. (rule: TYPE_TEXT the first
 *      goal-implied field that is not yet filled.)
 *   2. After typing into / opening a control, prefer choosing from the options that just
 *      appeared. (rule: if the last action opened a combobox/select with options, SELECT
 *      the goal-implied option.)
 *   3. Submit, then open/verify the named item. (rule: once every goal-stated field is
 *      filled, CLICK the submit/search control.)
 *
 * These rules SEED or OVERRIDE the operation when they are high-confidence-deterministic,
 * while Laya continues to resolve the narrow element/target choices for everything else.
 *
 * Everything here is a PURE function over {@link PageState} (+ the engine {@link Decision}).
 * The goal<->control heuristics are reused from {@link ../laya/goal} (NOT re-implemented) so
 * the stub engine, the loop, and this policy layer stay consistent.
 */
import type { Control, Decision, FieldFill, PageState } from "../types.js";
import {
  fieldValueFromGoal,
  goalSuccessMarkerPresent,
  isSubmitControl,
  unfilledGoalFields,
} from "../laya/goal.js";

/** Confidence assigned to a high-confidence deterministic rule decision. */
export const RULE_CONFIDENCE = 0.97;

/** A rule-produced seed decision plus a short human-readable justification. */
export interface PolicySeed {
  decision: Decision;
  reason: string;
}

/** Whether a control is an editable text-like field. */
function isTextField(c: Control): boolean {
  if (!c.editable) return false;
  return (
    c.role === "textbox" ||
    c.role === "searchbox" ||
    c.tag === "input" ||
    c.tag === "textarea"
  );
}

/** Whether a control offers a discrete set of options to choose from. */
function isChoiceControl(c: Control): boolean {
  if (c.disabled) return false;
  return (
    c.role === "combobox" ||
    c.role === "listbox" ||
    c.tag === "select" ||
    (c.options !== undefined && c.options.length > 0)
  );
}

/**
 * Whether the most recent action touched (typed into / opened) the given control.
 *
 * We match on the control's ref appearing in the last recorded action line; the loop records
 * actions as e.g. `TYPE_TEXT e5 = "..."` / `CLICK e5 (...)`, so a ref-substring match tells us
 * the previous step interacted with this control.
 */
function lastActionTouched(state: PageState, ref: string): boolean {
  const last = state.recentActions.at(-1);
  if (!last) return false;
  return last.includes(ref);
}

/**
 * Compute the deterministic seed decision for the current state, if any rule fires.
 *
 * Returns `undefined` when no rule is confident enough to seed/override (in which case the
 * loop falls back to the narrow Laya decision). The rules are evaluated in the documented
 * order so that filling precedes choosing-from-appeared-options precedes submitting.
 */
export function policySeed(state: PageState): PolicySeed | undefined {
  // Rule 0: if the goal's success marker already shows on the page, we are DONE.
  if (goalSuccessMarkerPresent(state)) {
    return {
      decision: {
        operation: "DONE",
        operationConfidence: RULE_CONFIDENCE,
        targetConfidence: 1,
        source: "rule",
      },
      reason: "Goal success marker already present on the page.",
    };
  }

  // Rule 2 (checked before rule 1 so a freshly-opened control is handled first):
  // after typing into / opening a choice control, prefer choosing from the options that
  // just appeared.
  for (const c of state.controls) {
    if (!isChoiceControl(c)) continue;
    if (!lastActionTouched(state, c.ref)) continue;
    const value = fieldValueFromGoal(c, state.goal, state.controls);
    if (value === undefined) continue;
    const current = (c.value ?? "").trim();
    if (current === value.trim()) continue;
    return {
      decision: {
        operation: "SELECT",
        operationConfidence: RULE_CONFIDENCE,
        target: c.ref,
        targetConfidence: RULE_CONFIDENCE,
        value,
        source: "rule",
      },
      reason: `Choosing ${JSON.stringify(value)} from the options that appeared on ${c.ref}.`,
    };
  }

  // Rule 1a (the "faster" batch): when the goal maps to TWO OR MORE editable fields that are
  // still unfilled, fill them ALL in a single FILL_FORM step instead of emitting N sequential
  // TYPE_TEXT steps (each of which would otherwise be its own snapshot+decide+execute cycle).
  // This is the concrete faster-automation mechanism: fewer steps, no per-field round-trip.
  const unfilled = unfilledGoalFields(state.goal, state.controls);
  if (unfilled.length >= 2) {
    const fields: FieldFill[] = unfilled.map((f) => ({ target: f.control.ref, value: f.value }));
    return {
      decision: {
        operation: "FILL_FORM",
        operationConfidence: RULE_CONFIDENCE,
        targetConfidence: RULE_CONFIDENCE,
        fields,
        source: "rule",
      },
      reason: `Batch-filling ${fields.length} goal-stated fields in one FILL_FORM step (${fields
        .map((f) => f.target)
        .join(", ")}).`,
    };
  }

  // Rule 1b: a single goal-implied field is still empty -> fill just it (keep the one-field
  // path unchanged so a single-field goal does not pay batch overhead).
  for (const c of state.controls) {
    if (!isTextField(c)) continue;
    const value = fieldValueFromGoal(c, state.goal, state.controls);
    if (value === undefined) continue;
    const current = (c.value ?? "").trim();
    if (current === value.trim()) continue; // already filled
    return {
      decision: {
        operation: "TYPE_TEXT",
        operationConfidence: RULE_CONFIDENCE,
        target: c.ref,
        targetConfidence: RULE_CONFIDENCE,
        value,
        source: "rule",
      },
      reason: `Filling goal-stated value ${JSON.stringify(value)} into ${c.ref}.`,
    };
  }

  // Rule 3: submit once the goal's fields are filled.
  //
  // This is deliberately robust so that a low-confidence run (where typing was driven by the
  // model/LLM rather than Rule 1) still progresses to a CLICK instead of re-typing forever:
  //
  //   (a) every goal-stated field that DID map to a control is already filled, OR
  //   (b) the goal has search intent and the plausible search field already holds the
  //       goal's search value,
  // and in either case a submit control exists.
  //
  // Because Rule 1 runs first and returns as soon as any goal field is still empty, reaching
  // this point already implies no goal-mapped field is unfilled — so submitting here never
  // races ahead of filling.
  const submit = state.controls.find(isSubmitControl);
  if (submit) {
    const goalFields = state.controls.filter(
      (c) => isTextField(c) && fieldValueFromGoal(c, state.goal, state.controls) !== undefined,
    );
    const allMappedFilled =
      goalFields.length > 0 &&
      goalFields.every(
        (c) =>
          (c.value ?? "").trim() ===
          (fieldValueFromGoal(c, state.goal, state.controls) ?? "").trim(),
      );
    if (allMappedFilled) {
      return {
        decision: {
          operation: "CLICK",
          operationConfidence: RULE_CONFIDENCE,
          target: submit.ref,
          targetConfidence: RULE_CONFIDENCE,
          source: "rule",
        },
        reason: `All goal-stated fields filled; submitting via ${submit.ref}.`,
      };
    }
  }

  return undefined;
}

/**
 * Refine the engine's narrow decision with deterministic knowledge.
 *
 * Laya picks the operation + target; this fills in the concrete VALUE for TYPE_TEXT/SELECT
 * from the goal when the engine did not supply one, keeping Laya's element/target choice
 * authoritative. Returns the (possibly value-enriched) decision unchanged in shape.
 */
export function refineWithGoalValue(decision: Decision, state: PageState): Decision {
  if (decision.operation !== "TYPE_TEXT" && decision.operation !== "SELECT") {
    return decision;
  }
  if (decision.value !== undefined) return decision;
  const control = state.controls.find((c) => c.ref === decision.target);
  if (!control) return decision;
  const value = fieldValueFromGoal(control, state.goal, state.controls);
  if (value === undefined) return decision;
  return { ...decision, value };
}
