/**
 * The Autopilot goal-runner: snapshot -> state -> decision -> execute -> repeat.
 *
 * {@link runGoal} drives a {@link BrowserSession} toward a natural-language goal using a
 * {@link LayaDecisionEngine}. The decision/transition logic is kept SEPARABLE from IO so it
 * is unit-testable: Playwright and the ONNX engine are guarded at the edges, and each
 * iteration is:
 *
 *   1. capture a snapshot (IO) and build a compact {@link PageState}
 *   2. ask the engine for a {@link Decision} (engine boundary)
 *   3. execute the decision via Playwright (IO): CLICK / TYPE_TEXT / SELECT via
 *      `session.resolveRef`; SCROLL_DOWN; WAIT
 *   4. append a human-readable line to `recentActions`
 *   5. stop on DONE / BLOCKED / step budget
 *
 * Graceful degradation: if `engine.available` is false, {@link runGoal} returns immediately
 * with `degraded: true` and a message telling the client to use the Assist-mode tools
 * instead of crashing.
 *
 * IMPORTANT: a DONE decision is NOT proof of success. After the loop ends we run an
 * INDEPENDENT final-page verification (the goal's expected marker, checked directly on the
 * page) and report `verified` true/false separately from the operation the model chose.
 */
import type { BrowserSession } from "../browser.js";
import { capture, type Snapshot } from "../snapshot.js";
import { buildState, type BuildStateOptions } from "../state-builder.js";
import { fieldValueFromGoal, goalSuccessMarkers } from "../laya/goal.js";
import { policySeed, refineWithGoalValue } from "./policy.js";
import { escalate, type SampleFn } from "./escalation.js";
import { checkDestructiveSubmit, checkDomainAllowed } from "../safety.js";
import { DEFAULT_CONFIDENCE_THRESHOLD, DEFAULT_MAX_STEPS } from "../config.js";
import type { Control, Decision, LayaDecisionEngine, PageState } from "../types.js";

/** How the goal run ended. */
export type RunOutcome = "done" | "blocked" | "max_steps" | "degraded" | "error";

/** One recorded step of the transcript. */
export interface StepRecord {
  /** 1-based step number. */
  step: number;
  /** The operation the engine chose. */
  operation: Decision["operation"];
  /** The target ref, when the operation was targeted. */
  target?: string;
  /** Model confidence in the operation choice, in [0, 1]. */
  operationConfidence: number;
  /** Model confidence in the target choice, in [0, 1]. */
  targetConfidence: number;
  /** Where the decision came from (`laya` / `stub` / `rule` / `llm`). */
  source: Decision["source"];
  /** The value typed/selected, when applicable. */
  value?: string;
  /** A short human-readable summary of what was executed. */
  detail: string;
  /** Optional note explaining how the decision was reached (rule seed / escalation). */
  note?: string;
}

/** Independent, post-hoc verification of the final page. */
export interface Verification {
  /** Whether an explicit success marker was checked (vs. no marker declared). */
  checked: boolean;
  /** Whether the expected marker(s) were present on the final page. */
  verified: boolean;
  /** The markers that were looked for. */
  markers: string[];
  /** Human-readable explanation. */
  detail: string;
}

/** The structured result of a goal run. */
export interface RunResult {
  goal: string;
  outcome: RunOutcome;
  /** True when the engine was unavailable and the run degraded to an Assist-mode hint. */
  degraded: boolean;
  /** Per-step transcript. */
  transcript: StepRecord[];
  /** The final page snapshot (compact text + controls). */
  finalSnapshot?: Snapshot;
  /** Independent final-page verification. */
  verification: Verification;
  /** A human-readable summary / degradation message. */
  message: string;
}

/** Options for {@link runGoal}. */
export interface RunGoalOptions {
  /** The natural-language goal to pursue. */
  goal: string;
  /** The browser session to drive. */
  session: BrowserSession;
  /** The decision engine (real Laya, stub, or unavailable). */
  engine: LayaDecisionEngine;
  /** Optional URL to navigate to before starting. */
  url?: string;
  /** Maximum decision steps before giving up. Defaults to 15. */
  maxSteps?: number;
  /** Milliseconds to wait on a WAIT operation. Defaults to 500. */
  waitMs?: number;
  /** Pixels to scroll on SCROLL_DOWN. Defaults to the viewport height. */
  scrollBy?: number;
  /** State-builder clamping options. */
  stateOptions?: BuildStateOptions;
  /**
   * Escalate to the client LLM when operation OR target confidence is below this value, or
   * on BLOCKED. In `[0, 1]`. Defaults to {@link DEFAULT_CONFIDENCE_THRESHOLD}.
   */
  confidenceThreshold?: number;
  /**
   * Sampling callback used for confidence escalation. When omitted, escalation degrades to
   * a clear BLOCKED result (the client lacks sampling). Injectable for tests.
   */
  sample?: SampleFn;
  /** Domain allow-list. When non-empty, restricts navigation/submits to these hosts. */
  allowedDomains?: string[];
  /** Whether the destructive-form guard is active. Defaults to true. */
  destructiveFormGuard?: boolean;
}

const DEFAULT_WAIT_MS = 500;

/** The Assist-mode hint returned when Autopilot cannot run (no weights). */
export const DEGRADED_MESSAGE =
  "Laya weights are not present, so Autopilot cannot run. Use the Assist-mode tools instead: " +
  "call browser_navigate / browser_snapshot to obtain [ref=eN] element references, then drive the " +
  "page with browser_type, browser_click, and browser_select_option.";

/** Look up a control by its ref within a page state. */
function findControl(state: PageState, ref: string): Control | undefined {
  return state.controls.find((c) => c.ref === ref);
}

/**
 * Resolve the concrete text to type/select for a targeted decision.
 *
 * If the engine already supplied a `value` (the stub does), use it; otherwise derive it
 * from the goal against the target control (so the real Laya engine, which only picks the
 * operation+target, still fills goal-stated values deterministically).
 */
function resolveValue(
  decision: Extract<Decision, { target: string }>,
  state: PageState,
): string | undefined {
  if (decision.value !== undefined) return decision.value;
  const control = findControl(state, decision.target);
  if (!control) return undefined;
  return fieldValueFromGoal(control, state.goal);
}

/** Run an independent verification of the final page against the goal's markers. */
export function verifyFinalPage(goal: string, snapshot: Snapshot): Verification {
  const markers = goalSuccessMarkers(goal);
  if (markers.length === 0) {
    return {
      checked: false,
      verified: false,
      markers: [],
      detail:
        "No explicit success marker in the goal; DONE was not independently confirmed.",
    };
  }
  const haystack = `${snapshot.title} ${snapshot.visibleText}`.toLowerCase();
  const missing = markers.filter((mk) => !haystack.includes(mk.toLowerCase()));
  const verified = missing.length === 0;
  return {
    checked: true,
    verified,
    markers,
    detail: verified
      ? `All expected markers present on the final page: ${markers
          .map((m) => JSON.stringify(m))
          .join(", ")}.`
      : `Missing expected marker(s): ${missing.map((m) => JSON.stringify(m)).join(", ")}.`,
  };
}

/**
 * Execute a single decision against the page. Returns a short detail string describing
 * what happened. This is the ONLY function in the loop that performs Playwright IO.
 */
async function execute(
  decision: Decision,
  state: PageState,
  options: Required<Pick<RunGoalOptions, "waitMs">> & { scrollBy?: number },
  session: BrowserSession,
): Promise<string> {
  switch (decision.operation) {
    case "CLICK": {
      const locator = session.resolveRef(decision.target);
      await locator.click();
      const c = findControl(state, decision.target);
      return `CLICK ${decision.target}${c ? ` (${c.role} ${JSON.stringify(c.name)})` : ""}`;
    }
    case "TYPE_TEXT": {
      const value = resolveValue(decision, state) ?? "";
      const locator = session.resolveRef(decision.target);
      await locator.fill(value);
      return `TYPE_TEXT ${decision.target} = ${JSON.stringify(value)}`;
    }
    case "SELECT": {
      const value = resolveValue(decision, state) ?? "";
      const locator = session.resolveRef(decision.target);
      await locator
        .selectOption({ label: value })
        .catch(async () => {
          await locator.selectOption(value);
        });
      return `SELECT ${decision.target} = ${JSON.stringify(value)}`;
    }
    case "SCROLL_DOWN": {
      const page = await session.getPage();
      const by = options.scrollBy;
      await page.evaluate(
        (px) => window.scrollBy(0, px ?? window.innerHeight),
        by ?? null,
      );
      return "SCROLL_DOWN";
    }
    case "WAIT": {
      const page = await session.getPage();
      await page.waitForTimeout(options.waitMs);
      return `WAIT ${options.waitMs}ms`;
    }
    case "DONE":
      return "DONE";
    case "BLOCKED":
      return "BLOCKED";
  }
}

/**
 * Drive the browser toward `goal` with the given engine.
 *
 * Returns a structured {@link RunResult} with a per-step transcript, the final snapshot,
 * and an independent verification. Degrades gracefully (no throw) when the engine is
 * unavailable.
 */
export async function runGoal(options: RunGoalOptions): Promise<RunResult> {
  const {
    goal,
    session,
    engine,
    url,
    maxSteps = DEFAULT_MAX_STEPS,
    waitMs = DEFAULT_WAIT_MS,
    scrollBy,
    stateOptions,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
    sample,
    allowedDomains = [],
    destructiveFormGuard = true,
  } = options;

  // Graceful degradation when no weights are available.
  if (!engine.available) {
    return {
      goal,
      outcome: "degraded",
      degraded: true,
      transcript: [],
      verification: {
        checked: false,
        verified: false,
        markers: [],
        detail: "Autopilot did not run.",
      },
      message: DEGRADED_MESSAGE,
    };
  }

  const page = await session.getPage();
  if (url) {
    // Domain allow-list guard: refuse to navigate off-list when a list is configured.
    const verdict = checkDomainAllowed(url, allowedDomains);
    if (!verdict.allowed) {
      return {
        goal,
        outcome: "blocked",
        degraded: false,
        transcript: [],
        verification: {
          checked: false,
          verified: false,
          markers: [],
          detail: "Blocked before navigation by the domain allow-list.",
        },
        message: verdict.reason ?? "Navigation blocked by the domain allow-list.",
      };
    }
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  const recentActions: string[] = [];
  const transcript: StepRecord[] = [];
  let outcome: RunOutcome = "max_steps";
  let lastSnapshot: Snapshot | undefined;

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const snapshot = await capture(page);
      lastSnapshot = snapshot;
      const state = buildState(goal, snapshot, recentActions, stateOptions);

      // Decision pipeline (order matters):
      //   1. deterministic-rule SEED — high-confidence rules per the laya-ultrafast lesson;
      //   2. Laya NARROW decision — the engine resolves the element/operation otherwise;
      //   3. confidence CHECK — escalate to the client LLM (MCP sampling) when low/BLOCKED.
      let note: string | undefined;

      const seed = policySeed(state);
      let decision: Decision;
      if (seed) {
        decision = seed.decision;
        note = `rule: ${seed.reason}`;
      } else {
        // Laya answers the narrow question; fill goal-stated values it did not supply.
        decision = refineWithGoalValue(await engine.decide(state), state);
      }

      // Confidence check: escalate on low confidence or BLOCKED (never for rule seeds,
      // which are high-confidence-deterministic by construction).
      const lowConfidence =
        decision.operationConfidence < confidenceThreshold ||
        decision.targetConfidence < confidenceThreshold;
      if (decision.source !== "rule" && (lowConfidence || decision.operation === "BLOCKED")) {
        const result = await escalate(state, sample);
        decision = refineWithGoalValue(result.decision, state);
        note = result.note;
      }

      if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
        transcript.push({
          step,
          operation: decision.operation,
          operationConfidence: decision.operationConfidence,
          targetConfidence: decision.targetConfidence,
          source: decision.source,
          detail: decision.operation,
          ...(note ? { note } : {}),
        });
        recentActions.push(decision.operation);
        outcome = decision.operation === "DONE" ? "done" : "blocked";
        break;
      }

      // Destructive-form guard: before an auto-submit CLICK, refuse if the action looks
      // destructive (delete/pay/purchase/...). Surface the reason and stop (blocked).
      if (decision.operation === "CLICK") {
        const target = findControl(state, decision.target);
        if (target) {
          const guard = checkDestructiveSubmit(target, state, destructiveFormGuard);
          if (!guard.allowed) {
            transcript.push({
              step,
              operation: "BLOCKED",
              operationConfidence: 1,
              targetConfidence: 1,
              source: decision.source,
              detail: "BLOCKED (destructive-form guard)",
              note: guard.reason ?? "Destructive-form guard refused the auto-submit.",
            });
            recentActions.push("BLOCKED (destructive-form guard)");
            outcome = "blocked";
            break;
          }
        }
      }

      const detail = await execute(decision, state, { waitMs, scrollBy }, session);
      const record: StepRecord = {
        step,
        operation: decision.operation,
        operationConfidence: decision.operationConfidence,
        targetConfidence: decision.targetConfidence,
        source: decision.source,
        detail,
        ...(note ? { note } : {}),
      };
      if (decision.target !== undefined) record.target = decision.target;
      const value = "value" in decision ? decision.value : undefined;
      if (value !== undefined) record.value = value;
      transcript.push(record);
      recentActions.push(detail);
    }
  } catch (err) {
    outcome = "error";
    return {
      goal,
      outcome,
      degraded: false,
      transcript,
      ...(lastSnapshot ? { finalSnapshot: lastSnapshot } : {}),
      verification: {
        checked: false,
        verified: false,
        markers: [],
        detail: `Run errored: ${(err as Error).message}`,
      },
      message: `Autopilot stopped on error: ${(err as Error).message}`,
    };
  }

  // Always capture the true final page for independent verification (the loop may have
  // ended on DONE, BLOCKED, or the step budget; DONE is not trusted as success).
  const finalSnapshot = await capture(page);
  const verification = verifyFinalPage(goal, finalSnapshot);

  const summaryOutcome =
    outcome === "done" && verification.checked && !verification.verified
      ? "reported DONE but the final-page verification FAILED"
      : outcome;

  return {
    goal,
    outcome,
    degraded: false,
    transcript,
    finalSnapshot,
    verification,
    message: `Autopilot finished (${summaryOutcome}) after ${transcript.length} step(s). ${verification.detail}`,
  };
}
