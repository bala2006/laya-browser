/**
 * `laya_export_run` (capability: `devtools`) - session trace / replay export.
 *
 * Writes a self-contained REPLAY of the most recent Autopilot run to disk: a JSON file
 * (per-step decision / confidence / timing / snapshot text + embedded base64 screenshots)
 * and/or a single self-contained HTML page (inline screenshots + a per-step list). It
 * COMPLEMENTS browser_start_tracing / browser_stop_tracing (which write a Playwright trace
 * zip): this tool captures the Laya DECISION trail, not the raw Playwright action trace.
 *
 * The artifacts are recorded during the run by the loop (D1) and kept on a small shared
 * holder ({@link ./run_artifacts.RunArtifactsHolder}) that both this tool and laya_run_goal
 * share by reference. Recording is an explicit opt-in (env LAYA_RECORD_ARTIFACTS, default
 * off) so normal runs are not slowed. When no run has been recorded yet, the tool returns a
 * clear text result telling the user to enable recording and run laya_run_goal first.
 *
 * All writing goes through node:fs/promises (NEVER stdout - the server speaks JSON-RPC over
 * stdio). All text carried in the artifacts was already redacted per B1 by the loop, so no
 * secret reaches the exported files.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";
import type { RecordedRun, RunArtifactsHolder } from "./run_artifacts.js";
import type { RunStepArtifact } from "../autopilot/loop.js";

/**
 * Extra context the export tool needs: the shared last-run artifacts holder. It is optional
 * on the base {@link ToolContext}; when absent, the tool reports that no run was recorded.
 */
export type ExportRunContext = ToolContext & { artifacts?: RunArtifactsHolder };

export const inputSchema = {
  path: z
    .string()
    .describe(
      "Output path. A file path (its extension is ignored and .json/.html are derived), or a directory (a laya-run.json/.html pair is written inside it).",
    ),
  format: z
    .enum(["html", "json", "both"])
    .optional()
    .describe("Which replay artifact(s) to write. Defaults to 'both'."),
};

type Args = { path: string; format?: "html" | "json" | "both" };

/** Escape a string for safe inclusion in HTML text/attribute content. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Build the JSON replay payload for a recorded run (screenshots embedded as base64). */
function buildJson(run: RecordedRun): string {
  return JSON.stringify(
    {
      goal: run.goal,
      outcome: run.outcome,
      finishedAt: run.finishedAt,
      stepCount: run.steps.length,
      steps: run.steps.map((s) => ({
        step: s.step,
        operation: s.operation,
        ...(s.target !== undefined ? { target: s.target } : {}),
        decision: s.operation,
        operationConfidence: s.operationConfidence,
        targetConfidence: s.targetConfidence,
        confidence: {
          operation: s.operationConfidence,
          target: s.targetConfidence,
        },
        source: s.source,
        detail: s.detail,
        ...(s.note !== undefined ? { note: s.note } : {}),
        timingMs: s.durationMs,
        durationMs: s.durationMs,
        snapshot: s.snapshot,
        ...(s.screenshotPng !== undefined
          ? { screenshotPng: s.screenshotPng }
          : {}),
      })),
    },
    null,
    2,
  );
}

/** Render a single step as an HTML block for the replay page. */
function renderStepHtml(s: RunStepArtifact): string {
  const img =
    s.screenshotPng !== undefined
      ? `<img class="shot" alt="step ${s.step} screenshot" src="data:image/png;base64,${s.screenshotPng}" />`
      : `<div class="noshot">(no screenshot captured)</div>`;
  const note = s.note !== undefined ? `<div class="note">${escapeHtml(s.note)}</div>` : "";
  const target = s.target !== undefined ? ` &rarr; ${escapeHtml(s.target)}` : "";
  return `<section class="step">
  <h2>Step ${s.step}: ${escapeHtml(s.operation)}${target}</h2>
  <div class="meta">
    <span>source: ${escapeHtml(s.source)}</span>
    <span>op conf: ${s.operationConfidence.toFixed(2)}</span>
    <span>tgt conf: ${s.targetConfidence.toFixed(2)}</span>
    <span>timing: ${s.durationMs} ms</span>
  </div>
  <div class="detail">${escapeHtml(s.detail)}</div>
  ${note}
  ${img}
  <details><summary>Snapshot</summary><pre>${escapeHtml(s.snapshot)}</pre></details>
</section>`;
}

/** Build the self-contained HTML replay page for a recorded run. */
function buildHtml(run: RecordedRun): string {
  const steps = run.steps.map(renderStepHtml).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Laya run replay</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 16px 24px; background: #171a21; border-bottom: 1px solid #2a2f3a; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header .sub { color: #9aa4b2; font-size: 13px; }
  main { padding: 16px 24px; display: flex; flex-direction: column; gap: 20px; }
  .step { background: #171a21; border: 1px solid #2a2f3a; border-radius: 8px; padding: 16px; }
  .step h2 { margin: 0 0 8px; font-size: 15px; }
  .meta { display: flex; flex-wrap: wrap; gap: 12px; color: #9aa4b2; font-size: 12px; margin-bottom: 8px; }
  .detail { font-family: ui-monospace, monospace; font-size: 13px; margin-bottom: 8px; }
  .note { color: #c8a45c; font-size: 12px; margin-bottom: 8px; }
  .shot { max-width: 100%; border: 1px solid #2a2f3a; border-radius: 6px; }
  .noshot { color: #6b7280; font-style: italic; font-size: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #0f1115; padding: 8px; border-radius: 6px; font-size: 12px; }
  summary { cursor: pointer; color: #9aa4b2; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Laya run replay</h1>
  <div class="sub">Goal: ${escapeHtml(run.goal)}</div>
  <div class="sub">Outcome: ${escapeHtml(run.outcome)} &middot; ${run.steps.length} step(s) &middot; ${escapeHtml(run.finishedAt)}</div>
</header>
<main>
${steps}
</main>
</body>
</html>`;
}

/**
 * Resolve the JSON/HTML output paths from the requested `path`. When `path` looks like a
 * directory (existing directory, or a trailing separator, or no file extension) a
 * `laya-run.json` / `laya-run.html` pair is written inside it; otherwise the given file's
 * base name (extension stripped) is used with `.json` / `.html` suffixes.
 */
async function resolveOutputPaths(
  path: string,
): Promise<{ jsonPath: string; htmlPath: string; dir: string }> {
  let isDir = /[\\/]$/.test(path);
  if (!isDir) {
    try {
      const s = await stat(path);
      isDir = s.isDirectory();
    } catch {
      // Not an existing path: treat a trailing separator or an extension-less name as a dir.
      isDir = !/\.[^\\/]+$/.test(path);
    }
  }
  if (isDir) {
    return {
      jsonPath: join(path, "laya-run.json"),
      htmlPath: join(path, "laya-run.html"),
      dir: path,
    };
  }
  const base = path.replace(/\.[^\\/]+$/, "");
  return { jsonPath: `${base}.json`, htmlPath: `${base}.html`, dir: dirname(path) };
}

export function makeHandler(ctx: ExportRunContext) {
  return async (args: Args): Promise<ToolResult> => {
    const run = ctx.artifacts?.last;
    if (!run || run.steps.length === 0) {
      return textResult(
        "No Autopilot run has been recorded yet. Per-step artifact recording is off by default; enable it by setting LAYA_RECORD_ARTIFACTS=true, then run laya_run_goal, then call laya_export_run to write the replay.",
      );
    }
    const format = args.format ?? "both";
    try {
      const { jsonPath, htmlPath, dir } = await resolveOutputPaths(args.path);
      // Ensure the parent directory exists (best-effort; writeFile still surfaces real errors).
      await mkdir(dir, { recursive: true }).catch(() => undefined);

      const written: { path: string; bytes: number }[] = [];
      if (format === "json" || format === "both") {
        const json = buildJson(run);
        await writeFile(jsonPath, json, "utf8");
        written.push({ path: jsonPath, bytes: Buffer.byteLength(json, "utf8") });
      }
      if (format === "html" || format === "both") {
        const html = buildHtml(run);
        await writeFile(htmlPath, html, "utf8");
        written.push({ path: htmlPath, bytes: Buffer.byteLength(html, "utf8") });
      }

      const lines = [
        `Exported the last run replay (${run.steps.length} step(s), outcome ${run.outcome}).`,
        ...written.map((w) => `  ${w.path} (${w.bytes} bytes)`),
        "This complements browser_start_tracing / browser_stop_tracing (which write a Playwright trace zip).",
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(`laya_export_run failed: ${(err as Error).message}`, true);
    }
  };
}

export const definition = {
  name: "laya_export_run",
  description:
    "Export a replay of the most recent laya_run_goal run to a path: a JSON file (per-step decision, confidence, timing, snapshot + embedded base64 screenshots) and/or a self-contained HTML replay page. format: 'html' | 'json' | 'both' (default both). Complements browser_start_tracing/browser_stop_tracing. Per-step recording is opt-in via LAYA_RECORD_ARTIFACTS=true; if no run has been recorded, it tells you to enable recording and run laya_run_goal first.",
  inputSchema,
};

export const exportRunModule = {
  definition,
  inputSchema,
  makeHandler: makeHandler as unknown as (
    ctx: ToolContext,
  ) => (args: never) => Promise<ToolResult>,
};
