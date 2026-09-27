/**
 * (D1) A tiny mutable holder for the most recent Autopilot run's observability artifacts.
 *
 * The server holds a single {@link ../browser.BrowserSession}, so at most one Autopilot run
 * is "current" at a time. This holder is created ONCE in src/server.ts and shared (by
 * reference) between the `laya_run_goal` tool context (which writes the last run's artifacts)
 * and the `laya_export_run` tool context (which reads them to write a replay artifact). Keeps
 * the two tools decoupled from each other while sharing state.
 *
 * All text carried in the artifacts is already redacted per B1 by the loop before it lands
 * here, so nothing further is needed at this boundary.
 */
import type { RunStepArtifact } from "../autopilot/loop.js";

/** A recorded run kept for the replay export: its goal, outcome, and per-step artifacts. */
export interface RecordedRun {
  /** The natural-language goal the run pursued. */
  goal: string;
  /** How the run ended (done / blocked / stuck / max_steps / error / degraded). */
  outcome: string;
  /** ISO-8601 timestamp of when the run finished (for the replay header). */
  finishedAt: string;
  /** Per-step observability artifacts (screenshot + snapshot + decision + confidence + timing). */
  steps: RunStepArtifact[];
}

/**
 * A shared holder for the latest recorded run. Created once and passed by reference into
 * both the run_goal and export_run tool contexts so the export tool can read what the last
 * run recorded. `last` is undefined until a run with artifact recording enabled completes.
 */
export interface RunArtifactsHolder {
  last?: RecordedRun;
}

/** Create an empty artifacts holder. */
export function createRunArtifactsHolder(): RunArtifactsHolder {
  return {};
}
