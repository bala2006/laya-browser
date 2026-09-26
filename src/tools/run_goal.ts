/**
 * `laya_run_goal` — the Autopilot tool.
 *
 * Runs {@link ../autopilot/loop.runGoal} with the server's configured decision engine and
 * returns a STRUCTURED transcript (each step's operation / target / confidences / source),
 * the final snapshot, and the INDEPENDENT final-page verification result (DONE is not
 * treated as success on its own).
 *
 * When the engine has no weights loaded, it returns a clear "weights not present, use
 * Assist tools" message rather than crashing (graceful degradation).
 */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";
import { runGoal, type RunResult } from "../autopilot/loop.js";
import type { LayaDecisionEngine } from "../types.js";

/** Extra context the Autopilot tool needs beyond the shared browser session. */
export interface RunGoalContext extends ToolContext {
  /** The configured decision engine (real Laya, stub, or unavailable). */
  engine: LayaDecisionEngine;
}

export const inputSchema = {
  goal: z.string().describe("The natural-language goal to accomplish on the page."),
  url: z
    .string()
    .optional()
    .describe("Optional URL to navigate to before starting the run."),
  maxSteps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum decision steps before giving up. Defaults to 15."),
};

type Args = { goal: string; url?: string; maxSteps?: number };

/** Render a {@link RunResult} as a compact, human-readable transcript block. */
export function renderRunResult(result: RunResult): string {
  if (result.degraded) {
    return result.message;
  }

  const lines: string[] = [];
  lines.push(`Goal: ${result.goal}`);
  lines.push(`Outcome: ${result.outcome}`);
  lines.push(
    `Verification: ${
      result.verification.checked
        ? result.verification.verified
          ? "PASSED"
          : "FAILED"
        : "not checked (no explicit success marker in goal)"
    } — ${result.verification.detail}`,
  );
  lines.push("");
  lines.push("Transcript:");
  if (result.transcript.length === 0) {
    lines.push("  (no steps executed)");
  } else {
    for (const s of result.transcript) {
      const conf = `op=${s.operationConfidence.toFixed(2)} tgt=${s.targetConfidence.toFixed(2)}`;
      const val = s.value !== undefined ? ` value=${JSON.stringify(s.value)}` : "";
      const tgt = s.target ? ` target=${s.target}` : "";
      lines.push(
        `  ${s.step}. ${s.operation}${tgt}${val} [${s.source}, ${conf}] — ${s.detail}`,
      );
    }
  }
  if (result.finalSnapshot) {
    lines.push("");
    lines.push("Final snapshot:");
    lines.push(result.finalSnapshot.text);
  }
  return lines.join("\n");
}

export function makeHandler(ctx: RunGoalContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      const result = await runGoal({
        goal: args.goal,
        session: ctx.session,
        engine: ctx.engine,
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      });
      const isError = result.outcome === "error";
      return textResult(renderRunResult(result), isError);
    } catch (err) {
      return textResult(`laya_run_goal failed: ${(err as Error).message}`, true);
    }
  };
}

export const definition = {
  name: "laya_run_goal",
  description:
    "Autopilot: pursue a natural-language goal on the current (or given) page using the local Laya decision engine. Returns a step-by-step transcript, the final snapshot, and an independent final-page verification. If model weights are absent, returns a message directing you to the Assist-mode tools.",
  inputSchema,
};
