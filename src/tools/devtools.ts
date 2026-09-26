/**
 * DEVTOOLS capability tools (capability: `devtools`).
 *
 * Where Playwright offers a faithful headless analogue we implement the real behaviour:
 *   - browser_start_tracing / browser_stop_tracing use context.tracing and write a real
 *     trace zip that can be opened with `npx playwright show-trace`.
 *   - browser_highlight / browser_hide_highlight draw and remove a real outline on the
 *     target element via an injected inline style.
 *
 * The remaining tools correspond to Playwright's INTERACTIVE / codegen-inspector features
 * (screen recording, live video chapters/annotations, action overlays, and the "resume"
 * button of the paused inspector). Those have no faithful headless analogue, so instead of
 * faking success these tools return an HONEST text result that states what the tool would
 * do in a headed codegen session and that it is not fully supported headless. This
 * divergence from Playwright is deliberate and documented in README + PLAN.
 */
import { z } from "zod";
import type { ToolModule } from "./registry.js";
import {
  elementDescription,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

/**
 * Build an honest "not supported headless" tool: it never fakes success and explains what
 * the real, interactive Playwright feature would do. `isError` is false because refusing is
 * the correct, expected behaviour, not a failure the caller must recover from.
 */
function honestUnsupported(name: string, description: string, explanation: string): ToolModule {
  return {
    definition: { name, description, inputSchema: {} },
    inputSchema: {},
    makeHandler: (() => async (): Promise<ToolResult> =>
      textResult(
        `${name} is not fully supported in headless laya-browser. ${explanation}`,
      )) as ToolModule["makeHandler"],
  };
}

// --- browser_start_tracing (real) ---

export const startTracingInputSchema = {};

export function makeStartTracingHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    try {
      await ctx.session.startTracing();
      return textResult("Started Playwright tracing (screenshots, snapshots, sources).");
    } catch (err) {
      return textResult(`Failed to start tracing: ${(err as Error).message}`, true);
    }
  };
}

export const startTracingDefinition = {
  name: "browser_start_tracing",
  description:
    "Start Playwright context tracing (screenshots + snapshots + sources). Finalise with browser_stop_tracing.",
  inputSchema: startTracingInputSchema,
};

// --- browser_stop_tracing (real) ---

export const stopTracingInputSchema = {
  path: z.string().describe("Filesystem path to write the trace zip to."),
};

type StopTracingArgs = { path: string };

export function makeStopTracingHandler(ctx: ToolContext) {
  return async (args: StopTracingArgs): Promise<ToolResult> => {
    try {
      await ctx.session.stopTracing(args.path);
      return textResult(`Stopped tracing and wrote trace to ${args.path}.`);
    } catch (err) {
      return textResult(`Failed to stop tracing: ${(err as Error).message}`, true);
    }
  };
}

export const stopTracingDefinition = {
  name: "browser_stop_tracing",
  description:
    "Stop Playwright context tracing and write the trace zip to the given path (open with `npx playwright show-trace`).",
  inputSchema: stopTracingInputSchema,
};

// --- browser_highlight (real) ---

export const highlightInputSchema = {
  element: elementDescription,
  target: targetSchema,
};

type HighlightArgs = { element?: string; target: string };

export function makeHighlightHandler(ctx: ToolContext) {
  return async (args: HighlightArgs): Promise<ToolResult> => {
    try {
      await ctx.session.getPage();
      const ok = await ctx.session.highlight(args.target);
      const label = args.element ?? args.target;
      return ok
        ? textResult(`Highlighted ${label} with an outline.`)
        : textResult(`No element matched ${args.target} to highlight.`, true);
    } catch (err) {
      return textResult(`Failed to highlight: ${(err as Error).message}`, true);
    }
  };
}

export const highlightDefinition = {
  name: "browser_highlight",
  description:
    "Draw a visible outline around the element (ref eN or selector) via an injected style. Remove with browser_hide_highlight.",
  inputSchema: highlightInputSchema,
};

// --- browser_hide_highlight (real) ---

export const hideHighlightInputSchema = {};

export function makeHideHighlightHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    try {
      await ctx.session.hideHighlight();
      return textResult("Removed all highlight outlines.");
    } catch (err) {
      return textResult(`Failed to hide highlight: ${(err as Error).message}`, true);
    }
  };
}

export const hideHighlightDefinition = {
  name: "browser_hide_highlight",
  description: "Remove any outlines added by browser_highlight.",
  inputSchema: hideHighlightInputSchema,
};

// --- Interactive / codegen tools with no faithful headless analogue (honest no-ops) ---

export const startVideoModule = honestUnsupported(
  "browser_start_video",
  "Start recording a video of the session.",
  "Video capture requires the browser context to be created with Playwright's recordVideo option before any page opens; it cannot be toggled on mid-session for an already-running headless context. Recreate the session with recordVideo configured, or run headed.",
);

export const stopVideoModule = honestUnsupported(
  "browser_stop_video",
  "Stop the session video recording and finalise the file.",
  "No video recording is active because recordVideo must be configured at context creation. See browser_start_video.",
);

export const videoChapterModule = honestUnsupported(
  "browser_video_chapter",
  "Mark a named chapter in the session video.",
  "Video chapter markers are a live codegen/trace-viewer feature with no headless equivalent.",
);

export const videoShowActionsModule = honestUnsupported(
  "browser_video_show_actions",
  "Overlay action highlights on the recorded video.",
  "Action overlays are rendered by the interactive trace viewer, not produced headless.",
);

export const videoHideActionsModule = honestUnsupported(
  "browser_video_hide_actions",
  "Hide the action overlays on the recorded video.",
  "Action overlays are rendered by the interactive trace viewer, not produced headless.",
);

export const startRecordingModule = honestUnsupported(
  "browser_start_recording",
  "Start codegen action recording.",
  "Codegen recording is driven by Playwright's headed inspector (playwright codegen); there is no faithful headless equivalent. Use browser_start_tracing for a headless trace instead.",
);

export const stopRecordingModule = honestUnsupported(
  "browser_stop_recording",
  "Stop codegen action recording and emit the script.",
  "Codegen recording is driven by Playwright's headed inspector. Use browser_stop_tracing for a headless trace instead.",
);

export const annotateModule = honestUnsupported(
  "browser_annotate",
  "Add an annotation to the interactive session.",
  "Annotations are a live inspector feature with no headless analogue; use browser_highlight to mark an element on the page instead.",
);

export const resumeModule = honestUnsupported(
  "browser_resume",
  "Resume a paused interactive (page.pause) session.",
  "There is no paused inspector to resume in a headless session; page.pause only blocks under the headed inspector.",
);

// --- Registry modules (real tools) ---

export const startTracingModule: ToolModule = {
  definition: startTracingDefinition,
  inputSchema: startTracingInputSchema,
  makeHandler: makeStartTracingHandler as ToolModule["makeHandler"],
};

export const stopTracingModule: ToolModule = {
  definition: stopTracingDefinition,
  inputSchema: stopTracingInputSchema,
  makeHandler: makeStopTracingHandler as ToolModule["makeHandler"],
};

export const highlightModule: ToolModule = {
  definition: highlightDefinition,
  inputSchema: highlightInputSchema,
  makeHandler: makeHighlightHandler as ToolModule["makeHandler"],
};

export const hideHighlightModule: ToolModule = {
  definition: hideHighlightDefinition,
  inputSchema: hideHighlightInputSchema,
  makeHandler: makeHideHighlightHandler as ToolModule["makeHandler"],
};
