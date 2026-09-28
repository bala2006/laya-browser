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
  goalAssignments,
  goalSuccessMarkerPresent,
  goalSuccessMarkers,
  isSubmitControl,
  unfilledGoalFields,
} from "../laya/goal.js";
import { checkDestructiveSubmit } from "../safety.js";

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

/**
 * The single UNAMBIGUOUS submit/search control on the page, if exactly one exists.
 *
 * "Unambiguous" means precisely one control satisfies {@link isSubmitControl}. When zero or
 * two-plus submit-like controls exist the choice is ambiguous, so this returns undefined and
 * the composition falls back to the ordinary rules (which do not guess which submit to press).
 * Pure and side-effect-free.
 */
export function unambiguousSubmit(state: PageState): Control | undefined {
  const submits = state.controls.filter(isSubmitControl);
  return submits.length === 1 ? submits[0] : undefined;
}

/**
 * Whether the goal expresses a success/search intent that a submit would satisfy: it declares
 * an explicit success marker (`expect "..."` etc.) or a search value (`search for "..."`).
 * Used only to DOCUMENT/justify composing a fill+submit sequence; it never relaxes the rule
 * order or the confidence. Pure.
 */
export function goalHasSubmitIntent(state: PageState): boolean {
  const assignments = goalAssignments(state.goal);
  if (assignments.has("search")) return true;
  return goalSuccessMarkers(state.goal).length > 0;
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
  //
  // COMPOSITION: the batch is deliberately the FEWEST valid Decisions the union allows for the
  // "fill many fields, then submit" plan. The Decision union has no legal composite state that
  // fills AND submits in one step (that would be an illegal state), so the minimal expression
  // is exactly ONE FILL_FORM here followed by ONE submit CLICK on the next iteration (Rule 3),
  // which fires once every batched field reads back as filled. When the page has exactly one
  // unambiguous submit control and the goal has a submit intent, that next-step CLICK is fully
  // determined ({@link unambiguousSubmit} + {@link goalHasSubmitIntent}); we do NOT emit it here
  // because each emitted Decision must be individually valid against the CURRENT observed page.
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

/**
 * (FEAT-003) Resolve the BEST SAFE next step when the run would otherwise dead-end.
 *
 * This is the pure resolver used to break the escalation dead-end: when the client LLM is
 * UNREACHABLE (no MCP sampler, or the sampler threw/timed out) AND the local decision is a
 * LOW-CONFIDENCE BLOCKED, hard-blocking traps the run. Instead we compute a NON-DESTRUCTIVE,
 * observable move so the run keeps progressing. Resolution order, first that applies wins:
 *
 *   (a) the deterministic policy layer's next sensible action for THIS page ({@link policySeed}) -
 *       the rules already know how to fill/select/submit and are the reliable path. A policy
 *       CLICK is only offered when it PASSES the same destructive-form guard the loop applies
 *       ({@link checkDestructiveSubmit}), so best-safe-progress never proposes a destructive
 *       submit (the loop's guard remains the final authority regardless);
 *   (b) a bounded, targetless {@link "SCROLL_DOWN"} nudge when the page still has controls or
 *       visible text to move toward - a safe, non-destructive observable move that reveals more
 *       of the page rather than ending the run.
 *
 * Returns `undefined` for a GENUINELY DEAD page (no policy action AND nothing to scroll toward),
 * so the caller preserves the graceful BLOCKED. It never targets a phantom ref: every returned
 * decision either reuses a policy target (already resolved against the live controls) or is the
 * targetless SCROLL_DOWN. Pure and side-effect-free.
 *
 * NOTE: this resolver deliberately does NOT rescue a CONFIDENT BLOCKED; the caller only invokes
 * it for a low-confidence BLOCKED, so a deliberate confident stop is never softened.
 */
export function bestSafeProgress(state: PageState): Decision | undefined {
  // (a) The policy layer's next action, when it is a real (non-BLOCKED) progress step.
  const seed = policySeed(state);
  if (seed && seed.decision.operation !== "BLOCKED") {
    const decision = seed.decision;
    // Never hand back a destructive CLICK: if the policy's next move is a submit CLICK on a
    // control the destructive-form guard would refuse, fall through to the safe nudge instead.
    //
    // INTENTIONAL ASYMMETRY: this checks with the guard's default enabled=true, whereas the
    // loop's own CLICK guard uses the configurable `destructiveFormGuard` flag. When an
    // operator turns that flag OFF, best-safe-progress stays STRICTER than the loop: it still
    // refuses to PROPOSE a destructive submit here and falls through to SCROLL_DOWN. This is
    // the safe direction and deliberate. best-safe-progress fires only on the dead-end
    // recovery path (unreachable LLM + low-confidence BLOCKED), where the goal is to keep the
    // run alive with an unambiguously safe move, not to auto-submit a form the local model was
    // unsure about; the loop's configurable guard remains the final authority on the CLICK it
    // ultimately executes. Do not thread the flag in here just for exact parity.
    if (decision.operation === "CLICK") {
      const target = state.controls.find((c) => c.ref === decision.target);
      if (target && !checkDestructiveSubmit(target, state).allowed) {
        // fall through to the SCROLL_DOWN nudge below
      } else {
        return decision;
      }
    } else {
      return decision;
    }
  }

  // (b) A bounded, non-destructive SCROLL_DOWN nudge, but only when there is something to move
  // toward (controls or visible text). A genuinely empty page has nothing to reveal.
  if (state.controls.length > 0 || state.visibleText.trim().length > 0) {
    return {
      operation: "SCROLL_DOWN",
      operationConfidence: RULE_CONFIDENCE,
      targetConfidence: 1,
      source: "rule",
    };
  }

  // Genuinely dead: no policy action and nothing to scroll toward -> preserve graceful BLOCKED.
  return undefined;
}
