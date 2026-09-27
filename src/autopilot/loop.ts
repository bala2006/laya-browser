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
import { capture, type Snapshot } from "../snapshot.js";
import { buildState, type BuildStateOptions } from "../state-builder.js";
import { fieldValueFromGoal, goalSuccessMarkers } from "../laya/goal.js";
import { applyFieldValue, type FieldKind } from "../tools/fill.js";
import { policySeed, refineWithGoalValue } from "./policy.js";
import { escalate, type SampleFn } from "./escalation.js";
import { checkDestructiveSubmit, checkDomainAllowed } from "../safety.js";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_LOOP_WINDOW,
  DEFAULT_MAX_STEPS,
  DEFAULT_SELF_HEAL_RETRIES,
} from "../config.js";
import type { Control, Decision, LayaDecisionEngine, PageState } from "../types.js";

/**
 * How the goal run ended.
 *
 * `stuck` (A3) is ADDITIVE: the loop detector observed the identical step repeating with no
 * progress and bailed early rather than burning the whole step budget. Every pre-existing
 * outcome string is unchanged.
 */
export type RunOutcome = "done" | "blocked" | "max_steps" | "degraded" | "error" | "stuck";

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
): Promise<string | undefined> {
  const fresh = await capture(page);
  const wantName = name.trim();
  const match = fresh.controls.find(
    (c) => c.role === role && String(c.name).trim() === wantName,
  );
  return match?.ref;
}

/** Whether an error thrown by a targeted Playwright action looks like a stale/missing ref. */
function looksLikeStaleRef(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return (
    /Timeout|not (?:visible|attached|found|stable)|no element|detached|zero elements|resolve to no elements|element is not/i.test(
      msg,
    ) || msg === ""
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
      const fresh = await resolveByNameRole(session, page, target.name, target.role);
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
    await this.overlay!.setState(this.page, state);
    if (status !== undefined) await this.overlay!.setStatus(this.page, status);
  }

  async toast(message: string, kind: ToastKind = "info"): Promise<void> {
    if (!this.on) return;
    await this.overlay!.toast(this.page, message, kind);
  }

  async log(line: string): Promise<void> {
    if (!this.on) return;
    await this.overlay!.log(this.page, line);
  }

  async countdown(ms: number): Promise<void> {
    if (!this.on) return;
    await this.overlay!.countdown(this.page, ms);
  }

  async scrollIndicator(direction: ScrollDirection, pos?: number): Promise<void> {
    if (!this.on) return;
    await this.overlay!.scrollIndicator(this.page, direction, pos);
  }

  async hideSpotlight(): Promise<void> {
    if (!this.on) return;
    await this.overlay!.hideSpotlight(this.page);
  }

  /**
   * Point the synthetic cursor + spotlight at a targeted control (resolved via the overlay's
   * `data-laya-ref` helper), optionally with a caption. Returns the target rect (or null) so
   * a CLICK can ripple at its centre. Best-effort: any missing rect leaves the HUD untouched.
   */
  async focusTarget(ref: string, caption?: string): Promise<OverlayRect | null> {
    if (!this.on) return null;
    const rect = await this.overlay!.refRect(this.page, ref);
    if (rect) {
      await this.overlay!.moveCursor(
        this.page,
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        caption,
      );
      await this.overlay!.spotlight(this.page, rect);
    }
    return rect;
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
  },
  session: BrowserSession,
  narrator: Narrator,
): Promise<ExecuteResult> {
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
          await session.resolveRef(ref).click();
        },
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
      await narrator.focusTarget(decision.target, `Typing ${field}\u2026`);
      const retries = await runWithSelfHeal(
        session,
        narrator,
        { ref: decision.target, name: c ? String(c.name) : "", role: c ? c.role : "" },
        options.selfHealRetries,
        async (ref) => {
          await session.resolveRef(ref).fill(value);
        },
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
          const locator = session.resolveRef(ref);
          await locator.selectOption({ label: value }).catch(async () => {
            await locator.selectOption(value);
          });
        },
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
          await session.resolveRef(ref).hover();
        },
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
        // Tier 1: spotlight/cursor each field in turn as it is filled.
        await narrator.focusTarget(field.target, `Filling ${label}\u2026`);
        const locator = session.resolveRef(field.target);
        const kind = fieldKindFor(control);
        await applyFieldValue(locator, field.value, kind);
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
      const snapshot = await capture(await session.getPage());
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
    selfHealRetries = DEFAULT_SELF_HEAL_RETRIES,
    settleProbe = true,
    loopDetection = true,
    loopWindow = DEFAULT_LOOP_WINDOW,
    overlay,
    overlayPage,
  } = options;

  // A single narration facade for the whole run. Inert when no overlay/page was threaded in
  // (all existing autopilot tests), so it never changes automation semantics.
  const narrator = new Narrator(overlay, overlayPage);

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
  // (A3) Rolling window of per-step signatures for loop detection. A signature is the URL +
  // the sorted set of control name+role pairs + the decision (operation/target/value). When
  // the last `loopWindow` signatures are all identical the run has made no progress.
  const signatures: string[] = [];

  try {
    for (let step = 1; step <= maxSteps; step++) {
      // Tier 4 heartbeat + Tier 2 thinking HUD: announce the step and enter the thinking
      // state BEFORE the (potentially slow) decision pipeline runs.
      await narrator.progress(step, maxSteps);
      await narrator.setState("thinking", "Deciding\u2026");

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
        // Tier 3: colour the HUD amber to signal low-confidence escalation to the LLM.
        await narrator.setState("uncertain", "Low confidence \u2014 asking the LLM\u2026");
        await narrator.toast("Escalating to the LLM for the next step", "uncertain");
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
            await narrator.log("BLOCKED (destructive-form guard)");
            outcome = "blocked";
            break;
          }
        }
      }

      // Tier 2: switch to the acting state with an op-appropriate caption just before IO.
      // Targeted ops (CLICK/TYPE_TEXT/SELECT/HOVER/FILL_FORM) render their own cursor/spotlight
      // caption inside execute(); non-targeted ops get a status here.
      await narrator.setState("acting", actionCaption(decision, state));
      // Capture the pre-action URL so the settle probe can tell whether we navigated.
      const beforeUrl = page.url();
      const executed = await execute(
        decision,
        state,
        { waitMs, scrollBy, selfHealRetries },
        session,
        narrator,
      );
      const record: StepRecord = {
        step,
        operation: decision.operation,
        operationConfidence: decision.operationConfidence,
        targetConfidence: decision.targetConfidence,
        source: decision.source,
        detail: executed.detail,
        ...(note ? { note } : {}),
      };
      if (decision.target !== undefined) record.target = decision.target;
      const value = "value" in decision ? decision.value : undefined;
      if (value !== undefined) record.value = value;
      if (decision.operation === "PRESS_KEY") record.key = decision.key;
      if (decision.operation === "FILL_FORM") {
        record.fields = decision.fields.map((f) => ({ target: f.target, value: f.value }));
      }
      if (decision.operation === "VERIFY") record.marker = decision.marker;
      if (executed.verified !== undefined) record.verified = executed.verified;
      if (executed.retries !== undefined) record.retries = executed.retries;
      transcript.push(record);
      recentActions.push(executed.detail);
      // Tier 4: mirror the transcript line into the on-page activity-log feed.
      await narrator.log(executed.detail);

      // SCREENSHOT and VERIFY are terminal/verification steps: once one runs, the goal-run
      // ends (a VERIFY reports its result; a SCREENSHOT captures the final page).
      if (decision.operation === "VERIFY" || decision.operation === "SCREENSHOT") {
        outcome = "done";
        break;
      }

      // A2: purely-observational settle probe. It NEVER changes the decision path or outcome;
      // it only records `settled` on the step and narrates a hint. Terminal ops already broke
      // out above, so this runs only for the continuing loop.
      if (settleProbe) {
        await narrator.setState("acting", "Waiting for page to settle\u2026");
        const probe = await session.probeSettle(page, { beforeUrl });
        record.settled = probe.changed;
        if (!probe.changed) {
          await narrator.toast("No change detected", "uncertain");
        }
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

  // Tier 3: colour the banner by the final result, then leave the HUD in a clean state.
  const verificationFailed = verification.checked && !verification.verified;
  if (outcome === "done" && !verificationFailed) {
    await narrator.setState("success", "Goal complete");
    await narrator.toast("Goal complete", "success");
  } else if (outcome === "blocked" || outcome === "stuck" || verificationFailed) {
    // Treat `stuck` like blocked for verification messaging while keeping the distinct
    // outcome string. The overlay was already set during the stuck bail; refresh it here so
    // the final HUD state is consistent regardless of which branch surfaced it.
    const label = verificationFailed
      ? "Verification failed"
      : outcome === "stuck"
        ? "Stuck - not progressing"
        : "Blocked";
    await narrator.setState("error", label);
    await narrator.toast(
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
  };
}
