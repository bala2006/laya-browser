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
 *
 * (T4.2) Stateless-handle readiness. MCP 2025+ moves toward a stateless model (the
 * 2026-07-28 revision dropped protocol-level sessions), so a tool call must be fully
 * addressable from its own arguments plus server-scoped resources, NOT from any per-connection
 * protocol session. This tool complies: every run is parameterised by explicit args
 * (`goal` / `url` / `maxSteps`); the decision engine is a lazily-built, server-scoped resource
 * (weights load on first use, and an absent engine degrades gracefully); and the only shared
 * state is the single {@link ../browser.BrowserSession} + the last-run artifacts holder, both
 * server-scoped and reachable without a protocol session. There is therefore no hidden
 * protocol-session state the caller must first establish — a run is self-describing from its
 * arguments. The audit is asserted in test/stateless-handle.test.ts.
 */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";
import { runGoal, type ConfirmFn, type RunResult } from "../autopilot/loop.js";
import type { SampleFn } from "../autopilot/escalation.js";
import type { SnapshotBackend } from "../config.js";
import type { LayaDecisionEngine } from "../types.js";
import type { RunArtifactsHolder } from "./run_artifacts.js";

/** Extra context the Autopilot tool needs beyond the shared browser session. */
export interface RunGoalContext extends ToolContext {
  /** The configured decision engine (real Laya, stub, or unavailable). */
  engine: LayaDecisionEngine;
  /** Confidence threshold below which the loop escalates to the client LLM. */
  confidenceThreshold?: number;
  /**
   * Sampling callback for confidence escalation. When omitted, escalation degrades to a
   * clear BLOCKED result (the client lacks MCP sampling support).
   */
  sample?: SampleFn;
  /** Domain allow-list applied to the initial navigation. Empty = allow all. */
  allowedDomains?: string[];
  /** Whether the destructive-form guard is active. Defaults to true. */
  destructiveFormGuard?: boolean;
  /** Milliseconds the WAIT operation pauses for. Defaults to the loop's built-in default. */
  waitMs?: number;
  /** (A1) Self-healing retry attempts for a failed targeted action. */
  selfHealRetries?: number;
  /** (A2) Whether the post-action settle probe runs. Defaults to true. */
  settleProbe?: boolean;
  /** (A3) Whether loop detection stops a stuck run early. Defaults to true. */
  loopDetection?: boolean;
  /** (A3) How many recent steps the loop detector compares. */
  loopWindow?: number;
  /** (B1) Whether secret values/patterns are masked in details/logs/overlay. Defaults true. */
  redactSecrets?: boolean;
  /** (B2) Whether a destructive submit requires inline confirmation. Defaults false. */
  confirmDestructive?: boolean;
  /**
   * (B2) Human-in-the-loop confirmation callback used when {@link confirmDestructive} is on
   * and the destructive guard would refuse. When omitted, the refuse-by-default fail-safe is
   * preserved. Wired to MCP elicitation in src/server.ts.
   */
  confirm?: ConfirmFn;
  /** (C1) Which snapshot backend the loop captures with: `domwalk` (default) or `aria`. */
  snapshotBackend?: SnapshotBackend;
  /** (C3) Whether per-step captures order controls by viewport proximity first. */
  viewportPriority?: boolean;
  /** (C2) Whether the escalation path may send a delta-only prompt when a diff exists. */
  deltaPrompt?: boolean;
  /**
   * (D1) Whether the loop records per-step observability artifacts (screenshot + snapshot +
   * decision + confidence + timing) for the replay export. Defaults false so normal runs are
   * not slowed. This is an EXPLICIT opt-in (env LAYA_RECORD_ARTIFACTS): recording is enabled
   * ONLY when this is true. The presence of {@link artifacts} does NOT enable recording; the
   * holder merely receives the artifacts when recording is on.
   */
  recordArtifacts?: boolean;
  /** (T1.4) Whether the loop captures a per-step screenshot even without artifact recording. */
  loopScreenshots?: boolean;
  /** (T1.3) Max chars of visible text carried into the Autopilot state / escalation prompt. */
  stateTextLimit?: number;
  /** (T2.2) Whether to auto-dismiss cookie/consent/modal overlays before each step. */
  autoDismiss?: boolean;
  /** (T2.3) Same-origin iframe / open shadow-root descent depth for per-step capture. */
  frameDepth?: number;
  /**
   * (D1) Shared holder for the most recent run's artifacts. When recording is enabled (see
   * {@link recordArtifacts}), the run stores its artifacts here for the laya_export_run tool
   * to read. Shared by reference with the export tool's context in src/server.ts. The holder
   * alone does NOT enable recording.
   */
  artifacts?: RunArtifactsHolder;
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

/**
 * (D2) The subset of the SDK's `RequestHandlerExtra` this handler uses: the optional
 * `_meta.progressToken` and the `sendNotification` sink. Kept structural (not importing the
 * SDK's generic type) so the handler stays easy to unit-test with a fake `extra`, while
 * still being assignable from the real SDK extra at the call site. `sendNotification` is
 * typed loosely for the same reason.
 */
export interface RunGoalExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => void | Promise<void>;
}

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
      const key = s.key !== undefined ? ` key=${JSON.stringify(s.key)}` : "";
      const fields =
        s.fields !== undefined
          ? ` fields=[${s.fields
              .map((f) => `${f.target}=${JSON.stringify(f.value)}`)
              .join(", ")}]`
          : "";
      const marker = s.marker !== undefined ? ` marker=${JSON.stringify(s.marker)}` : "";
      const verified =
        s.verified !== undefined ? ` verified=${s.verified ? "true" : "false"}` : "";
      const note = s.note ? ` (${s.note})` : "";
      lines.push(
        `  ${s.step}. ${s.operation}${tgt}${key}${fields}${marker}${val}${verified} [${s.source}, ${conf}] - ${s.detail}${note}`,
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
  // Signature is (args, extra), matching the SDK ToolCallback. `extra` is optional so the
  // handler can also be called directly in tests without an MCP request context.
  return async (args: Args, extra?: RunGoalExtra): Promise<ToolResult> => {
    try {
      // (D2) When the client supplied a progressToken on the request meta, stream a
      // notifications/progress per step. A no-op when absent (backward-compatible): no token
      // or no sink means onProgress is never wired, so no notifications are emitted.
      const progressToken = extra?._meta?.progressToken;
      const sendNotification = extra?.sendNotification;
      const onProgress =
        progressToken !== undefined && sendNotification
          ? async (info: { step: number; total: number; message: string }): Promise<void> => {
              await sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: info.step,
                  total: info.total,
                  message: info.message,
                },
              });
            }
          : undefined;

      // (D1) Record per-step artifacts ONLY when explicitly opted in (LAYA_RECORD_ARTIFACTS,
      // threaded here as ctx.recordArtifacts). Off by default so normal runs are not slowed:
      // the mere presence of the shared holder does NOT enable recording. When recording is
      // off the holder simply never receives a run and laya_export_run reports none recorded.
      const recordArtifacts = ctx.recordArtifacts === true;
      // Thread the session's visual overlay (agentLens HUD) and the active page into the loop
      // so each step is narrated on-page. Both are optional: the overlay is a guarded no-op
      // when disabled, and the loop treats a missing overlay as no narration at all.
      //
      // Acquire the page ONLY when the engine can actually run a goal. On the no-weights
      // degraded path runGoal returns immediately without a browser, so launching one here
      // just to narrate would be wasted startup cost — keep that path launch-free.
      const overlay = ctx.session.getOverlay();
      const overlayPage = ctx.engine.available
        ? await ctx.session.getPage()
        : undefined;
      const result = await runGoal({
        goal: args.goal,
        session: ctx.session,
        engine: ctx.engine,
        overlay,
        ...(overlayPage !== undefined ? { overlayPage } : {}),
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
        ...(ctx.confidenceThreshold !== undefined
          ? { confidenceThreshold: ctx.confidenceThreshold }
          : {}),
        ...(ctx.sample !== undefined ? { sample: ctx.sample } : {}),
        ...(ctx.allowedDomains !== undefined
          ? { allowedDomains: ctx.allowedDomains }
          : {}),
        ...(ctx.destructiveFormGuard !== undefined
          ? { destructiveFormGuard: ctx.destructiveFormGuard }
          : {}),
        ...(ctx.waitMs !== undefined ? { waitMs: ctx.waitMs } : {}),
        ...(ctx.selfHealRetries !== undefined
          ? { selfHealRetries: ctx.selfHealRetries }
          : {}),
        ...(ctx.settleProbe !== undefined ? { settleProbe: ctx.settleProbe } : {}),
        ...(ctx.loopDetection !== undefined
          ? { loopDetection: ctx.loopDetection }
          : {}),
        ...(ctx.loopWindow !== undefined ? { loopWindow: ctx.loopWindow } : {}),
        ...(ctx.redactSecrets !== undefined
          ? { redactSecrets: ctx.redactSecrets }
          : {}),
        ...(ctx.confirmDestructive !== undefined
          ? { confirmDestructive: ctx.confirmDestructive }
          : {}),
        ...(ctx.confirm !== undefined ? { confirm: ctx.confirm } : {}),
        ...(ctx.snapshotBackend !== undefined
          ? { snapshotBackend: ctx.snapshotBackend }
          : {}),
        ...(ctx.viewportPriority !== undefined
          ? { viewportPriority: ctx.viewportPriority }
          : {}),
        ...(ctx.deltaPrompt !== undefined ? { deltaPrompt: ctx.deltaPrompt } : {}),
        ...(recordArtifacts ? { recordArtifacts: true } : {}),
        ...(ctx.loopScreenshots !== undefined
          ? { loopScreenshots: ctx.loopScreenshots }
          : {}),
        ...(ctx.stateTextLimit !== undefined
          ? { stateOptions: { maxVisibleText: ctx.stateTextLimit } }
          : {}),
        ...(ctx.autoDismiss !== undefined ? { autoDismiss: ctx.autoDismiss } : {}),
        ...(ctx.frameDepth !== undefined ? { frameDepth: ctx.frameDepth } : {}),
        ...(onProgress !== undefined ? { onProgress } : {}),
      });
      // (D1) Persist the most recent run's artifacts into the shared holder so the
      // laya_export_run tool can write a replay. Only when recording was enabled (result.steps
      // is populated by the loop solely when recordArtifacts is true) and a holder was wired.
      if (recordArtifacts && ctx.artifacts !== undefined && result.steps !== undefined) {
        ctx.artifacts.last = {
          goal: result.goal,
          outcome: result.outcome,
          finishedAt: new Date().toISOString(),
          steps: result.steps,
        };
      }
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
