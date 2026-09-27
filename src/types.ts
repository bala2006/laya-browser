/**
 * Core data shapes for laya-browser-mcp.
 *
 * This module is PURE: it imports neither `playwright` nor any ONNX/`@receptron/laya`
 * runtime. Every later phase (snapshot, state-builder, engine, stub, autopilot loop,
 * MCP tools) depends on these shapes, so keeping the module dependency-free lets it
 * type-check and unit-test in isolation and keeps the ref/snapshot boundary
 * (which is owned by laya-browser-mcp, not by any Playwright private API) decoupled
 * from the decision layer.
 */

/**
 * A stable reference to an interactive element on the page, e.g. `"e5"`.
 *
 * Refs are assigned by laya-browser-mcp's own in-page DOM walk (which stamps
 * `data-laya-ref="eN"` attributes) rather than by any Playwright private snapshot API.
 * Branded so a raw `string` cannot be passed where a resolved `Ref` is expected.
 */
export type Ref = string & { readonly __brand: "LayaRef" };

/** Narrow a raw string into a branded {@link Ref}. */
export function asRef(value: string): Ref {
  return value as Ref;
}

/**
 * One interactive/landmark control extracted from the page.
 *
 * `index` is the 1-based position in the numbered control list handed to Laya
 * (the web-agent `jev_ultrafast` I/O format numbers controls). `ref` is the stable
 * `eN` handle used to resolve the element back on the page for execution.
 */
export interface Control {
  /** Stable page reference, e.g. `"e5"`. */
  ref: Ref;
  /** 1-based position in the numbered control list presented to the model. */
  index: number;
  /** Accessibility role, e.g. `"button"`, `"textbox"`, `"combobox"`, `"link"`. */
  role: string;
  /** Accessible name / label. */
  name: string;
  /** HTML tag name, lower-cased, e.g. `"button"`, `"input"`, `"select"`. */
  tag: string;
  /** For form fields: the `type` attribute (e.g. `"text"`, `"email"`, `"checkbox"`). */
  type?: string;
  /** Current value/text of the control, when meaningful. */
  value?: string;
  /** For selects/comboboxes/radiogroups: the choosable option labels. */
  options?: string[];
  /** Whether the control accepts text input. */
  editable: boolean;
  /** Checkbox/radio checked state, when applicable. */
  checked?: boolean;
  /** Whether the control is currently disabled. */
  disabled?: boolean;
  /**
   * (F1) Optional persistent in-page identity assigned by the fast snapshot. Unlike {@link ref}
   * (an `eN` handle re-numbered per capture and only valid within one snapshot), `nodeId` is a
   * stable integer key into an in-page identity map that survives across fast snapshots, so the
   * same node keeps the same id between observations. It is ABSENT on the legacy domwalk/aria
   * path, so existing callers are unaffected; only the fast loop populates it.
   */
  nodeId?: number;
}

/**
 * (F1) A pure, JSON-serializable semantic-freshness fingerprint of a single node, captured at
 * decision time and re-checked at act time in the fast loop.
 *
 * This mirrors the jev fast-path's per-node guard array, but modelled as a NAMED STRUCT rather
 * than a positional tuple so illegal states are unrepresentable and each field is documented.
 * Before the fast loop inputs into a control, it re-reads the live node's fingerprint and
 * compares it to the guard recorded when the decision was made; a mismatch means the page
 * mutated under us (the node changed identity or state), so the action is refused and the page
 * is re-observed instead of acting on a stale target.
 *
 * Every field is a plain JSON value (string / boolean / number / null) because a `NodeGuard`
 * crosses the untrusted `page.evaluate` boundary and must round-trip through JSON. `null` means
 * the attribute does not apply to this node (e.g. a button has no `checked` or `selectedIndex`),
 * which is deliberately distinct from an empty string.
 */
export interface NodeGuard {
  /** Accessibility role of the node, e.g. `"button"`, `"textbox"`, `"combobox"`. */
  role: string;
  /** Accessible name / label of the node. */
  name: string;
  /** Current value of a form field, or `null` when the node has no value semantics. */
  value: string | null;
  /** Checkbox/radio checked state, or `null` when not applicable. */
  checked: boolean | null;
  /** Selected option index for a select, or `null` when not applicable. */
  selectedIndex: number | null;
  /** Whether the node is currently disabled. */
  disabled: boolean;
  /** `aria-expanded` attribute value, or `null` when absent. */
  ariaExpanded: string | null;
  /** `aria-checked` attribute value, or `null` when absent. */
  ariaChecked: string | null;
  /** `aria-selected` attribute value, or `null` when absent. */
  ariaSelected: string | null;
  /** `href` for links, or `null` when the node is not a link. */
  href: string | null;
  /**
   * Truncated `innerText` of the nearest enclosing scope (form / dialog / table row / list
   * item) the node lives in. A change here signals the surrounding context was replaced even
   * when the node's own attributes look unchanged.
   */
  scopeText: string;
}

/**
 * (F1) A control from the fast snapshot, extending {@link Control} with the extra identity and
 * geometry the fast loop needs to act safely.
 *
 * Where a legacy {@link Control} may carry an optional `nodeId`, a `FastControl` REQUIRES one,
 * plus the `guard` fingerprint used for the act-time freshness re-check and the `rect` geometry
 * used for the pre-input occlusion hit-test (`document.elementFromPoint` at the rect center must
 * still resolve to the target, otherwise something is covering it).
 */
export interface FastControl extends Control {
  /** Required persistent in-page identity (the fast path always assigns one). */
  nodeId: number;
  /** Semantic-freshness fingerprint captured with this control, re-checked before acting. */
  guard: NodeGuard;
  /** Viewport-space geometry (CSS px) used for the pre-input occlusion hit-test. */
  rect: { x: number; y: number; w: number; h: number };
}

/**
 * (F1) The atomic result of the fast loop's single-call snapshot.
 *
 * The whole page (url, title, visible text, controls, and text) is captured in ONE
 * `page.evaluate` so it is internally consistent (no interleaving mutation between separate
 * reads). `pageKey` identifies the observed document/navigation so a decision made against one
 * page is not applied after a navigation, and `marker` is a whole-page freshness token compared
 * cheaply when a per-node guard is not applicable.
 *
 * Because a `FastSnapshot` originates entirely from an untrusted `page.evaluate`, it MUST be
 * validated at the browser boundary (shape and field types checked) before the rest of the
 * server trusts it. This type only describes the validated shape; it does not itself validate.
 */
export interface FastSnapshot {
  /** Current page URL. */
  url: string;
  /** Current document title. */
  title: string;
  /** Condensed visible text of the page. */
  visibleText: string;
  /** The fast controls, each carrying persistent identity, a guard, and geometry. */
  controls: FastControl[];
  /** Fuller page text (larger read than {@link visibleText}), for extraction. */
  text: string;
  /** Identity of the observed document/navigation, so a decision is not applied cross-page. */
  pageKey: string;
  /** Whole-page freshness token, compared when a per-node guard does not apply. */
  marker: string;
}

/**
 * The compact, typed snapshot of the page handed to the Laya decision engine.
 *
 * Mirrors the web-agent (`abedinia/laya-web-agent`) `jev_ultrafast` input format:
 * goal + title + visible text + a numbered list of controls with current values +
 * recent actions. Kept small so it fits the checkpoint's `max_len` budget.
 */
export interface PageState {
  /** The user's high-level goal for the current task. */
  goal: string;
  /** Current page URL. */
  url: string;
  /** Current document title. */
  title: string;
  /** Condensed visible text of the page (truncated to fit the model budget). */
  visibleText: string;
  /** Numbered, current-valued interactive controls. */
  controls: Control[];
  /** Human-readable log of the most recent actions taken this task. */
  recentActions: string[];
}

/**
 * (C2) The difference between two page snapshots, keyed by a stable control identity
 * (role + accessible name, since the per-snapshot `eN` refs are not comparable across
 * snapshots). `added` are controls present in the newer snapshot but not the older,
 * `removed` are present in the older but gone from the newer, and `changed` pairs a
 * matched control's `before`/`after` states when a meaningful property (value, checked,
 * disabled, options) differs. Pure data: computed by {@link src/snapshot-diff.ts}.
 */
export interface SnapshotDiff {
  /** Controls that appeared in the newer snapshot (no matching older identity). */
  added: Control[];
  /** Controls that disappeared from the newer snapshot (older identity with no match). */
  removed: Control[];
  /** Matched controls whose observable state changed between the two snapshots. */
  changed: { before: Control; after: Control }[];
}

/**
 * The operations the decision engine can choose.
 *
 * The base set (`CLICK`/`TYPE_TEXT`/`SELECT`/`SCROLL_DOWN`/`WAIT`/`DONE`/`BLOCKED`) mirrors
 * `abedinia/laya-web-agent`. Part 2 broadens it so Laya can drive the richer Assist toolset
 * FASTER:
 *   - `HOVER` — move the pointer over a control (targeted);
 *   - `NAVIGATE_BACK` — go back in history (targetless);
 *   - `PRESS_KEY` — press a keyboard key such as `Enter`/`Escape` (carries a `key` payload);
 *   - `FILL_FORM` — fill SEVERAL fields in ONE batch step (carries a `fields` list, no single
 *     target) so a multi-field goal resolves in one step instead of N `TYPE_TEXT` steps;
 *   - `SCREENSHOT` — capture the page as a terminal/verification step;
 *   - `VERIFY` — check an expected marker against the live page as a terminal step.
 * The model still emits one operation per step; the deterministic layer PREFERS `FILL_FORM`
 * when the goal maps to multiple editable fields (see src/autopilot/policy.ts).
 */
export type Operation =
  | "CLICK"
  | "TYPE_TEXT"
  | "SELECT"
  | "HOVER"
  | "SCROLL_DOWN"
  | "WAIT"
  | "NAVIGATE_BACK"
  /**
   * (R4) Go to an explicit URL mid-run. It is the one operation the LOCAL Laya engine is never
   * asked about: the narrow choice question keeps the option set the checkpoint was trained on,
   * and NAVIGATE is reachable only through the planner that can express a URL (the client LLM).
   */
  | "NAVIGATE"
  | "PRESS_KEY"
  | "FILL_FORM"
  | "SCREENSHOT"
  | "VERIFY"
  | "DONE"
  | "BLOCKED";

/** Where a {@link Decision} came from, for observability and escalation policy. */
export type DecisionSource = "laya" | "rule" | "llm" | "stub";

/**
 * Operations that act on a single specific control and therefore MUST carry a target ref
 * (and no batch `fields`/`key`/marker payload).
 */
export type TargetedOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "HOVER";

/**
 * Operations that act on the page as a whole and therefore need no target and no payload.
 */
export type TargetlessOperation =
  | "SCROLL_DOWN"
  | "WAIT"
  | "NAVIGATE_BACK"
  | "SCREENSHOT"
  | "DONE"
  | "BLOCKED";

/**
 * One field of a {@link "FILL_FORM"} batch: which control to fill and the value to set.
 */
export interface FieldFill {
  /** The control this entry fills. */
  target: Ref;
  /** The value to set (text, option label, or `true`/`false` for checkboxes). */
  value: string;
}

/**
 * A decision from an engine, modelled as a discriminated union so illegal states are
 * unrepresentable. Each operation family carries exactly the payload it can act on:
 *   - targeted ops (`CLICK`/`TYPE_TEXT`/`SELECT`/`HOVER`) carry a single `target`;
 *   - targetless ops (`SCROLL_DOWN`/`WAIT`/`NAVIGATE_BACK`/`SCREENSHOT`/`DONE`/`BLOCKED`)
 *     carry no `target`, `key`, `fields`, or `value`;
 *   - `NAVIGATE` carries a `url` (and no `target`);
 *   - `PRESS_KEY` carries a `key` (and no `target`);
 *   - `FILL_FORM` carries a `fields` list (and no single `target`);
 *   - `VERIFY` carries an expected `marker` (and no `target`).
 *
 * So a `FILL_FORM` can never have a lone `target`, a `PRESS_KEY` can never lack a `key`, and a
 * `DONE` can never carry a value — the type system rules those out.
 *
 * Confidences are in `[0, 1]`; the autopilot loop uses them to decide when to escalate to the
 * client LLM via MCP sampling.
 */
export type Decision =
  | {
      operation: TargetedOperation;
      operationConfidence: number;
      /** The control this operation acts on. Required for targeted operations. */
      target: Ref;
      targetConfidence: number;
      /** Text to type (`TYPE_TEXT`) or option to choose (`SELECT`). */
      value?: string;
      source: DecisionSource;
    }
  | {
      operation: TargetlessOperation;
      operationConfidence: number;
      /** Targetless operations carry no control reference. */
      target?: undefined;
      /** No target, so target confidence is fixed. */
      targetConfidence: number;
      value?: undefined;
      source: DecisionSource;
    }
  | {
      operation: "NAVIGATE";
      operationConfidence: number;
      target?: undefined;
      targetConfidence: number;
      /** The absolute http(s) URL to navigate to. */
      url: string;
      value?: undefined;
      source: DecisionSource;
    }
  | {
      operation: "PRESS_KEY";
      operationConfidence: number;
      target?: undefined;
      targetConfidence: number;
      /** The keyboard key to press, e.g. `"Enter"`, `"Escape"`, `"ArrowDown"`. */
      key: string;
      value?: undefined;
      source: DecisionSource;
    }
  | {
      operation: "FILL_FORM";
      operationConfidence: number;
      /** A batch fill carries a list of fields, not a single target. */
      target?: undefined;
      targetConfidence: number;
      /** The fields to fill in one step. */
      fields: FieldFill[];
      value?: undefined;
      source: DecisionSource;
    }
  | {
      operation: "VERIFY";
      operationConfidence: number;
      target?: undefined;
      targetConfidence: number;
      /** The expected marker/value to look for on the live page. */
      marker: string;
      value?: undefined;
      source: DecisionSource;
    };

/**
 * The interchangeable decision-engine contract.
 *
 * The real engine (wrapping `@receptron/laya`) and the deterministic test stub both
 * implement this, so callers depend only on the interface (Boundary Discipline).
 * `available` reflects whether weights loaded; when `false`, Autopilot degrades
 * gracefully (deterministic rules + LLM escalation) instead of failing.
 */
export interface LayaDecisionEngine {
  /** Produce a {@link Decision} for the given page state. */
  decide(state: PageState): Promise<Decision>;
  /** Whether a usable model is loaded (vs. a stub/unavailable engine). */
  readonly available: boolean;
  /** Release any underlying model/session resources. */
  close(): Promise<void>;
}

/**
 * A handle to one browser tab/page, as surfaced by the multi-tab tools.
 *
 * Pure data: the index is the tab's 0-based position in the session's tab list, and
 * `active` marks the currently focused tab. Later features use this to list, select,
 * and close tabs without leaking Playwright `Page` objects across the boundary.
 */
export interface TabInfo {
  /** 0-based position of the tab in the session's ordered tab list. */
  index: number;
  /** The tab's document title. */
  title: string;
  /** The tab's current URL. */
  url: string;
  /** Whether this is the currently focused/active tab. */
  active: boolean;
}

/**
 * A recorded network request/response pair, as surfaced by the network capability tools.
 *
 * Pure data captured from Playwright request/response events. Headers are plain maps and
 * the response fields are optional because a request may be pending or have failed.
 */
export interface NetworkRequestRecord {
  /** Request URL. */
  url: string;
  /** HTTP method, e.g. `"GET"`, `"POST"`. */
  method: string;
  /** Playwright resource type, e.g. `"document"`, `"xhr"`, `"fetch"`, `"image"`. */
  resourceType?: string;
  /** Response HTTP status code, once the response has arrived. */
  status?: number;
  /** Response status text, once the response has arrived. */
  statusText?: string;
  /** Request headers as a plain map. */
  requestHeaders?: Record<string, string>;
  /** Response headers as a plain map, once the response has arrived. */
  responseHeaders?: Record<string, string>;
  /** Failure text when the request errored before completing. */
  failure?: string;
}

/**
 * A recorded console message, as surfaced by the console capability tools.
 *
 * Pure data captured from Playwright `console` events (plus uncaught page errors).
 */
export interface ConsoleMessageRecord {
  /** Console level, e.g. `"log"`, `"info"`, `"warning"`, `"error"`, `"debug"`. */
  type: string;
  /** The rendered message text. */
  text: string;
  /** Optional source location `{ url, lineNumber, columnNumber }`. */
  location?: {
    url: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

/**
 * How a JavaScript dialog (`alert`/`confirm`/`prompt`/`beforeunload`) should be handled,
 * registered ahead of the action that triggers it.
 *
 * Pure data: `accept` decides between accept and dismiss; `promptText` supplies the text
 * for `prompt` dialogs when accepting.
 */
export interface DialogRecord {
  /** Dialog kind, e.g. `"alert"`, `"confirm"`, `"prompt"`, `"beforeunload"`. */
  type: string;
  /** The dialog's message. */
  message: string;
  /** Whether the dialog was/should be accepted (vs. dismissed). */
  accept: boolean;
  /** Text entered for a `prompt` dialog when accepting. */
  promptText?: string;
}

/**
 * A route-mocking rule: requests matching `urlPattern` are fulfilled or aborted instead
 * of hitting the network, as used by the network mocking capability tools.
 *
 * Pure data only; the matching/serving logic lives in the browser boundary layer.
 */
export interface RouteRule {
  /** Glob or substring pattern matched against the request URL. */
  urlPattern: string;
  /** What to do with a matched request: serve a canned response or abort it. */
  action: "fulfill" | "abort";
  /** For `fulfill`: response HTTP status (default 200). */
  status?: number;
  /** For `fulfill`: response `Content-Type` and other headers as a plain map. */
  headers?: Record<string, string>;
  /** For `fulfill`: the response body. */
  body?: string;
  /** For `abort`: the Playwright error code to fail with (e.g. `"failed"`). */
  errorCode?: string;
}
