/**
 * Snapshot -> compact typed {@link PageState} for the Laya decision engine.
 *
 * {@link buildState} turns a {@link Snapshot} (from {@link ./snapshot.capture}) plus the
 * current goal and recent-action log into the `jev_ultrafast` input the web-agent
 * checkpoint expects: goal + title + visible text + a NUMBERED list of controls carrying
 * their current values + recent actions.
 *
 * It also enforces Laya's hard limits DEFENSIVELY so the engine never hands `systemOne`
 * an over-length option set (which throws): the number of controls offered is capped
 * (`maxControls`, <~20 recommended so it fits `head_max_len`) and every option string is
 * clamped to a short length (`maxOptionLen`). {@link renderState} produces the
 * deterministic textual serialization (goal/title/text/numbered controls/recent actions)
 * that the engine feeds to the model as its `state`.
 *
 * This module is pure: it imports no Playwright and no ONNX runtime, so it type-checks and
 * unit-tests in isolation.
 */
import type { Control, PageState } from "./types.js";
import type { Snapshot } from "./snapshot.js";

/** Options controlling how {@link buildState} clamps state to fit Laya's budgets. */
export interface BuildStateOptions {
  /**
   * Maximum number of controls offered to the model. Laya recommends <~20 options per
   * `choice` question; more risks blowing `head_max_len`. Defaults to 20.
   */
  maxControls?: number;
  /** Maximum characters kept per control-option label. Defaults to 80. */
  maxOptionLen?: number;
  /** Maximum characters of visible text carried into the state. Defaults to 1200. */
  maxVisibleText?: number;
  /** Maximum number of recent actions retained (most recent kept). Defaults to 8. */
  maxRecentActions?: number;
}

/**
 * Laya's recommended upper bound on options per `choice` question.
 *
 * This caps the TARGET question's option set (the numbered controls). The separate OPERATION
 * question's option set is a fixed, small enumeration owned by the engine (see
 * src/laya/engine.ts `OPERATIONS`); Part 2 kept that set compact (a handful of narrow
 * single-control operations) precisely so the operation choice also stays within
 * `head_max_len` even as the executable operation union grew.
 */
export const RECOMMENDED_MAX_OPTIONS = 20;

const DEFAULTS: Required<BuildStateOptions> = {
  maxControls: RECOMMENDED_MAX_OPTIONS,
  maxOptionLen: 80,
  maxVisibleText: 1200,
  maxRecentActions: 8,
};

/** Collapse whitespace and clamp a string to `max` characters (with an ellipsis). */
function clamp(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, Math.max(0, max - 1)).trimEnd() + "\u2026";
}

/**
 * Whether a control is worth offering to the model as an actionable target.
 *
 * Headings/labels are useful context in the visible text but are not actionable targets,
 * and disabled controls cannot be acted on, so both are dropped from the numbered list.
 */
function isActionable(c: Control): boolean {
  if (c.disabled) return false;
  if (c.role === "heading" || c.role === "label") return false;
  return true;
}

/**
 * Build a compact {@link PageState} from a snapshot, goal, and recent-action log.
 *
 * The returned `controls` are RE-INDEXED 1..N over the retained subset so the numbered
 * list handed to the model is contiguous, while each control keeps its original `ref`
 * for execution. Option labels and values are clamped so the option set stays within
 * Laya's `head_max_len`.
 */
export function buildState(
  goal: string,
  snapshot: Snapshot,
  recentActions: string[] = [],
  options: BuildStateOptions = {},
): PageState {
  const opts = { ...DEFAULTS, ...options };

  const actionable = snapshot.controls.filter(isActionable);
  const capped = actionable.slice(0, opts.maxControls);

  const controls: Control[] = capped.map((c, i) => {
    const next: Control = {
      ref: c.ref,
      index: i + 1,
      role: c.role,
      name: clamp(c.name, opts.maxOptionLen),
      tag: c.tag,
      editable: c.editable,
    };
    if (c.type !== undefined) next.type = c.type;
    if (c.value !== undefined) next.value = clamp(c.value, opts.maxOptionLen);
    if (c.options !== undefined) {
      next.options = c.options.map((o) => clamp(o, opts.maxOptionLen));
    }
    if (c.checked !== undefined) next.checked = c.checked;
    if (c.disabled !== undefined) next.disabled = c.disabled;
    return next;
  });

  const recent = recentActions.slice(-opts.maxRecentActions);

  return {
    goal,
    url: snapshot.url,
    title: snapshot.title,
    visibleText: clamp(snapshot.visibleText, opts.maxVisibleText),
    controls,
    recentActions: recent,
  };
}

/** One-line label for a control in the numbered list (index + ref + role + name + value). */
export function controlLabel(c: Control): string {
  const parts = [`#${c.index}`, `[${c.ref}]`, c.role];
  if (c.name) parts.push(JSON.stringify(c.name));
  if (c.checked !== undefined) parts.push(c.checked ? "(checked)" : "(unchecked)");
  if (c.value) parts.push(`= ${JSON.stringify(c.value)}`);
  if (c.options && c.options.length > 0) {
    parts.push(`options: ${c.options.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  return parts.join(" ");
}

/**
 * Deterministic textual serialization of a {@link PageState} used as the model `state`.
 *
 * Format mirrors the web-agent `jev_ultrafast` input: goal, title, visible text, a
 * numbered control list with current values, and the recent-action log. Deterministic so
 * the same page yields the same string (aiding reproducibility and token accounting).
 */
export function renderState(state: PageState): string {
  const lines: string[] = [];
  lines.push(`GOAL: ${state.goal}`);
  lines.push(`URL: ${state.url}`);
  lines.push(`TITLE: ${state.title}`);
  lines.push("");
  lines.push("VISIBLE TEXT:");
  lines.push(state.visibleText || "(none)");
  // (T1.3) When the visible text was clamped (buildState appends an ellipsis), tell the model
  // the text is truncated and point it at the scoped `extract` tool rather than paging through
  // the whole document. Cheap heuristic on the trailing ellipsis the clamp adds.
  if (state.visibleText.endsWith("\u2026")) {
    lines.push("(visible text truncated \u2014 use the `extract`/`ask_page` tool for a full read)");
  }
  lines.push("");
  lines.push("CONTROLS:");
  if (state.controls.length === 0) {
    lines.push("(no actionable controls)");
  } else {
    for (const c of state.controls) lines.push(controlLabel(c));
  }
  lines.push("");
  lines.push("RECENT ACTIONS:");
  if (state.recentActions.length === 0) {
    lines.push("(none)");
  } else {
    state.recentActions.forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  }
  return lines.join("\n");
}
