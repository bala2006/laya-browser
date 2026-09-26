/**
 * {@link StubEngine} — a deterministic, weight-free decision engine for tests and dev.
 *
 * Mirrors how laya-ultrafast tests with a fake: it implements {@link LayaDecisionEngine}
 * with `available = true` and applies simple, transparent rules over a {@link PageState}
 * so Autopilot is fully exercisable OFFLINE without the ~1.7GB weights.
 *
 * Rules (evaluated in order):
 *   1. If a success marker for the goal already appears on the page -> DONE.
 *   2. If an editable field whose value is implied by the goal is not yet filled ->
 *      TYPE_TEXT that field with the goal-derived value.
 *   3. If every goal-implied field is filled and a submit/search button exists -> CLICK it.
 *   4. Otherwise, if any actionable button/link exists that matches goal intent -> CLICK it.
 *   5. Nothing actionable -> BLOCKED.
 *
 * The value/field matching heuristics live in {@link ./goal} so the real loop can reuse
 * them (Laya picks the operation/target, these fill in the concrete value to type).
 */
import type {
  Control,
  Decision,
  LayaDecisionEngine,
  PageState,
} from "../types.js";
import {
  fieldValueFromGoal,
  goalSuccessMarkerPresent,
  isSubmitControl,
} from "./goal.js";

/** High confidence used for the stub's deterministic decisions. */
const CONFIDENT = 0.99;

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

/** A deterministic decision engine used for offline tests and explicit dev selection. */
export class StubEngine implements LayaDecisionEngine {
  readonly available = true;

  async decide(state: PageState): Promise<Decision> {
    // 1. Goal already satisfied on the page.
    if (goalSuccessMarkerPresent(state)) {
      return {
        operation: "DONE",
        operationConfidence: CONFIDENT,
        targetConfidence: 1,
        source: "stub",
      };
    }

    // 2. Fill the first goal-implied field that is still empty.
    for (const c of state.controls) {
      if (!isTextField(c)) continue;
      const value = fieldValueFromGoal(c, state.goal);
      if (value === undefined) continue;
      const current = (c.value ?? "").trim();
      if (current === value.trim()) continue; // already filled
      return {
        operation: "TYPE_TEXT",
        operationConfidence: CONFIDENT,
        target: c.ref,
        targetConfidence: CONFIDENT,
        value,
        source: "stub",
      };
    }

    // 3. All goal-implied fields filled -> click the submit/search control.
    const anyGoalField = state.controls.some(
      (c) => isTextField(c) && fieldValueFromGoal(c, state.goal) !== undefined,
    );
    if (anyGoalField) {
      const submit = state.controls.find(isSubmitControl);
      if (submit) {
        return {
          operation: "CLICK",
          operationConfidence: CONFIDENT,
          target: submit.ref,
          targetConfidence: CONFIDENT,
          source: "stub",
        };
      }
    }

    // 4. No goal fields, but a submit/search button exists -> click it.
    const submit = state.controls.find(isSubmitControl);
    if (submit) {
      return {
        operation: "CLICK",
        operationConfidence: 0.8,
        target: submit.ref,
        targetConfidence: 0.8,
        source: "stub",
      };
    }

    // 5. Nothing actionable.
    return {
      operation: "BLOCKED",
      operationConfidence: CONFIDENT,
      targetConfidence: 1,
      source: "stub",
    };
  }

  async close(): Promise<void> {
    // No resources to release.
  }
}
