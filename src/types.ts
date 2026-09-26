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
 * The operations the decision engine can choose.
 *
 * Mirrors `abedinia/laya-web-agent` exactly: the model emits one of these as the
 * `operation` answer, plus a `target` naming the numbered control when applicable.
 */
export type Operation =
  | "CLICK"
  | "TYPE_TEXT"
  | "SELECT"
  | "SCROLL_DOWN"
  | "WAIT"
  | "DONE"
  | "BLOCKED";

/** Where a {@link Decision} came from, for observability and escalation policy. */
export type DecisionSource = "laya" | "rule" | "llm" | "stub";

/**
 * Operations that act on a specific control and therefore MUST carry a target ref.
 */
export type TargetedOperation = "CLICK" | "TYPE_TEXT" | "SELECT";

/**
 * Operations that act on the page as a whole and therefore need no target.
 */
export type TargetlessOperation = "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED";

/**
 * A decision from an engine, modelled as a discriminated union so illegal states
 * are unrepresentable: a `CLICK`/`TYPE_TEXT`/`SELECT` decision is required to carry a
 * `target`, while `DONE`/`BLOCKED`/`SCROLL_DOWN`/`WAIT` cannot.
 *
 * Confidences are in `[0, 1]`; the autopilot loop uses them to decide when to escalate
 * to the client LLM via MCP sampling.
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
