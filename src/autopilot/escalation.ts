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
import type { Decision, Operation, PageState, Ref } from "../types.js";
import { asRef } from "../types.js";
import { renderState } from "../state-builder.js";

/** A sampling function: given a prompt, return the client LLM's raw text answer. */
export type SampleFn = (prompt: string) => Promise<string>;

/** The operations the LLM may return, mirroring the engine's operation set. */
const OPERATIONS: readonly Operation[] = [
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
  "SCROLL_DOWN",
  "WAIT",
  "DONE",
  "BLOCKED",
];

const TARGETED: ReadonlySet<Operation> = new Set<Operation>([
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
]);

/** Confidence attributed to an LLM-sourced decision (it is a fallback, not ground truth). */
export const LLM_CONFIDENCE = 0.75;

/** Build the sampling prompt from the compact page state. */
export function buildEscalationPrompt(state: PageState): string {
  return [
    "You are the fallback planner for a browser automation agent. The fast local model was",
    "not confident. Choose the SINGLE next step.",
    "",
    renderState(state),
    "",
    "Respond with ONLY a JSON object on one line, no prose, of the form:",
    '{"operation":"CLICK|TYPE_TEXT|SELECT|SCROLL_DOWN|WAIT|DONE|BLOCKED","target":"<ref like e5, required for CLICK/TYPE_TEXT/SELECT>","value":"<text to type or option to select, optional>"}',
    "Use a target ref that appears in the CONTROLS list above. If nothing can progress the goal, return BLOCKED.",
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
      operation: operation as "CLICK" | "TYPE_TEXT" | "SELECT",
      operationConfidence: LLM_CONFIDENCE,
      target: asRef(target) as Ref,
      targetConfidence: LLM_CONFIDENCE,
      source: "llm",
    };
    if (value !== undefined) decision.value = value;
    return decision;
  }

  return {
    operation: operation as "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED",
    operationConfidence: LLM_CONFIDENCE,
    targetConfidence: 1,
    source: "llm",
  };
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
  let raw: string;
  try {
    raw = await sample(buildEscalationPrompt(state));
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
