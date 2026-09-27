/**
 * Confidence-based escalation to the client's LLM via MCP sampling.
 *
 * When the local engine's operation/target confidence is below the configured threshold, or
 * the engine returns BLOCKED, Autopilot escalates: it asks the CLIENT's own LLM (through the
 * MCP `sampling/createMessage` request) to choose the next step given the compact page
 * state, then PARSES the structured answer back into a {@link Decision} (with
 * `source = "llm"`). All parsing/guarding happens at THIS boundary — the loop only ever sees
 * a well-formed Decision or a graceful BLOCKED.
 *
 * Testability: escalation depends only on an injected {@link SampleFn} (a function that takes
 * a prompt and returns the model's raw text), NOT on a live MCP client. Tests inject a fake
 * that returns canned JSON; production wires {@link samplerFromServer} to the real
 * `McpServer`. When the client does not support sampling, {@link samplerFromServer} returns
 * `undefined` and {@link escalate} degrades to a clear BLOCKED decision (never throws).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Control,
  Decision,
  FieldFill,
  Operation,
  PageState,
  Ref,
  SnapshotDiff,
} from "../types.js";
import { asRef } from "../types.js";
import { controlLabel, renderState } from "../state-builder.js";

/** A sampling function: given a prompt, return the client LLM's raw text answer. */
export type SampleFn = (prompt: string) => Promise<string>;

/**
 * The operations the LLM may return.
 *
 * FILL_FORM is included so a low-confidence MULTI-FIELD goal keeps the batch fast-path
 * (Part 2's "faster" mechanism) instead of degrading to N per-field TYPE_TEXT round-trips.
 * SCREENSHOT and VERIFY are deliberately excluded: they are terminal/verification ops that
 * end a run, not steps that progress a goal, so the fallback planner has no reason to emit
 * them and the loop reaches them through its own terminal handling.
 */
const OPERATIONS: readonly Operation[] = [
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
  "HOVER",
  "SCROLL_DOWN",
  "WAIT",
  "NAVIGATE_BACK",
  "PRESS_KEY",
  "FILL_FORM",
  "DONE",
  "BLOCKED",
];

const TARGETED: ReadonlySet<Operation> = new Set<Operation>([
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
  "HOVER",
]);

/** Confidence attributed to an LLM-sourced decision (it is a fallback, not ground truth). */
export const LLM_CONFIDENCE = 0.75;

/**
 * (T1.1) The STABLE prompt PREFIX: the role, instructions, and response-format spec.
 *
 * KV-cache-friendliness: this block is byte-for-byte identical on every escalation call
 * (it never interpolates the page state), so an LLM/provider that caches by shared prompt
 * prefix can reuse the attention KV for these tokens across steps and across runs. The
 * VOLATILE browser state (url/title/controls/diff) is appended AFTER this prefix by the
 * prompt builders, so only the changing suffix busts the cache. Reordering only — the SAME
 * information reaches the model, and the parser (which scans for a JSON object anywhere in
 * the answer) is unaffected.
 */
export const ESCALATION_PROMPT_PREFIX: string = [
  "You are the fallback planner for a browser automation agent. The fast local model was",
  "not confident. Choose the SINGLE next step.",
  "",
  "Respond with ONLY a JSON object on one line, no prose, of the form:",
  '{"operation":"CLICK|TYPE_TEXT|SELECT|HOVER|SCROLL_DOWN|WAIT|NAVIGATE_BACK|PRESS_KEY|FILL_FORM|DONE|BLOCKED","target":"<ref like e5, required for CLICK/TYPE_TEXT/SELECT/HOVER>","value":"<text to type or option to select, optional>","key":"<key like Enter/Escape, required for PRESS_KEY>","fields":[{"target":"<ref>","value":"<text>"}]}',
  "Prefer a single FILL_FORM with a `fields` list when several fields must be filled to progress the goal; otherwise use one targeted step.",
  "For a large READ (e.g. 'what does the page say about X'), do NOT scroll the whole page; the client has an `extract`/`ask_page` tool for scoped reads.",
  "Use a target ref (in `target` or every `fields[].target`) that appears in the CONTROLS list below. If nothing can progress the goal, return BLOCKED.",
].join("\n");

/**
 * Build the sampling prompt from the compact page state.
 *
 * (T1.1) Ordering: the STABLE {@link ESCALATION_PROMPT_PREFIX} (role + instructions +
 * response format) comes FIRST, and the VOLATILE page state (rendered by {@link renderState})
 * comes LAST, so the changing tokens are all at the tail (KV-cache-friendly). This is a pure
 * reorder: the same goal/url/title/controls/recent-actions information is present as before.
 */
export function buildEscalationPrompt(state: PageState): string {
  return [
    ESCALATION_PROMPT_PREFIX,
    "",
    "----- CURRENT PAGE STATE -----",
    renderState(state),
  ].join("\n");
}

/**
 * (C2) Build a DELTA-ONLY sampling prompt from a snapshot diff plus the goal/url/title.
 *
 * Instead of the full control list, this sends only what CHANGED since the previous step
 * (added / removed / changed controls), which cuts tokens on long pages. The added/changed
 * controls still carry their `eN` refs, so the LLM can target them; the loop uses this only
 * when a meaningful diff exists and it is not the first step, and otherwise falls back to the
 * full-snapshot prompt. The current-step controls are still listed compactly so a targeted
 * choice always has a resolvable ref set to draw from.
 */
export function buildDeltaEscalationPrompt(
  state: PageState,
  diff: SnapshotDiff,
): string {
  const section = (label: string, controls: Control[]): string[] =>
    controls.length === 0
      ? []
      : [`${label}:`, ...controls.map((c) => controlLabel(c))];

  // (T1.1) STABLE prefix FIRST, VOLATILE delta/state LAST — same KV-cache-friendly ordering
  // as the full prompt. The response-format spec references "CURRENT CONTROLS", which appears
  // below; a pure reorder that preserves every piece of information the old prompt carried.
  return [
    ESCALATION_PROMPT_PREFIX,
    "",
    "----- CURRENT PAGE STATE (delta) -----",
    `GOAL: ${state.goal}`,
    `URL: ${state.url}`,
    `TITLE: ${state.title}`,
    "",
    "The page changed since the last step. Here is the DELTA (only what changed):",
    ...section("NEW CONTROLS", diff.added),
    ...section(
      "CHANGED CONTROLS",
      diff.changed.map((c) => c.after),
    ),
    ...section("REMOVED CONTROLS", diff.removed),
    "",
    "CURRENT CONTROLS (targets you may act on):",
    ...(state.controls.length === 0
      ? ["(no actionable controls)"]
      : state.controls.map((c) => controlLabel(c))),
  ].join("\n");
}

/** Extract the first balanced JSON object substring from arbitrary text. */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Parse the LLM's raw answer into a validated {@link Decision}.
 *
 * Guards every field: an unknown operation, a targeted operation with a target that is not a
 * known control ref, etc. all collapse to a BLOCKED decision with `source = "llm"` rather
 * than producing an illegal decision. `knownRefs` is the set of resolvable refs on the page.
 */
export function parseDecision(raw: string, knownRefs: ReadonlySet<string>): Decision {
  const blocked = (): Decision => ({
    operation: "BLOCKED",
    operationConfidence: LLM_CONFIDENCE,
    targetConfidence: 1,
    source: "llm",
  });

  const json = extractJsonObject(raw);
  if (!json) return blocked();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return blocked();
  }
  if (typeof parsed !== "object" || parsed === null) return blocked();

  const obj = parsed as Record<string, unknown>;
  const opRaw = typeof obj.operation === "string" ? obj.operation.trim().toUpperCase() : "";
  const operation = OPERATIONS.find((o) => o === opRaw);
  if (!operation) return blocked();

  if (TARGETED.has(operation)) {
    const target = typeof obj.target === "string" ? obj.target.trim() : "";
    if (!target || !knownRefs.has(target)) {
      // Targeted operation without a resolvable target -> cannot execute safely.
      return blocked();
    }
    const value = typeof obj.value === "string" ? obj.value : undefined;
    const decision: Decision = {
      operation: operation as "CLICK" | "TYPE_TEXT" | "SELECT" | "HOVER",
      operationConfidence: LLM_CONFIDENCE,
      target: asRef(target) as Ref,
      targetConfidence: LLM_CONFIDENCE,
      source: "llm",
    };
    if (value !== undefined) decision.value = value;
    return decision;
  }

  // PRESS_KEY: guard the required `key` payload; a missing/empty key collapses to BLOCKED.
  if (operation === "PRESS_KEY") {
    const key = typeof obj.key === "string" ? obj.key.trim() : "";
    if (!key) return blocked();
    return {
      operation: "PRESS_KEY",
      operationConfidence: LLM_CONFIDENCE,
      targetConfidence: 1,
      key,
      source: "llm",
    };
  }

  // FILL_FORM: guard the required `fields` batch payload strictly at this untrusted
  // boundary. Every entry must be { target: <known ref>, value: string }; an empty list, a
  // non-array, a malformed entry, or ANY unknown ref collapses to a well-formed BLOCKED so
  // an illegal FILL_FORM is never constructed.
  if (operation === "FILL_FORM") {
    if (!Array.isArray(obj.fields) || obj.fields.length === 0) return blocked();
    const fields: FieldFill[] = [];
    for (const entry of obj.fields) {
      if (typeof entry !== "object" || entry === null) return blocked();
      const rec = entry as Record<string, unknown>;
      const target = typeof rec.target === "string" ? rec.target.trim() : "";
      if (!target || !knownRefs.has(target)) return blocked();
      if (typeof rec.value !== "string") return blocked();
      fields.push({ target: asRef(target) as Ref, value: rec.value });
    }
    return {
      operation: "FILL_FORM",
      operationConfidence: LLM_CONFIDENCE,
      targetConfidence: LLM_CONFIDENCE,
      fields,
      source: "llm",
    };
  }

  return {
    operation: operation as "SCROLL_DOWN" | "WAIT" | "NAVIGATE_BACK" | "DONE" | "BLOCKED",
    operationConfidence: LLM_CONFIDENCE,
    targetConfidence: 1,
    source: "llm",
  };
}

/**
 * (C2) Options controlling how {@link escalate} builds its prompt.
 *
 * When `diff` is present AND non-empty, escalate sends the delta-only prompt (fewer tokens);
 * otherwise it uses the full-snapshot prompt. Additive: omitting it preserves the original
 * full-prompt behaviour exactly.
 */
export interface EscalationOptions {
  /** The snapshot diff to build a delta-only prompt from, when meaningful. */
  diff?: SnapshotDiff;
}

/** The outcome of an escalation attempt. */
export interface EscalationResult {
  /** The decision to use next (always well-formed; BLOCKED when escalation cannot help). */
  decision: Decision;
  /** Whether the client actually produced a usable decision (vs. a graceful fallback). */
  escalated: boolean;
  /** Human-readable note for the transcript. */
  note: string;
}

/**
 * Escalate a decision to the client LLM via the injected sampler.
 *
 * When `sample` is `undefined` (client lacks sampling support), returns a clear BLOCKED
 * result WITHOUT throwing. Otherwise it prompts the client, parses the answer, and returns
 * the resulting Decision (or BLOCKED if the answer was unusable / the request threw).
 */
export async function escalate(
  state: PageState,
  sample: SampleFn | undefined,
  options: EscalationOptions = {},
): Promise<EscalationResult> {
  if (!sample) {
    return {
      decision: {
        operation: "BLOCKED",
        operationConfidence: 1,
        targetConfidence: 1,
        source: "llm",
      },
      escalated: false,
      note: "Low confidence and the client does not support MCP sampling; blocked. Use the Assist-mode tools to proceed manually.",
    };
  }

  const knownRefs = new Set<string>(state.controls.map((c) => c.ref));
  // (C2) Prefer the delta-only prompt when a non-empty diff was supplied; otherwise the full
  // control-list prompt. `knownRefs` (the current controls) is unchanged either way, so a
  // targeted decision is still validated against the resolvable refs on this step.
  const diff = options.diff;
  const useDelta =
    diff !== undefined &&
    (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0);
  const prompt = useDelta
    ? buildDeltaEscalationPrompt(state, diff)
    : buildEscalationPrompt(state);
  let raw: string;
  try {
    raw = await sample(prompt);
  } catch (err) {
    return {
      decision: {
        operation: "BLOCKED",
        operationConfidence: 1,
        targetConfidence: 1,
        source: "llm",
      },
      escalated: false,
      note: `MCP sampling request failed (${(err as Error).message}); blocked.`,
    };
  }

  const decision = parseDecision(raw, knownRefs);
  return {
    decision,
    escalated: true,
    note: `Escalated to the client LLM via MCP sampling; it chose ${decision.operation}${
      decision.target ? ` on ${decision.target}` : ""
    }.`,
  };
}

/**
 * Build a {@link SampleFn} backed by a real {@link McpServer}, or `undefined` when the
 * connected client did not advertise the `sampling` capability.
 *
 * Uses the SDK's `server.server.createMessage` (the `sampling/createMessage` request). The
 * returned function sends a single user message and returns the text of the model's reply;
 * non-text content yields an empty string (parsed as BLOCKED downstream).
 */
export function samplerFromServer(server: McpServer): SampleFn | undefined {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.sampling) return undefined;

  return async (prompt: string): Promise<string> => {
    const result = await server.server.createMessage({
      messages: [
        {
          role: "user",
          content: { type: "text", text: prompt },
        },
      ],
      maxTokens: 256,
      systemPrompt:
        "You choose one browser automation step and reply with a single-line JSON object only.",
    });
    const content = result.content;
    if (content && content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    return "";
  };
}
