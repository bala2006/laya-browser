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
import type { Page } from "playwright";
import type { BrowserSession } from "../browser.js";
import type {
  BrowserOverlay,
  OverlayRect,
  OverlayState,
  ScrollDirection,
  ToastKind,
} from "../overlay.js";
import { capture, captureFast, type CaptureOptions, type Snapshot } from "../snapshot.js";
import { diffSnapshots, hasChanges } from "../snapshot-diff.js";
import { buildState, renderState, type BuildStateOptions } from "../state-builder.js";
import { fieldValueFromGoal, goalSuccessMarkers } from "../laya/goal.js";
import { applyFieldValue, type FieldKind } from "../tools/fill.js";
import { bestSafeProgress, policySeed, refineWithGoalValue } from "./policy.js";
import { escalate, type EscalationOptions, type SampleFn } from "./escalation.js";
import { autoDismissOverlays } from "./dismiss.js";
import { checkDestructiveSubmit, checkDomainAllowed } from "../safety.js";
import { isSecretField, redactText } from "../redact.js";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_LOOP_WINDOW,
  DEFAULT_MAX_STEPS,
  DEFAULT_SELF_HEAL_RETRIES,
  DEFAULT_SNAPSHOT_BACKEND,
  type SnapshotBackend,
} from "../config.js";
import type {
  Control,
  Decision,
  FastControl,
  FastSnapshot,
  LayaDecisionEngine,
  NodeGuard,
  PageState,
} from "../types.js";

/**
 * How the goal run ended.
 *
 * `stuck` (A3) is ADDITIVE: the loop detector observed the identical step repeating with no
 * progress and bailed early rather than burning the whole step budget. Every pre-existing
 * outcome string is unchanged.
 */
export type RunOutcome = "done" | "blocked" | "max_steps" | "degraded" | "error" | "stuck";

/**
 * (B2) A human-in-the-loop confirmation callback.
 *
 * Given a short human-readable prompt (e.g. `About to click "Delete account" - approve?`),
 * it resolves to `true` when the human approves the action and `false` when they refuse.
 * Injectable so the loop stays unit-testable; production wires it to MCP elicitation in
 * src/server.ts. It must NEVER throw (the loop treats any rejection as a refusal).
 */
export type ConfirmFn = (prompt: string) => Promise<boolean>;

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
  /** The keyboard key pressed, for PRESS_KEY steps. */
  key?: string;
  /** The batch of fields filled, for FILL_FORM steps. */
  fields?: { target: string; value: string }[];
  /** The marker checked, for VERIFY steps. */
  marker?: string;
  /** Whether a VERIFY step found its marker (or a SCREENSHOT captured), for terminal steps. */
  verified?: boolean;
  /** A short human-readable summary of what was executed. */
  detail: string;
  /** Optional note explaining how the decision was reached (rule seed / escalation). */
  note?: string;
  /**
   * (A1) How many self-healing retries this step needed before the action succeeded. Present
   * (and >= 1) only when at least one retry ran; absent for steps that succeeded first try.
   */
  retries?: number;
  /**
   * (A2) Whether the post-action settle probe observed a change (a navigation or DOM
   * mutations) after this step. Present only when the settle probe ran for the step. Purely
   * observational: it never affects the outcome.
   */
  settled?: boolean;
  /**
   * (T5) Wall-clock milliseconds spent DECIDING this step: the policy seed + the local Laya
   * inference + any escalation round-trip, measured just around the decision pipeline (NOT the
   * IO of executing the action). Purely observational, so "% fully autonomous" and per-step
   * decision latency are measurable from the transcript. Distinct from
   * {@link RunStepArtifact.durationMs}, which spans decision + execution + settle probe.
   */
  inferenceMs?: number;
}

/**
 * (D1) A per-step observability artifact captured during a run for the replay export.
 *
 * These records are ADDITIVE and are only populated when {@link RunGoalOptions.recordArtifacts}
 * is true (default false), so normal runs are not slowed by the screenshot capture. Any text
 * carried here (detail/target/snapshot) is already redacted per B1 before it is stored.
 */
export interface RunStepArtifact {
  /** 1-based step number, matching the transcript. */
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
  /** A short human-readable summary of what was executed (already redacted per B1). */
  detail: string;
  /** Optional note explaining how the decision was reached (already redacted per B1). */
  note?: string;
  /** Wall-clock milliseconds spent on this step (decision + execution + settle probe). */
  durationMs: number;
  /** The compact snapshot text captured at the start of the step (already redacted per B1). */
  snapshot: string;
  /**
   * A base64-encoded PNG screenshot of the page at the start of the step. Present only when
   * recording was enabled AND the capture succeeded (best-effort; never fails a run).
   */
  screenshotPng?: string;
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

/**
 * (T5) A run-level autonomy summary: how the run's steps were decided, so "% fully autonomous"
 * is a first-class, measurable number rather than something a caller re-derives. A step is
 * FULLY AUTONOMOUS when it was decided locally (`rule` / `laya` / `stub`); an `llm` step is
 * the one place the run reached out to the client. ADDITIVE and OPTIONAL on {@link RunResult}.
 */
export interface AutonomySummary {
  /** Total steps in the transcript. */
  total: number;
  /** Steps decided by a deterministic rule seed (confidence 0.97). */
  rule: number;
  /** Steps decided by the local Laya engine. */
  laya: number;
  /** Steps decided by the offline stub engine. */
  stub: number;
  /** Steps that escalated to (and were answered by) the client LLM. */
  llm: number;
  /** Steps decided locally (rule + laya + stub) - i.e. with no client LLM round-trip. */
  fullyAutonomous: number;
  /** fullyAutonomous / total, in [0, 1]; 0 when there were no steps. */
  autonomousPct: number;
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
  /**
   * (D1) Per-step observability artifacts (screenshot + snapshot + decision + confidence +
   * timing) for the replay export. ADDITIVE and OPTIONAL: only populated when
   * {@link RunGoalOptions.recordArtifacts} is true; absent (and behaviour unchanged) otherwise.
   */
  steps?: RunStepArtifact[];
  /**
   * (T5) The run-level autonomy summary (source counts + % fully autonomous). ADDITIVE and
   * OPTIONAL: present on a normally-completed run, absent on the launch-free `degraded` return
   * (no steps ran). Callers that inspect only the transcript are unaffected.
   */
  autonomy?: AutonomySummary;
  /**
   * (R3) Non-fatal conditions the relaxed hard stops let the run continue past, in the order
   * they happened (e.g. "navigating off the allow-list"). Empty/absent when nothing was
   * relaxed, so a caller can tell "finished cleanly" from "finished with a warning" instead of
   * inferring it from the transcript.
   */
  warnings?: string[];
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
  /**
   * (R2) Whether the client can actually answer an MCP sampling request, resolved lazily at
   * call time (the client's `sampling` capability is only known after initialize, which happens
   * after the server is built). Consulted ONLY to decide the no-weights path: when the local
   * engine has no weights but the client can plan, the loop runs on the client LLM instead of
   * degrading. Defaults to "assume yes when a sample callback is present", so an injected
   * sampler in a test behaves as before.
   */
  plannerAvailable?: () => boolean;
  /** Domain allow-list. When non-empty, restricts navigation/submits to these hosts. */
  allowedDomains?: string[];
  /** Whether the destructive-form guard is active. Defaults to true. */
  destructiveFormGuard?: boolean;
  /**
   * (A1) How many times a failed targeted action (CLICK/TYPE_TEXT/SELECT/HOVER) is retried
   * against a freshly re-captured page, re-resolving the same target by accessible name +
   * role (self-healing against stale refs / transient failures). Defaults to
   * {@link DEFAULT_SELF_HEAL_RETRIES}. `0` disables self-healing.
   */
  selfHealRetries?: number;
  /**
   * (A2) Whether to run the purely-observational post-action settle probe after each
   * executed action. Defaults to true. The probe NEVER changes the decision path or outcome;
   * it only records {@link StepRecord.settled} and narrates a "settling"/"no change" hint.
   */
  settleProbe?: boolean;
  /**
   * (A3) Whether loop detection is active: when the last {@link loopWindow} steps are
   * identical (same URL + control set + decision), the run bails early with the `stuck`
   * outcome instead of burning the whole budget. Defaults to true.
   */
  loopDetection?: boolean;
  /**
   * (A3) How many of the most recent step signatures the loop detector compares before
   * declaring the run stuck. Defaults to {@link DEFAULT_LOOP_WINDOW}.
   */
  loopWindow?: number;
  /**
   * (B1) Whether secret values typed into secret-looking fields (and common secret patterns)
   * are masked in the transcript detail/value, the overlay narration, and any logs. Defaults
   * to true. The REAL value is always still typed into the page; only the displayed/logged
   * echo is masked. When false, behaviour is unchanged.
   */
  redactSecrets?: boolean;
  /**
   * (B2) Retained for compatibility and still parsed/validated by the config layer, but no
   * longer consulted by the loop: (R3) makes the ask follow {@link confirm} alone, because
   * requiring a second flag turned a configurable confirmation into a hard block. Kept so
   * existing callers and the LAYA_CONFIRM_DESTRUCTIVE env var keep
   * working; {@link confirm} alone now decides whether the loop can ask.
   */
  confirmDestructive?: boolean;
  /**
   * (B2) Optional human-in-the-loop confirmation callback. When present, a destructive CLICK the
   * guard would refuse triggers an inline approval request (amber "awaiting confirmation"
   * overlay) instead of an immediate block: approval proceeds with the CLICK, refusal keeps the
   * block. When absent there is nobody to ask, so the refuse-by-default fail-safe is preserved
   * exactly. Also used by (R3) to confirm an off-allow-list navigation.
   */
  confirm?: ConfirmFn;
  /**
   * (C1) Which snapshot backend the loop captures with: `domwalk` (default) or `aria`.
   * Threaded from config so the whole loop (per-step capture, self-heal re-capture, final
   * verification) uses the same backend. Defaults to {@link DEFAULT_SNAPSHOT_BACKEND}.
   */
  snapshotBackend?: SnapshotBackend;
  /**
   * (C3) Whether per-step captures order controls by viewport proximity first (in/near-view
   * controls surfaced ahead of far-offscreen ones, so the ~20-control cap keeps the most
   * relevant). Defaults to false here, preserving the existing DOM order for autopilot tests.
   */
  viewportPriority?: boolean;
  /**
   * (C2) Whether the escalation path may send a DELTA-ONLY prompt (added/removed/changed
   * controls plus goal/url/title) to the client LLM when a meaningful snapshot diff exists
   * and it is not the first step, instead of the full control list. Cuts tokens. Defaults to
   * false, so the full-snapshot prompt is always used unless opted in. The full prompt is
   * always used on the first step or when there is no meaningful diff.
   */
  deltaPrompt?: boolean;
  /**
   * Optional visual-overlay (agentLens HUD) controller, threaded in from the session so the
   * loop can narrate each step on-page. When omitted, EVERY narration call is a guarded
   * no-op and the loop behaves exactly as before (the pure decision/transition logic and all
   * existing autopilot tests are unaffected).
   */
  overlay?: BrowserOverlay;
  /**
   * The active page the overlay narrates against. Only used for overlay calls; supplied
   * alongside {@link overlay}. When absent the loop resolves the page for IO on its own.
   */
  overlayPage?: Page;
  /**
   * (D1) Whether to accumulate per-step {@link RunStepArtifact} records (screenshot +
   * snapshot + decision + confidence + timing) on {@link RunResult.steps} for the replay
   * export. Defaults to false so normal runs are NOT slowed by the extra screenshot capture;
   * the laya_export_run tool enables it. When false, no artifacts are recorded and behaviour
   * is unchanged.
   */
  recordArtifacts?: boolean;
  /**
   * (T1.4) Whether to capture a per-step PNG screenshot even when {@link recordArtifacts} is
   * off. Default false: the loop is a text-first, no-per-step-screenshot pipeline (vision is
   * opt-in) to stay fast/cheap. Recording artifacts implies a screenshot for the replay;
   * this independent flag lets an operator force step screenshots (or documents the default
   * off). When false AND recordArtifacts is false, no screenshot is ever captured.
   */
  loopScreenshots?: boolean;
  /**
   * (T2.2) Whether to run a bounded, conservative auto-dismiss of cookie/consent banners and
   * blocking modal overlays before deciding each step. Default false. Never clicks
   * destructive controls; only accept/close/dismiss affordances on detected consent/modal
   * containers. Each dismissal is surfaced on the overlay and noted in the transcript.
   */
  autoDismiss?: boolean;
  /**
   * (T2.3) How many levels of same-origin iframe / open shadow root the per-step capture
   * descends into. `0` (default) is the top document only. Threaded into every capture this
   * run makes so self-heal and final verification agree.
   */
  frameDepth?: number;
  /**
   * (D2) Optional per-step progress callback, invoked once per step at the same place the
   * loop narrates progress on the overlay. Given `{ step, total, message }` where `message`
   * is a redacted, human-readable line like `step 3/15: clicking Sign in`. Wired in
   * src/tools/run_goal.ts to MCP `notifications/progress` when the caller supplied a
   * progressToken. A no-op when omitted, so existing behaviour is unchanged. Must not throw
   * in a way that breaks the run (the loop awaits it but any streaming failure is the
   * caller's concern; keep it defensive).
   */
  onProgress?: (info: { step: number; total: number; message: string }) => void | Promise<void>;
}

const DEFAULT_WAIT_MS = 500;

/**
 * (F1) The adaptive-wait cap in ms the (always-on) fast browser loop uses before inputting
 * (e.g. for a combobox/autocomplete list to populate) and as the settle-probe timeout,
 * mirroring jev's 200ms autocomplete cap. An internal timing constant, not an operator knob.
 */
const FAST_WAIT_CAP_MS = 200;

/** The Assist-mode hint returned when Autopilot cannot run (no weights). */
export const DEGRADED_MESSAGE =
  "Laya weights are not present, so Autopilot cannot run. Use the Assist-mode tools instead: " +
  "call browser_navigate / browser_snapshot to obtain [ref=eN] element references, then drive the " +
  "page with browser_type, browser_click, and browser_select_option.";

/** Look up a control by its ref within a page state. */
function findControl(state: PageState, ref: string): Control | undefined {
  return state.controls.find((c) => c.ref === ref);
}

/** Lower-case the first character of a string (for 'step N/M: clicking ...' messages). */
function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/**
 * A short, human-readable caption for the HUD status line describing the action about to
 * run. Targeted ops render their own cursor caption inside {@link execute}; this covers the
 * banner status for every operation so the "acting" state always reads clearly.
 */
function actionCaption(decision: Decision, state: PageState): string {
  const name = (ref: string): string => {
    const c = findControl(state, ref);
    return c ? String(c.name || c.role) : ref;
  };
  switch (decision.operation) {
    case "CLICK":
      return `Clicking ${name(decision.target)}`;
    case "TYPE_TEXT":
      return `Typing ${name(decision.target)}\u2026`;
    case "SELECT":
      return `Selecting ${name(decision.target)}`;
    case "HOVER":
      return `Hovering ${name(decision.target)}`;
    case "FILL_FORM":
      return `Filling ${decision.fields.length} field(s)\u2026`;
    case "PRESS_KEY":
      return `Pressing ${decision.key}`;
    case "NAVIGATE_BACK":
      return "Navigating\u2026";
    case "SCROLL_DOWN":
      return "Scrolling down\u2026";
    case "WAIT":
      return "Waiting\u2026";
    case "SCREENSHOT":
      return "Capturing screenshot\u2026";
    case "VERIFY":
      return "Verifying\u2026";
    default:
      return "Acting\u2026";
  }
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
  return fieldValueFromGoal(control, state.goal, state.controls);
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

/** The outcome of executing a single decision: a human-readable detail plus optional extras. */
interface ExecuteResult {
  /** A short human-readable summary of what was executed (recorded in the transcript). */
  detail: string;
  /** For a VERIFY/SCREENSHOT terminal step: whether the check passed / capture succeeded. */
  verified?: boolean;
  /** (A1) How many self-healing retries the targeted action needed (>= 1 when any ran). */
  retries?: number;
}

/**
 * (A1) Re-resolve a control by its accessible name + role against a FRESHLY captured page.
 *
 * Used to self-heal a stale/missing ref: after an action fails in a way that looks like the
 * captured ref went stale, we re-capture the page and look for the control whose name + role
 * match the target we were originally aiming at, returning its NEW ref (`eN`) so the caller
 * can retry via {@link BrowserSession.resolveRef}. Matching is exact on role and (trimmed)
 * name; returns undefined when nothing matches, so the caller can rethrow the original error.
 */
export async function resolveByNameRole(
  session: BrowserSession,
  page: Page,
  name: string,
  role: string,
  captureOptions: CaptureOptions = {},
): Promise<string | undefined> {
  const fresh = await capture(page, captureOptions);
  const wantName = name.trim();
  const match = fresh.controls.find(
    (c) => c.role === role && String(c.name).trim() === wantName,
  );
  return match?.ref;
}

/**
 * Whether an error thrown by a targeted Playwright action looks like a stale/missing ref.
 *
 * Matches ONLY the known Playwright stale/detached/timeout phrasings. A message-less throw is
 * deliberately NOT treated as stale: retrying an empty-message error would re-resolve and
 * retry genuinely-failed actions, masking real failures behind the self-heal loop.
 */
function looksLikeStaleRef(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  if (msg === "") return false;
  // The fast path raises a soft, self-heal-shaped error via softError() when a target is
  // stale/covered/gone (see fastAct); match those phrasings too so the retry budget re-observes.
  if (/^fast path: target is (?:stale|covered|gone)/i.test(msg)) return true;
  return /Timeout|not (?:visible|attached|found|stable)|no element|detached|zero elements|resolve to no elements|element is not/i.test(
    msg,
  );
}

/**
 * (A1) Run a targeted action against `ref`, self-healing a stale ref up to `maxRetries`
 * times. On a failure that looks like a stale/missing ref we re-capture the page, re-resolve
 * the SAME control by its captured accessible name + role, and retry against the new ref.
 * When re-resolution finds no match the original error is rethrown. Returns the number of
 * retries actually performed (0 when the first attempt succeeded).
 */
async function runWithSelfHeal(
  session: BrowserSession,
  narrator: Narrator,
  target: { ref: string; name: string; role: string },
  maxRetries: number,
  action: (ref: string) => Promise<void>,
  captureOptions: CaptureOptions = {},
): Promise<number> {
  let ref = target.ref;
  let attempt = 0;
  // Attempt 0 is the initial try; attempts 1..maxRetries are self-healing retries.
  for (;;) {
    try {
      await action(ref);
      return attempt;
    } catch (err) {
      if (attempt >= maxRetries || !looksLikeStaleRef(err)) throw err;
      const page = await session.getPage();
      const fresh = await resolveByNameRole(
        session,
        page,
        target.name,
        target.role,
        captureOptions,
      );
      if (fresh === undefined) throw err;
      attempt += 1;
      ref = fresh;
      await narrator.toast("Re-resolving stale element\u2026", "uncertain");
      await narrator.log(
        `Re-resolving ${JSON.stringify(target.name)} (${target.role}) -> ${ref} (retry ${attempt})`,
      );
    }
  }
}

/**
 * A thin, always-safe narration facade over the optional {@link BrowserOverlay}. When no
 * overlay/page was threaded in it is entirely inert, so the loop's pure logic and every
 * existing autopilot test (which construct runGoal with NO overlay) are unaffected. When an
 * overlay is present each method delegates to the overlay's own guarded, never-throwing
 * server-side API against the active page.
 */
class Narrator {
  constructor(
    private readonly overlay: BrowserOverlay | undefined,
    private readonly page: Page | undefined,
    /**
     * (B1) Redact secret values/patterns out of any string BEFORE it reaches the overlay.
     * Defaults to identity (no redaction) so callers that do not opt in are unaffected. The
     * loop threads a redactor bound to the run-scoped set of typed secret values.
     */
    private readonly redactor: (text: string) => string = (text) => text,
  ) {}

  /** Whether narration is active (an overlay AND a page were supplied). */
  private get on(): boolean {
    return this.overlay !== undefined && this.page !== undefined;
  }

  async progress(step: number, max: number): Promise<void> {
    if (!this.on) return;
    await this.overlay!.progress(this.page, step, max);
  }

  async setState(state: OverlayState, status?: string): Promise<void> {
    if (!this.on) return;
    // (Perf) The state and its caption are always set together, so they share one round-trip.
    if (status === undefined) {
      await this.overlay!.setState(this.page, state);
      return;
    }
    await this.overlay!.callBatch(this.page, [
      ["setState", state],
      ["setStatus", this.redactor(status)],
    ]);
  }

  /**
   * (Perf) The step preamble: advance the counter and enter the thinking state (with its
   * caption) in ONE round-trip. This used to be three separate evaluates fired before any
   * decision work began, on every step.
   */
  async beginStep(step: number, max: number, status = "Deciding\u2026"): Promise<void> {
    if (!this.on) return;
    await this.overlay!.callBatch(this.page, [
      ["progress", step, max],
      ["setState", "thinking"],
      ["setStatus", this.redactor(status)],
    ]);
  }

  /**
   * (Perf) Raise a notice as BOTH a toast and an activity-log line in one round-trip: the two
   * always accompany each other for the same event, so they never needed separate evaluates.
   */
  async notice(message: string, kind: ToastKind = "info"): Promise<void> {
    if (!this.on) return;
    const text = this.redactor(message);
    await this.overlay!.callBatch(this.page, [
      ["toast", text, kind],
      ["log", text],
    ]);
  }

  /**
   * (Perf) Set the state + caption AND raise a toast in ONE round-trip. These three always fire
   * together when escalating to the LLM or asking for destructive-action confirmation.
   */
  async stateWithToast(
    state: OverlayState,
    status: string,
    message: string,
    kind: ToastKind = "uncertain",
  ): Promise<void> {
    if (!this.on) return;
    await this.overlay!.callBatch(this.page, [
      ["setState", state],
      ["setStatus", this.redactor(status)],
      ["toast", this.redactor(message), kind],
    ]);
  }

  /** (Perf) Reveal the cursor and light the session aura in one round-trip at run start. */
  async beginRun(): Promise<void> {
    if (!this.on) return;
    // The four-corner session frame is NOT armed here. It is armed at overlay build time for
    // every document the HUD is injected into, so the goal command and the Assist tools show
    // the identical frame; a run-scoped toggle would make the goal HUD look different from the
    // Assist HUD (and drop the frame the moment a run ended).
    await this.overlay!.showCursor(this.page);
  }

  async toast(message: string, kind: ToastKind = "info"): Promise<void> {
    if (!this.on) return;
    await this.overlay!.toast(this.page, this.redactor(message), kind);
  }

  async log(line: string): Promise<void> {
    if (!this.on) return;
    await this.overlay!.log(this.page, this.redactor(line));
  }

  async countdown(ms: number): Promise<void> {
    if (!this.on) return;
    await this.overlay!.countdown(this.page, ms);
  }

  async scrollIndicator(direction: ScrollDirection, pos?: number): Promise<void> {
    if (!this.on) return;
    await this.overlay!.scrollIndicator(this.page, direction, pos);
  }

  async meter(steps: number, escalations: number, tokens: number): Promise<void> {
    if (!this.on) return;
    await this.overlay!.meter(this.page, steps, escalations, tokens);
  }

  async hideSpotlight(): Promise<void> {
    if (!this.on) return;
    await this.overlay!.hideSpotlight(this.page);
  }

  /** Make the synthetic cursor visible (default: viewport centre). Best-effort no-op. */
  async showCursor(): Promise<void> {
    if (!this.on) return;
    await this.overlay!.showCursor(this.page);
  }

  /**
   * Point the synthetic cursor + spotlight at a targeted control (resolved via the overlay's
   * `data-laya-ref` helper), optionally with a caption. Returns the target rect (or null) so
   * a CLICK can ripple at its centre. Best-effort: any missing rect leaves the HUD untouched.
   */
  async focusTarget(ref: string, caption?: string): Promise<OverlayRect | null> {
    if (!this.on) return null;
    // (Perf) One round-trip resolves the ref and aims the cursor + spotlight at it, instead of
    // three. `this.redactor` still masks the caption, exactly as before.
    return this.overlay!.focus(
      this.page,
      ref,
      caption !== undefined ? this.redactor(caption) : caption,
    );
  }

  async ripple(x: number, y: number): Promise<void> {
    if (!this.on) return;
    await this.overlay!.ripple(this.page, x, y);
  }

  /** Center of a rect, used to place the click ripple. */
  static rectCenter(rect: OverlayRect): { x: number; y: number } {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
}

/** Pick the {@link FieldKind} used to fill a control in a FILL_FORM batch. */
function fieldKindFor(control: Control | undefined): FieldKind {
  if (!control) return "textbox";
  if (control.type === "checkbox") return "checkbox";
  if (control.type === "radio") return "radio";
  if (control.role === "combobox" || control.role === "listbox" || control.tag === "select") {
    return "combobox";
  }
  if (control.role === "slider" || control.type === "range") return "slider";
  return "textbox";
}

/**
 * Execute a single decision against the page. Returns an {@link ExecuteResult} describing
 * what happened. This is the ONLY function in the loop that performs Playwright IO.
 */
async function execute(
  decision: Decision,
  state: PageState,
  options: Required<Pick<RunGoalOptions, "waitMs">> & {
    scrollBy?: number;
    selfHealRetries: number;
    /** (B1) When true, capture secret values typed into secret-looking fields for masking. */
    redactSecrets: boolean;
    /** (B1) The run-scoped set the ACTUAL typed secret values are recorded into. */
    secrets: Set<string>;
    /** (C1/C3) The backend/ordering used for any re-capture inside execute (self-heal/VERIFY). */
    captureOptions: CaptureOptions;
    /**
     * (F1) When present, the fast loop is active for this step: `ctx` carries the per-ref
     * persistent identity / guard / rect and the observation's pageKey+marker, and `capMs`
     * is the adaptive-wait cap. A targeted CLICK/TYPE_TEXT/SELECT/FILL_FORM then re-checks the
     * guard+pageKey and acts on the OBSERVED node (no fresh selector query) with a pre-input
     * occlusion hit-test, returning a soft `stale`/`covered` result so the loop re-observes.
     */
    fast?: { ctx: FastContext; capMs: number };
  },
  session: BrowserSession,
  narrator: Narrator,
): Promise<ExecuteResult> {
  // (F1) The fast-path result of a targeted action attempt: `handled` false means the caller
  // should fall back to the legacy locator path (e.g. the ref had no fast identity).
  const fastAct = async (
    ref: string,
    kind: "click" | "fill" | "select",
    value: string | undefined,
  ): Promise<{ handled: boolean; soft?: "stale" | "covered" | "gone" }> => {
    const fast = options.fast;
    if (!fast) return { handled: false };
    const entry = fast.ctx.byRef.get(ref);
    if (!entry) return { handled: false };
    const page = await session.getPage();
    // Freshness re-check: [pageKey, guard(node)] must match what we observed at decision time.
    const fresh = await session.freshGuard(page, entry.nodeId, {
      guard: entry.guard,
      pageKey: fast.ctx.pageKey,
    });
    if (!fresh) return { handled: true, soft: "stale" };
    // Act on the OBSERVED node (no fresh selector query) with the pre-input occlusion hit-test.
    const result = await session.actOnNode(page, entry.nodeId, kind, { value: value ?? "" });
    if (!result.ok) return { handled: true, soft: result.reason };
    // Adaptive, bounded wait instead of a fixed post-action settle on the hot path.
    await session.adaptiveWait(page, { nodeId: entry.nodeId, kind, capMs: fast.capMs });
    return { handled: true };
  };
  // (F1) A soft failure (stale/covered/gone) from the fast path surfaces as a stale-ref-shaped
  // error so the existing self-heal retry budget re-captures and re-resolves, exactly as it
  // does for a genuine stale locator on the legacy path.
  const softError = (reason: string): Error =>
    new Error(`fast path: target is ${reason} (re-observe needed)`);
  switch (decision.operation) {
    case "CLICK": {
      const c = findControl(state, decision.target);
      const name = c ? String(c.name || c.role) : decision.target;
      // Tier 1/2: move cursor + spotlight the target, then ripple at its centre.
      const rect = await narrator.focusTarget(decision.target, `Clicking ${name}`);
      if (rect) {
        const { x, y } = Narrator.rectCenter(rect);
        await narrator.ripple(x, y);
      }
      // A1: self-heal a stale ref by re-resolving the same control (name + role).
      const retries = await runWithSelfHeal(
        session,
        narrator,
        { ref: decision.target, name: c ? String(c.name) : "", role: c ? c.role : "" },
        options.selfHealRetries,
        async (ref) => {
          // (F1) Fast path: act on the observed node (freshness + occlusion) with NO fresh
          // selector query. A soft stale/covered result throws a stale-shaped error so the
          // self-heal budget re-captures and re-resolves; a ref without fast identity falls
          // through to the legacy locator path unchanged.
          const fa = await fastAct(ref, "click", undefined);
          if (fa.handled) {
            if (fa.soft) throw softError(fa.soft);
            return;
          }
          await (await session.locate(ref)).click();
        },
        options.captureOptions,
      );
      return {
        detail: `CLICK ${decision.target}${c ? ` (${c.role} ${JSON.stringify(c.name)})` : ""}`,
        ...(retries > 0 ? { retries } : {}),
      };
    }
    case "TYPE_TEXT": {
      const value = resolveValue(decision, state) ?? "";
      const c = findControl(state, decision.target);
      const field = c ? String(c.name || c.role) : decision.target;
      // B1: if this field looks secret, record the ACTUAL typed value into the run-scoped
      // secret set so it is masked wherever it later appears in details/logs/overlay. The
      // real value is still typed into the page below (automation is never weakened).
      if (options.redactSecrets && value && c && isSecretField(`${c.type ?? ""} ${c.name}`)) {
        options.secrets.add(value);
      }
      await narrator.focusTarget(decision.target, `Typing ${field}\u2026`);
      const retries = await runWithSelfHeal(
        session,
        narrator,
        { ref: decision.target, name: c ? String(c.name) : "", role: c ? c.role : "" },
        options.selfHealRetries,
        async (ref) => {
          const fa = await fastAct(ref, "fill", value);
          if (fa.handled) {
            if (fa.soft) throw softError(fa.soft);
            return;
          }
          await (await session.locate(ref)).fill(value);
        },
        options.captureOptions,
      );
      return {
        detail: `TYPE_TEXT ${decision.target} = ${JSON.stringify(value)}`,
        ...(retries > 0 ? { retries } : {}),
      };
    }
    case "SELECT": {
      const value = resolveValue(decision, state) ?? "";
      const c = findControl(state, decision.target);
      const field = c ? String(c.name || c.role) : decision.target;
      await narrator.focusTarget(decision.target, `Selecting ${field}`);
      const retries = await runWithSelfHeal(
        session,
        narrator,
        { ref: decision.target, name: c ? String(c.name) : "", role: c ? c.role : "" },
        options.selfHealRetries,
        async (ref) => {
          const fa = await fastAct(ref, "select", value);
          if (fa.handled) {
            if (fa.soft) throw softError(fa.soft);
            return;
          }
          const locator = await session.locate(ref);
          await locator.selectOption({ label: value }).catch(async () => {
            await locator.selectOption(value);
          });
        },
        options.captureOptions,
      );
      return {
        detail: `SELECT ${decision.target} = ${JSON.stringify(value)}`,
        ...(retries > 0 ? { retries } : {}),
      };
    }
    case "HOVER": {
      const c = findControl(state, decision.target);
      const name = c ? String(c.name || c.role) : decision.target;
      await narrator.focusTarget(decision.target, `Hovering ${name}`);
      const retries = await runWithSelfHeal(
        session,
        narrator,
        { ref: decision.target, name: c ? String(c.name) : "", role: c ? c.role : "" },
        options.selfHealRetries,
        async (ref) => {
          await (await session.locate(ref)).hover();
        },
        options.captureOptions,
      );
      return {
        detail: `HOVER ${decision.target}${c ? ` (${c.role} ${JSON.stringify(c.name)})` : ""}`,
        ...(retries > 0 ? { retries } : {}),
      };
    }
    case "FILL_FORM": {
      // Batch fill: apply every field in ONE step, reusing the same field-fill logic as the
      // browser_fill_form tool so the deterministic "faster" path matches the manual tool.
      const filled: string[] = [];
      for (const field of decision.fields) {
        const control = findControl(state, field.target);
        const label = control ? String(control.name || control.role) : field.target;
        // B1: record the ACTUAL value of any secret-looking field into the run-scoped set so
        // it is masked in the transcript/logs/overlay; the real value is still filled below.
        if (
          options.redactSecrets &&
          field.value &&
          control &&
          isSecretField(`${control.type ?? ""} ${control.name}`)
        ) {
          options.secrets.add(field.value);
        }
        // Tier 1: spotlight/cursor each field in turn as it is filled.
        await narrator.focusTarget(field.target, `Filling ${label}\u2026`);
        const kind = fieldKindFor(control);
        // (F1) Fast path: fill/select the OBSERVED node with no fresh selector query. A
        // checkbox/radio still goes through the legacy applyFieldValue (its toggle semantics
        // are richer than a raw value set); a text/combobox fill or a select uses actOnNode.
        // On a soft stale/covered result or a ref without fast identity, fall back to the
        // legacy locator fill so a batch never silently drops a field.
        const fastKind: "fill" | "select" | undefined =
          kind === "combobox" ? "select" : kind === "checkbox" || kind === "radio" ? undefined : "fill";
        let handledFast = false;
        if (fastKind !== undefined) {
          const fa = await fastAct(field.target, fastKind, field.value);
          handledFast = fa.handled && fa.soft === undefined;
        }
        if (!handledFast) {
          const locator = await session.locate(field.target);
          await applyFieldValue(locator, field.value, kind);
        }
        filled.push(`${field.target}=${JSON.stringify(field.value)}`);
      }
      return { detail: `FILL_FORM [${filled.join(", ")}]` };
    }
    case "PRESS_KEY": {
      const page = await session.getPage();
      await page.keyboard.press(decision.key);
      return { detail: `PRESS_KEY ${JSON.stringify(decision.key)}` };
    }
    case "NAVIGATE_BACK": {
      const page = await session.getPage();
      await narrator.toast("Navigating\u2026");
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await narrator.toast("Navigation complete");
      return { detail: "NAVIGATE_BACK" };
    }
    case "NAVIGATE": {
      const page = await session.getPage();
      await narrator.toast("Navigating\u2026");
      // Bounded so a hostile or hanging target cannot stall the whole run; a failed navigation
      // leaves the loop to re-capture and re-plan on the current page.
      await page
        .goto(decision.url, { waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => undefined);
      await narrator.toast("Navigation complete");
      return { detail: `NAVIGATE ${decision.url}` };
    }
    case "SCROLL_DOWN": {
      const page = await session.getPage();
      const by = options.scrollBy;
      await page.evaluate(
        (px) => window.scrollBy(0, px ?? window.innerHeight),
        by ?? null,
      );
      // Tier 3: report the new scroll position after the scroll.
      const position = await page
        .evaluate(() => Math.round(window.scrollY))
        .catch(() => undefined);
      await narrator.scrollIndicator("down", position ?? undefined);
      return { detail: "SCROLL_DOWN" };
    }
    case "WAIT": {
      const page = await session.getPage();
      // Tier 3: show the countdown ring (a no-op unless config.overlay.waitCountdown is on).
      await narrator.countdown(options.waitMs);
      await page.waitForTimeout(options.waitMs);
      return { detail: `WAIT ${options.waitMs}ms` };
    }
    case "SCREENSHOT": {
      // Terminal/verification step: capture the page. We record that a screenshot was taken
      // (verified=true) without persisting bytes, so the transcript proves the step ran.
      const page = await session.getPage();
      await page.screenshot();
      return { detail: "SCREENSHOT", verified: true };
    }
    case "VERIFY": {
      // Terminal verification: check the expected marker against the LIVE page text/title.
      const snapshot = await capture(await session.getPage(), options.captureOptions);
      const haystack = `${snapshot.title} ${snapshot.visibleText}`.toLowerCase();
      const verified = haystack.includes(decision.marker.toLowerCase());
      return {
        detail: `VERIFY ${JSON.stringify(decision.marker)} -> ${verified ? "present" : "absent"}`,
        verified,
      };
    }
    case "DONE":
      return { detail: "DONE" };
    case "BLOCKED":
      return { detail: "BLOCKED" };
  }
}

/**
 * (B1) Return a copy of a snapshot with every captured secret value masked in its
 * human-readable text, its visible text, and each control's displayed value. The final
 * snapshot is surfaced to the client (and rendered by renderRunResult), and a secret-looking
 * field carries its real value on the live page, so this masks that echo without touching the
 * page. `redact` is the run-scoped redactor; when redaction is off the caller passes identity.
 */
/**
 * (T5) Summarise how a run's steps were decided into an {@link AutonomySummary}. A step is
 * FULLY AUTONOMOUS when its source is `rule` / `laya` / `stub` (decided locally, no client
 * LLM round-trip); an `llm` step is the one place the run reached out to the client. Pure and
 * total-safe: an empty transcript yields all-zero counts with `autonomousPct` = 0.
 */
export function summariseAutonomy(transcript: StepRecord[]): AutonomySummary {
  const counts = { rule: 0, laya: 0, stub: 0, llm: 0 };
  for (const s of transcript) counts[s.source] += 1;
  const total = transcript.length;
  const fullyAutonomous = counts.rule + counts.laya + counts.stub;
  return {
    total,
    rule: counts.rule,
    laya: counts.laya,
    stub: counts.stub,
    llm: counts.llm,
    fullyAutonomous,
    autonomousPct: total === 0 ? 0 : fullyAutonomous / total,
  };
}

/**
 * (D1) Build a per-step observability artifact from the step's recorded transcript entry,
 * the start-of-step snapshot text, the captured screenshot, and the elapsed step time. All
 * text on the {@link StepRecord} is already redacted per B1, and `snapshotText` is passed in
 * already redacted, so the artifact carries no secrets.
 */
function buildArtifact(
  record: StepRecord,
  snapshotText: string,
  screenshotPng: string | undefined,
  durationMs: number,
): RunStepArtifact {
  return {
    step: record.step,
    operation: record.operation,
    ...(record.target !== undefined ? { target: record.target } : {}),
    operationConfidence: record.operationConfidence,
    targetConfidence: record.targetConfidence,
    source: record.source,
    detail: record.detail,
    ...(record.note !== undefined ? { note: record.note } : {}),
    durationMs,
    snapshot: snapshotText,
    ...(screenshotPng !== undefined ? { screenshotPng } : {}),
  };
}

/**
 * (F1) The per-ref fast-path side data captured alongside a {@link FastSnapshot}: each control's
 * persistent nodeId, its semantic guard, and its geometry rect. Keyed by ref so the decision
 * layer keeps using plain refs (buildState / the engine are unchanged); the loop looks the
 * extra identity up here when it executes a targeted action via the persistent-identity path.
 */
interface FastContext {
  /** Per-ref identity + guard + rect for the CURRENT observation. */
  byRef: Map<string, { nodeId: number; guard: NodeGuard; rect: FastControl["rect"] }>;
  /** The pageKey of the current observation (used for the click/select freshness re-check). */
  pageKey: string;
  /** The whole-page marker of the current observation (used for non-targeted freshness). */
  marker: string;
}

/**
 * (F1) Project a {@link FastSnapshot} down to the plain {@link Snapshot} the state builder and
 * engine consume, and build the {@link FastContext} side map keyed by ref. The Snapshot's
 * `controls` are the SAME FastControl objects (a FastControl is a Control), so nothing about
 * buildState / the decision layer changes; the nodeId/guard/rect simply ride along on the side
 * map for the loop to use at execution time.
 */
function projectFast(fast: FastSnapshot): { snapshot: Snapshot; ctx: FastContext } {
  const byRef = new Map<
    string,
    { nodeId: number; guard: NodeGuard; rect: FastControl["rect"] }
  >();
  for (const c of fast.controls) {
    byRef.set(c.ref, { nodeId: c.nodeId, guard: c.guard, rect: c.rect });
  }
  const snapshot: Snapshot = {
    url: fast.url,
    title: fast.title,
    visibleText: fast.visibleText,
    controls: fast.controls,
    text: fast.text,
  };
  return { snapshot, ctx: { byRef, pageKey: fast.pageKey, marker: fast.marker } };
}

/**
 * (F4) A speculatively-computed decision, cached during the previous step's settle window and
 * reused at the top of the next iteration when the page is proven unchanged and the target is
 * still fresh. `decision`/`note` are exactly what the ordinary pipeline would have produced;
 * carrying them here only overlaps the compute cost with the settle wait, so the observed
 * decision sequence and outcomes are IDENTICAL to not speculating.
 */
interface SpeculativeDecision {
  decision: Decision;
  note: string | undefined;
}

/**
 * (F4) Compute the decision the pipeline WOULD produce for `state`, but ONLY for the cases that
 * never need the client-LLM escalation (a rule seed, or a high-confidence non-BLOCKED engine
 * decision). Returns undefined when the ordinary pipeline would escalate/block/degrade, so the
 * real iteration takes its normal (observable) escalation path and speculation stays invisible.
 *
 * This mirrors the loop's own pipeline order (policySeed -> engine.decide -> refine) EXACTLY,
 * so a cached decision equals the one the un-speculated step would have made. It performs NO
 * IO beyond the engine's local decide (no page reads, no sampling), so it is safe to overlap
 * with the settle probe.
 */
async function computeSpeculativeDecision(
  state: PageState,
  engine: LayaDecisionEngine,
  confidenceThreshold: number,
): Promise<SpeculativeDecision | undefined> {
  const seed = policySeed(state);
  if (seed) {
    return { decision: seed.decision, note: `rule: ${seed.reason}` };
  }
  if (!engine.available) return undefined;
  const decision = refineWithGoalValue(await engine.decide(state), state);
  // Only cache a decision the confidence gate would accept WITHOUT escalating; anything the
  // real step would escalate/block is deliberately not speculated (its escalation is observable
  // and must run on the real iteration).
  const lowConfidence =
    decision.operationConfidence < confidenceThreshold ||
    decision.targetConfidence < confidenceThreshold;
  if (lowConfidence || decision.operation === "BLOCKED") return undefined;
  return { decision, note: undefined };
}

/**
 * (F4) Whether a cached speculative decision's TARGET is still fresh on the live page, using the
 * FEAT-002 freshness re-check. For a targeted operation (CLICK/TYPE_TEXT/SELECT/HOVER, or a
 * FILL_FORM whose every field target still has fast identity) it re-checks each target's
 * guard + pageKey against what the speculative capture observed; for a non-targeted operation
 * (DONE/WAIT/SCROLL_DOWN/etc.) it re-checks the whole-page marker. Any stale/gone target (or a
 * target that lacks fast identity, so it cannot be re-checked) makes the whole decision unsafe
 * to reuse and returns false, so the loop decides fresh. Never throws (freshGuard is guarded).
 */
async function speculativeTargetFresh(
  session: BrowserSession,
  page: Page,
  decision: Decision,
  ctx: FastContext,
): Promise<boolean> {
  const checkRef = async (ref: string): Promise<boolean> => {
    const entry = ctx.byRef.get(ref);
    if (!entry) return false;
    return session.freshGuard(page, entry.nodeId, {
      guard: entry.guard,
      pageKey: ctx.pageKey,
    });
  };
  switch (decision.operation) {
    case "CLICK":
    case "TYPE_TEXT":
    case "SELECT":
    case "HOVER":
      return checkRef(decision.target);
    case "FILL_FORM": {
      for (const f of decision.fields) {
        if (!(await checkRef(f.target))) return false;
      }
      return true;
    }
    default:
      // Non-targeted operation: the whole page must be unchanged.
      return session.freshGuard(page, undefined, { marker: ctx.marker });
  }
}

function redactSnapshot(snapshot: Snapshot, redact: (text: string) => string): Snapshot {
  return {
    ...snapshot,
    visibleText: redact(snapshot.visibleText),
    text: redact(snapshot.text),
    controls: snapshot.controls.map((c) =>
      c.value !== undefined ? { ...c, value: redact(c.value) } : c,
    ),
  };
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
    plannerAvailable,
    allowedDomains = [],
    destructiveFormGuard = true,
    selfHealRetries = DEFAULT_SELF_HEAL_RETRIES,
    settleProbe = true,
    loopDetection = true,
    loopWindow = DEFAULT_LOOP_WINDOW,
    redactSecrets = true,
    confirm,
    snapshotBackend = DEFAULT_SNAPSHOT_BACKEND,
    // Deliberate default asymmetry: this loop option defaults to false to preserve DOM order
    // for the existing autopilot unit tests, while the shipped config default
    // (LAYA_VIEWPORT_PRIORITY) is true and src/server.ts threads that in for production runs.
    viewportPriority = false,
    deltaPrompt = false,
    overlay,
    overlayPage,
    recordArtifacts = false,
    loopScreenshots = false,
    autoDismiss = false,
    frameDepth = 0,
    onProgress,
  } = options;

  // (T1.4) Whether ANY per-step screenshot is captured. Recording artifacts implies a
  // screenshot (the replay needs it); the independent loopScreenshots flag can also force it.
  const captureStepScreenshot = recordArtifacts || loopScreenshots;

  // (C1/C3/T2.3) The capture options used for EVERY snapshot this run takes, so the per-step
  // capture, the self-healing re-capture, and the final verification all agree on backend,
  // ordering, and frame-descent depth.
  const captureOptions: CaptureOptions = {
    backend: snapshotBackend,
    viewportPriority,
    frameDepth,
  };

  // (B1) The run-scoped set of ACTUAL secret values the loop typed into secret-looking
  // fields. A redactor bound to this set masks those values (and common secret patterns) out
  // of any string that reaches the transcript, the overlay, or a log. Masking the DISPLAYED
  // representation only; the real value is always still typed into the page. When
  // redactSecrets is off, the redactor is the identity function (unchanged behaviour).
  const secrets = new Set<string>();
  const redact = (text: string): string =>
    redactSecrets ? redactText(text, [...secrets]) : text;

  // A single narration facade for the whole run. Inert when no overlay/page was threaded in
  // (all existing autopilot tests), so it never changes automation semantics.
  const narrator = new Narrator(overlay, overlayPage, redact);

  // (R2) Autonomy without local weights. The loop used to refuse outright whenever the Laya
  // engine had no weights, which made the goal command unable to do ANYTHING without a ~1.7GB
  // model bundle. When the client can answer an MCP sampling request it can plan the step
  // itself, so the run proceeds with the client LLM as the planner and the deterministic rule
  // layer still seeding the high-confidence steps. The `degraded` result (and its launch-free
  // hint) is now reserved for the case where NEITHER planner exists.
  const canPlan =
    engine.available ||
    (sample !== undefined && (plannerAvailable === undefined || plannerAvailable()));

  // Graceful degradation when there is neither a local engine nor a client that can plan.
  if (!canPlan) {
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
  // (R3) A warning the relaxed hard stops surfaced, echoed on the HUD once the run starts and
  // carried into the transcript's recent-actions log so it reaches the escalation prompt too.
  let runWarning: string | undefined;
  if (url) {
    // Domain allow-list guard. It used to abort the whole goal before a single step ran, which
    // meant one off-list URL made the tool unable to do anything at all. It now CONFIRMS when a
    // confirm callback is available and otherwise proceeds with a warning, so an autonomous run
    // can finish; an explicit refusal still blocks, and the fail-safe is unchanged when there is
    // nobody to ask... which for a warning-only guard is "proceed, loudly".
    const verdict = checkDomainAllowed(url, allowedDomains);
    if (!verdict.allowed) {
      let approved = true;
      if (confirm) {
        try {
          approved = await confirm(
            `Navigate off the allow-list to ${url} - approve?`,
          );
        } catch {
          approved = false;
        }
      }
      if (!approved) {
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
      runWarning = verdict.reason ?? `Navigating off the allow-list to ${url}.`;
    }
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  // (Issues 2 + 4) Announce that Laya is controlling the browser: make the synthetic cursor
  // visible from the start (it then moves in real time via focusTarget->moveCursor per step).
  // The four-corner session frame is armed by the overlay itself, for every mode. Both are
  // best-effort no-ops when no overlay/page is present.
  await narrator.beginRun();

  const recentActions: string[] = [];
  const warnings: string[] = [];
  if (runWarning !== undefined) {
    await narrator.notice(runWarning, "uncertain");
    recentActions.push(runWarning);
    warnings.push(runWarning);
  }
  const transcript: StepRecord[] = [];
  // (D1) Per-step observability artifacts, accumulated only when recordArtifacts is on.
  const artifacts: RunStepArtifact[] = [];
  let outcome: RunOutcome = "max_steps";
  let lastSnapshot: Snapshot | undefined;
  // (F4) The FAST-path speculative overlap. During the previous step's settle probe, when the
  // page was already settled AND an engine is available, we ALSO capture a speculative
  // FastSnapshot and pre-compute the next decision against it (both overlapping the probe wait).
  // At the top of the next iteration, when the prefetched fast snapshot is reused (page proven
  // unchanged) and the FEAT-002 freshness re-check confirms the cached decision's target is
  // still fresh, the cached decision is used instead of recomputing. DISCARDED on ANY drift
  // (probe changed / auto-dismiss ran / guard stale). This is a PURE optimization: the observed
  // decision sequence is identical to not speculating; only wall-clock overlap changes.
  let prefetchedFast: { snapshot: Snapshot; ctx: FastContext } | undefined;
  let speculativeDecision: SpeculativeDecision | undefined;
  // (C2) The snapshot captured on the PREVIOUS step, kept so each step can diff against it
  // (surface "N new controls appeared") and the escalation path can send only the delta.
  let prevSnapshot: Snapshot | undefined;
  // (A3) Rolling window of per-step signatures for loop detection. A signature is the URL +
  // the sorted set of control name+role pairs + the decision (operation/target/value). When
  // the last `loopWindow` signatures are all identical the run has made no progress.
  const signatures: string[] = [];

  // (T3.1) Running cost counters surfaced on the HUD meter: how many escalations to the client
  // LLM happened, and a rough token estimate for the run. Tokens are estimated from the sizes
  // of the escalation prompt (~the page-state text) and its reply at ~4 chars/token (a common
  // English heuristic); local-only steps add no LLM tokens. Purely observational.
  let escalationCount = 0;
  let estimatedTokens = 0;
  const estimateTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / 4);

  try {
    for (let step = 1; step <= maxSteps; step++) {
      // Tier 4 heartbeat + Tier 2 thinking HUD: announce the step and enter the thinking
      // state BEFORE the (potentially slow) decision pipeline runs.
      await narrator.beginStep(step, maxSteps);

      // (D1) Start-of-step wall clock, used for the per-step timing artifact.
      const stepStart = Date.now();

      // (F4) Grab and clear the speculative fast prefetch + cached decision computed during the
      // previous step's settle window. Consumed below only on the fast path and only when the
      // page is proven unchanged and the cached target is still fresh; discarded otherwise.
      const speculatedFast = prefetchedFast;
      const speculatedDecision = speculativeDecision;
      prefetchedFast = undefined;
      speculativeDecision = undefined;

      // (T2.2) Before capturing/deciding, optionally auto-dismiss cookie/consent banners and
      // blocking modal overlays so they do not hide the real controls. Conservative + bounded
      // (never clicks destructive controls). Each dismissal is surfaced on the overlay with a
      // distinct toast (T3.2) and noted in the transcript's recent-actions log. Best-effort.
      if (autoDismiss) {
        const dismissed = await autoDismissOverlays(page);
        for (const d of dismissed) {
          const label =
            d.kind === "consent"
              ? `Closed cookie banner (${d.clicked})`
              : `Closed modal (${d.clicked})`;
          await narrator.notice(label, "info");
          recentActions.push(label);
        }
      }

      // (F1) Capture the atomic FastSnapshot (persistent identity + guards + marker + pageKey
      // in ONE evaluate) and project it to the plain Snapshot the state builder / the engine
      // consume, keeping the nodeId/guard/rect on a side map keyed by ref.
      let fastCtx: FastContext;
      let snapshot: Snapshot;
      // (F4) Whether the speculative fast prefetch is safe to reuse this step: it exists, the
      // previous probe reported no change (that is the only condition under which it is kept),
      // and no auto-dismiss ran this step (which could mutate the page). On reuse we skip the
      // captureFast round-trip; otherwise we capture fresh and DISCARD any cached decision.
      const canReuseFast = speculatedFast !== undefined && !autoDismiss;
      if (canReuseFast) {
        snapshot = speculatedFast!.snapshot;
        fastCtx = speculatedFast!.ctx;
      } else {
        const projected = projectFast(await captureFast(page, captureOptions));
        snapshot = projected.snapshot;
        fastCtx = projected.ctx;
      }
      lastSnapshot = snapshot;

      // (D1) Optional per-step PNG screenshot, captured only when recording is enabled so
      // normal runs are not slowed. Best-effort: any failure leaves the artifact without an
      // image rather than failing the run.
      let stepScreenshot: string | undefined;
      if (captureStepScreenshot) {
        try {
          const png = await page.screenshot({ type: "png" });
          stepScreenshot = png.toString("base64");
        } catch {
          stepScreenshot = undefined;
        }
      }
      const state = buildState(goal, snapshot, recentActions, stateOptions);

      // (C2) Diff this snapshot against the previous step's snapshot. When new controls
      // appeared, surface it as a first-class overlay toast / activity-log event. The diff is
      // also handed to the escalation path so it can send a delta-only prompt.
      const diff = diffSnapshots(prevSnapshot, snapshot);
      const isFirstStep = prevSnapshot === undefined;
      if (!isFirstStep && diff.added.length > 0) {
        const plural = diff.added.length === 1 ? "control" : "controls";
        await narrator.notice(`${diff.added.length} new ${plural} appeared`, "info");
      }
      // Advance the previous-snapshot pointer AFTER computing the diff for this step.
      prevSnapshot = snapshot;

      // Decision pipeline (order matters):
      //   1. deterministic-rule SEED — high-confidence rules per the laya-ultrafast lesson;
      //   2. Laya NARROW decision — the engine resolves the element/operation otherwise;
      //   3. confidence CHECK — escalate to the client LLM (MCP sampling) when low/BLOCKED.
      let note: string | undefined;

      // (T5) Measure the DECISION wall-time (policy seed + Laya inference + escalation), so the
      // per-step inferenceMs and the run's autonomy latency are measurable. This spans only the
      // decision pipeline; the action IO below is deliberately excluded.
      const decisionStart = Date.now();

      // (F4) Reuse the speculative decision computed during the previous settle window, but
      // ONLY when the fast prefetch it was computed against is the very snapshot we are using
      // now (canReuseFast) AND the FEAT-002 freshness re-check confirms the cached decision's
      // target is still fresh on the live page. On any drift we fall through to the ordinary
      // pipeline and decide fresh, so the observed decision is identical to not speculating.
      let reused: Decision | undefined;
      if (canReuseFast && speculatedDecision !== undefined) {
        const fresh = await speculativeTargetFresh(
          session,
          page,
          speculatedDecision.decision,
          fastCtx,
        );
        if (fresh) {
          reused = speculatedDecision.decision;
          note = speculatedDecision.note;
        }
      }

      const seed = reused === undefined ? policySeed(state) : undefined;
      let decision: Decision;
      if (reused !== undefined) {
        // Cached speculative decision reused; skip the (redundant) recompute.
        decision = reused;
      } else if (seed) {
        decision = seed.decision;
        note = `rule: ${seed.reason}`;
      } else if (engine.available) {
        // Laya answers the narrow question; fill goal-stated values it did not supply.
        decision = refineWithGoalValue(await engine.decide(state), state);
      } else {
        // (R2) LLM-planned step. With no local weights there is nothing to ask, so the step is
        // deliberately left below the confidence threshold with a BLOCKED placeholder: the
        // confidence check below then routes it through the SAME escalation path, which is where
        // the client LLM chooses the step. Same plumbing, same parsing, same guards.
        decision = {
          operation: "BLOCKED",
          operationConfidence: 0,
          targetConfidence: 0,
          source: "laya",
        };
      }

      // Confidence check: escalate on low confidence or BLOCKED (never for rule seeds,
      // which are high-confidence-deterministic by construction).
      const lowConfidence =
        decision.operationConfidence < confidenceThreshold ||
        decision.targetConfidence < confidenceThreshold;
      if (decision.source !== "rule" && (lowConfidence || decision.operation === "BLOCKED")) {
        // Tier 3: colour the HUD amber to signal low-confidence escalation to the LLM.
        await narrator.stateWithToast(
          "uncertain",
          "Low confidence \u2014 asking the LLM\u2026",
          "Escalating to the LLM for the next step",
          "uncertain",
        );
        // (C2) When delta prompting is enabled and a meaningful diff exists (and this is not
        // the first step), escalate with a delta-only prompt to cut tokens; otherwise the
        // full-snapshot prompt is used (the default).
        // (T4) Thread Laya's ORIGINAL (pre-escalation) decision through as the fallback so an
        // UNREACHABLE client LLM (no sampling, or the request throws/times out) degrades to
        // Laya's best guess instead of hard-BLOCKING the run. escalate() only uses the fallback
        // when the LLM is unreachable AND the fallback is not itself BLOCKED (so the R2
        // no-weights placeholder still degrades gracefully to BLOCKED).
        //
        // (FEAT-003) Break the low-confidence-BLOCKED dead-end: when the pre-escalation decision
        // is a LOW-CONFIDENCE BLOCKED (this branch is only reached when lowConfidence is true or
        // the op is BLOCKED, so a BLOCKED reaching here that is ALSO low-confidence is exactly
        // the trap), inject a best-safe-progress resolver bound to THIS page. escalate() consults
        // it ONLY when the LLM is unreachable AND there is no usable non-BLOCKED fallback, so a
        // CONFIDENT BLOCKED (deliberate stop) is never softened - we only pass the resolver for a
        // low-confidence BLOCKED. A genuinely dead page yields undefined and stays BLOCKED, and
        // the loop detector still terminates a run that cannot make real progress.
        const lowConfidenceBlocked =
          decision.operation === "BLOCKED" && lowConfidence;
        const escalationOptions: EscalationOptions = {
          fallback: decision,
          ...(deltaPrompt && !isFirstStep && hasChanges(diff) ? { diff } : {}),
          ...(lowConfidenceBlocked
            ? { bestSafeProgress: () => bestSafeProgress(state) }
            : {}),
        };
        const result = await escalate(state, sample, escalationOptions);
        decision = refineWithGoalValue(result.decision, state);
        note = result.note;
        // (T3.1) Count a real escalation (the client produced a decision) and estimate its
        // token cost from the state text sent plus a small allowance for the reply. Only
        // counts when the client actually answered (result.escalated), not the degraded path.
        if (result.escalated) {
          escalationCount += 1;
          estimatedTokens += estimateTokens(renderState(state).length) + 64;
        }
      }

      // (T5) The decision is now final for this step; record how long deciding it took.
      const inferenceMs = Date.now() - decisionStart;

      // (T3.1) Refresh the HUD cost meter after the decision pipeline so the step count and
      // escalation/token spend stay current as the run progresses.
      await narrator.meter(step, escalationCount, estimatedTokens);

      if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
        const terminalRecord: StepRecord = {
          step,
          operation: decision.operation,
          operationConfidence: decision.operationConfidence,
          targetConfidence: decision.targetConfidence,
          source: decision.source,
          detail: decision.operation,
          inferenceMs,
          ...(note ? { note } : {}),
        };
        transcript.push(terminalRecord);
        if (recordArtifacts) {
          artifacts.push(
            buildArtifact(
              terminalRecord,
              redact(snapshot.text),
              stepScreenshot,
              Date.now() - stepStart,
            ),
          );
        }
        recentActions.push(decision.operation);
        await narrator.log(decision.operation);
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
            // B2 + (R3): human-in-the-loop confirmation. Whenever a confirm callback is
            // available the loop ASKS (amber "awaiting confirmation" HUD) instead of
            // hard-blocking the goal, so an autonomous run can finish a destructive submit once
            // a human approves it. Approval proceeds with the CLICK; a refusal keeps the block.
            // Only when there is nobody to ask does the refuse-by-default fail-safe apply, which
            // is exactly the previous behaviour. (`confirmDestructive` no longer gates the ask:
            // asking whenever it is possible is what makes the flag redundant rather than
            // silently ignored - see the option's doc comment.)
            let approved = false;
            if (confirm) {
              const targetName = String(target.name || target.role);
              const prompt = `About to click ${JSON.stringify(targetName)} - approve?`;
              await narrator.stateWithToast(
                "uncertain",
                `Awaiting confirmation: ${prompt}`,
                prompt,
                "uncertain",
              );
              // The confirm callback must never throw; guard defensively regardless so the
              // loop degrades to a refusal (fail-safe) rather than erroring out.
              try {
                approved = await confirm(prompt);
              } catch {
                approved = false;
              }
            }
            if (!approved) {
              const guardRecord: StepRecord = {
                step,
                operation: "BLOCKED",
                operationConfidence: 1,
                targetConfidence: 1,
                source: decision.source,
                detail: "BLOCKED (destructive-form guard)",
                inferenceMs,
                note: guard.reason ?? "Destructive-form guard refused the auto-submit.",
              };
              transcript.push(guardRecord);
              if (recordArtifacts) {
                artifacts.push(
                  buildArtifact(
                    guardRecord,
                    redact(snapshot.text),
                    stepScreenshot,
                    Date.now() - stepStart,
                  ),
                );
              }
              recentActions.push("BLOCKED (destructive-form guard)");
              await narrator.log("BLOCKED (destructive-form guard)");
              outcome = "blocked";
              break;
            }
            // Approved: fall through and execute the CLICK. The approval is noted on the
            // step record below so the transcript records that a human authorised it.
            note = note
              ? `${note}; approved via confirmation`
              : "approved via confirmation";
            await narrator.stateWithToast(
              "acting",
              "Approved - proceeding",
              "Approved - proceeding",
              "info",
            );
          }
        }
      }

      // (R4) An LLM-chosen NAVIGATE is still subject to the domain allow-list, under the same
      // relaxed rule as the initial navigation: ask when there is somebody to ask, warn and
      // proceed when there is not. Without this a planner could hop anywhere mid-run while the
      // configured list only ever constrained the FIRST url.
      if (decision.operation === "NAVIGATE") {
        const verdict = checkDomainAllowed(decision.url, allowedDomains);
        if (!verdict.allowed) {
          let approved = true;
          if (confirm) {
            try {
              approved = await confirm(
                `Navigate off the allow-list to ${decision.url} - approve?`,
              );
            } catch {
              approved = false;
            }
          }
          if (!approved) {
            const navRecord: StepRecord = {
              step,
              operation: "BLOCKED",
              operationConfidence: 1,
              targetConfidence: 1,
              source: decision.source,
              detail: "BLOCKED (navigation refused)",
              inferenceMs,
              note: verdict.reason ?? "Navigation refused by the domain allow-list.",
            };
            transcript.push(navRecord);
            recentActions.push("BLOCKED (navigation refused)");
            await narrator.log("BLOCKED (navigation refused)");
            outcome = "blocked";
            break;
          }
          const warning = verdict.reason ?? `Navigating off the allow-list to ${decision.url}.`;
          await narrator.notice(warning, "uncertain");
          recentActions.push(warning);
          warnings.push(warning);
        }
      }

      // Tier 2: switch to the acting state with an op-appropriate caption just before IO.
      // Targeted ops (CLICK/TYPE_TEXT/SELECT/HOVER/FILL_FORM) render their own cursor/spotlight
      // caption inside execute(); non-targeted ops get a status here.
      const acting = actionCaption(decision, state);
      await narrator.setState("acting", acting);
      // (D2) Mirror the on-page progress on the MCP protocol. The message is redacted (the
      // acting caption may name a control) and formatted like 'step 3/15: clicking Sign in'.
      // A no-op when no onProgress was supplied, preserving existing behaviour.
      if (onProgress) {
        const message = redact(`step ${step}/${maxSteps}: ${lowerFirst(acting)}`);
        await onProgress({ step, total: maxSteps, message });
      }
      // Capture the pre-action URL so the settle probe can tell whether we navigated.
      const beforeUrl = page.url();
      const executed = await execute(
        decision,
        state,
        {
          waitMs,
          scrollBy,
          selfHealRetries,
          redactSecrets,
          secrets,
          captureOptions,
          // (F1) Thread the fast context for this step's targeted execution.
          fast: { ctx: fastCtx, capMs: FAST_WAIT_CAP_MS },
        },
        session,
        narrator,
      );
      const record: StepRecord = {
        step,
        operation: decision.operation,
        operationConfidence: decision.operationConfidence,
        targetConfidence: decision.targetConfidence,
        source: decision.source,
        // B1: mask any captured secret value out of the human-readable detail string.
        detail: redact(executed.detail),
        inferenceMs,
        ...(note ? { note: redact(note) } : {}),
      };
      if (decision.target !== undefined) record.target = decision.target;
      const value = "value" in decision ? decision.value : undefined;
      // B1: store the MASKED form of the value / batch fields in the transcript. The real
      // value was already typed into the page inside execute(); only this recorded echo is
      // masked so the transcript never carries a secret.
      if (value !== undefined) record.value = redact(value);
      if (decision.operation === "PRESS_KEY") record.key = decision.key;
      if (decision.operation === "FILL_FORM") {
        record.fields = decision.fields.map((f) => ({
          target: f.target,
          value: redact(f.value),
        }));
      }
      if (decision.operation === "VERIFY") record.marker = decision.marker;
      if (executed.verified !== undefined) record.verified = executed.verified;
      if (executed.retries !== undefined) record.retries = executed.retries;
      transcript.push(record);
      // B1: keep the recent-action log (which is rendered back into the next PageState and
      // can reach the escalation LLM prompt) masked too, so no secret leaks downstream.
      recentActions.push(redact(executed.detail));
      // Tier 4: mirror the transcript line into the on-page activity-log feed (already
      // redacted inside the narrator).
      await narrator.log(executed.detail);

      // SCREENSHOT and VERIFY are terminal/verification steps: once one runs, the goal-run
      // ends (a VERIFY reports its result; a SCREENSHOT captures the final page).
      if (decision.operation === "VERIFY" || decision.operation === "SCREENSHOT") {
        if (recordArtifacts) {
          artifacts.push(
            buildArtifact(record, redact(snapshot.text), stepScreenshot, Date.now() - stepStart),
          );
        }
        outcome = "done";
        break;
      }

      // A2: purely-observational settle probe. It NEVER changes the decision path or outcome;
      // it only records `settled` on the step and narrates a hint. Terminal ops already broke
      // out above, so this runs only for the continuing loop. The targeted action already did
      // its own bounded adaptiveWait and the next iteration captures a fresh FastSnapshot, so
      // this probe only records `settled` observationally and overlaps a speculative prefetch.
      if (settleProbe) {
        const beforeUrlFast = beforeUrl;
        // (F4) Overlap the settle probe with a speculative fast capture for the NEXT step, and
        // (when the page is already settled and an engine is available) a speculative DECIDE
        // against that capture. All three are independent local reads/compute run concurrently
        // with the probe's wait window, so the compute cost is hidden. We KEEP the speculative
        // snapshot + decision ONLY when the probe reports NO change (the capture is then current,
        // so reusing it at the next step top is byte-identical to capturing there); on ANY change
        // we discard both and the next iteration captures + decides fresh. The freshness re-check
        // at the next step top is the final guard before the cached decision is actually used.
        const [probe, speculativeFast] = await Promise.all([
          session
            .probeSettle(page, { beforeUrl: beforeUrlFast, timeoutMs: FAST_WAIT_CAP_MS })
            .catch(() => ({ changed: false, urlChanged: false, mutations: 0 })),
          captureFast(page, captureOptions)
            .then((f) => projectFast(f))
            .catch(() => undefined),
        ]);
        record.settled = probe.changed;
        if (!probe.changed && speculativeFast !== undefined) {
          prefetchedFast = speculativeFast;
          // Pre-compute the next decision against the settled speculative state. Skipped
          // silently on any failure so speculation never affects the run.
          const specState = buildState(
            goal,
            speculativeFast.snapshot,
            recentActions,
            stateOptions,
          );
          speculativeDecision = await computeSpeculativeDecision(
            specState,
            engine,
            confidenceThreshold,
          ).catch(() => undefined);
        }
      }

      // (D1) Record the per-step artifact for a continuing step (terminal steps recorded
      // above). Timing spans decision + execution + settle probe.
      if (recordArtifacts) {
        artifacts.push(
          buildArtifact(record, redact(snapshot.text), stepScreenshot, Date.now() - stepStart),
        );
      }

      // A3: loop-detection / stuck guard. Signature = URL + sorted control name+role set +
      // the decision. When the last `loopWindow` signatures are all identical the run is not
      // progressing; bail early with the additive `stuck` outcome rather than burning the
      // full budget.
      if (loopDetection) {
        const controlSig = state.controls
          .map((c) => `${c.role}\u0000${String(c.name)}`)
          .sort()
          .join("\u0001");
        const decisionSig = `${decision.operation}\u0000${
          decision.target ?? ""
        }\u0000${value ?? ""}`;
        signatures.push(`${state.url}\u0002${controlSig}\u0002${decisionSig}`);
        if (
          signatures.length >= loopWindow &&
          signatures
            .slice(-loopWindow)
            .every((sig) => sig === signatures[signatures.length - 1])
        ) {
          transcript.push({
            step: step + 1,
            operation: "BLOCKED",
            operationConfidence: 1,
            targetConfidence: 1,
            source: decision.source,
            detail: "BLOCKED (stuck: no progress detected)",
            note: `Loop detector: the last ${loopWindow} steps were identical (no progress).`,
          });
          recentActions.push("BLOCKED (stuck: no progress detected)");
          await narrator.setState("error", "Stuck - not progressing");
          await narrator.toast("Stuck - no progress detected", "error");
          await narrator.log("BLOCKED (stuck: no progress detected)");
          outcome = "stuck";
          break;
        }
      }
    }
  } catch (err) {
    outcome = "error";
    // Tier 3: reflect the failure on the banner and clean up the spotlight before returning.
    await narrator.setState("error", "Stopped on error");
    await narrator.toast(`Error: ${(err as Error).message}`, "error");
    await narrator.hideSpotlight();
    return {
      goal,
      outcome,
      degraded: false,
      transcript,
      ...(lastSnapshot
        ? { finalSnapshot: redactSnapshot(lastSnapshot, redact) }
        : {}),
      verification: {
        checked: false,
        verified: false,
        markers: [],
        detail: `Run errored: ${(err as Error).message}`,
      },
      message: `Autopilot stopped on error: ${(err as Error).message}`,
      ...(recordArtifacts ? { steps: artifacts } : {}),
      autonomy: summariseAutonomy(transcript),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // Always capture the true final page for independent verification (the loop may have
  // ended on DONE, BLOCKED, or the step budget; DONE is not trusted as success).
  const rawFinalSnapshot = await capture(page, captureOptions);
  // Verify against the REAL page text so verification is never weakened by redaction.
  const verification = verifyFinalPage(goal, rawFinalSnapshot);
  // B1: surface a redacted copy of the final snapshot so no secret reaches the client output.
  const finalSnapshot = redactSnapshot(rawFinalSnapshot, redact);

  const summaryOutcome =
    outcome === "done" && verification.checked && !verification.verified
      ? "reported DONE but the final-page verification FAILED"
      : outcome;

  // Tier 3: colour the banner by the final result, then leave the HUD in a clean state.
  const verificationFailed = verification.checked && !verification.verified;
  if (outcome === "done" && !verificationFailed) {
    await narrator.stateWithToast("success", "Goal complete", "Goal complete", "success");
  } else if (outcome === "blocked" || outcome === "stuck" || verificationFailed) {
    // Treat `stuck` like blocked for verification messaging while keeping the distinct
    // outcome string. The overlay was already set during the stuck bail; refresh it here so
    // the final HUD state is consistent regardless of which branch surfaced it.
    const label = verificationFailed
      ? "Verification failed"
      : outcome === "stuck"
        ? "Stuck - not progressing"
        : "Blocked";
    await narrator.stateWithToast(
      "error",
      label,
      verificationFailed
        ? "Reported DONE but verification failed"
        : outcome === "stuck"
          ? "Stuck - no progress detected"
          : "Run blocked",
      "error",
    );
  }
  await narrator.hideSpotlight();

  return {
    goal,
    outcome,
    degraded: false,
    transcript,
    finalSnapshot,
    verification,
    message: `Autopilot finished (${summaryOutcome}) after ${transcript.length} step(s). ${verification.detail}`,
    ...(recordArtifacts ? { steps: artifacts } : {}),
    autonomy: summariseAutonomy(transcript),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
