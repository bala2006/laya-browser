/**
 * Shared plumbing for the Assist-mode MCP tools.
 *
 * Each tool receives a {@link ToolContext} (the shared {@link BrowserSession}), acts on the
 * page, and — for mutating tools — returns a fresh snapshot so the client sees the new page
 * state, matching Playwright MCP behaviour.
 */
import { z } from "zod";
import type { BrowserSession } from "../browser.js";
import type { LayaBrowserConfig } from "../config.js";
import type { RunArtifactsHolder } from "./run_artifacts.js";
import { capture } from "../snapshot.js";

/** The context handed to every Assist tool handler. */
export interface ToolContext {
  /** The shared browser session all tools act on. */
  session: BrowserSession;
  /**
   * The resolved, typed configuration. Threaded inward so tools such as
   * `browser_get_config` can report the effective settings without re-reading the
   * environment. Optional so lightweight test contexts can omit it.
   */
  config?: LayaBrowserConfig;
  /**
   * Domain allow-list applied to navigating tools (e.g. `browser_navigate`). When
   * non-empty, navigation to a host not on the list is rejected. Empty means allow all.
   */
  allowedDomains?: string[];
  /**
   * Whether `browser_run_code_unsafe` may execute raw Playwright snippets. When false (the
   * default) the tool refuses with a clear message instead of running anything.
   */
  allowUnsafeCode?: boolean;
  /**
   * (B3) Whether the destructive-action guard also applies to Assist-mode tools (opt-in).
   * Default false: when false, Assist tools behave byte-for-byte as before (no snapshot, no
   * guard). When true, `browser_click` captures a snapshot, resolves the target control, and
   * refuses a destructive click. Scoped to `browser_click` as the required example; other
   * Assist tools remain unguarded by design.
   */
  assistDestructiveGuard?: boolean;
  /**
   * (D1) Shared holder for the most recent Autopilot run's observability artifacts, used by
   * the laya_export_run tool to write a replay. Created once in src/server.ts and shared by
   * reference with the laya_run_goal tool context. Optional so lightweight test contexts and
   * tools that do not need it can omit it.
   */
  artifacts?: RunArtifactsHolder;
}

/** MCP tool result content block (text). */
interface TextContent {
  type: "text";
  text: string;
}

/** MCP tool result content block (image), used by browser_take_screenshot. */
interface ImageContent {
  type: "image";
  /** Base64-encoded image bytes. */
  data: string;
  /** The image MIME type, e.g. `"image/png"`. */
  mimeType: string;
}

/** A single content block returned by a tool: text or image. */
export type ContentBlock = TextContent | ImageContent;

/** The shape an MCP tool handler must return. */
export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Wrap plain text into an MCP text result. */
export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** Wrap base64 image bytes into an MCP image result. */
export function imageResult(data: string, mimeType: string): ToolResult {
  return { content: [{ type: "image", data, mimeType }] };
}

/**
 * Common tool params, following the Playwright MCP convention:
 * an optional human-readable `element` description plus a `target` that is either a
 * snapshot ref (`eN`) or a raw Playwright selector.
 */
export const elementDescription = z
  .string()
  .optional()
  .describe("Human-readable element description used to obtain permission to interact with the element.");

export const targetSchema = z
  .string()
  .describe(
    "Exact target reference from a snapshot (e.g. 'e5'), or a unique Playwright selector (CSS/text).",
  );

/**
 * Capture the current page state and render it as a tool result.
 *
 * Mutating tools call this after acting so the returned content reflects the new state.
 * `header` is prepended (e.g. a short description of the action just taken).
 */
export async function snapshotResult(
  ctx: ToolContext,
  header?: string,
): Promise<ToolResult> {
  const page = await ctx.session.getPage();
  // (C1/C3) Honour the configured snapshot backend and viewport-priority ordering when a
  // typed config was threaded in; defaults (domwalk, no reordering) keep existing behaviour.
  const snap = await capture(page, captureOptionsFromConfig(ctx.config));
  const body = header ? `${header}\n\n${snap.text}` : snap.text;
  return textResult(body);
}

/**
 * Derive {@link capture} options from the typed config: the C1 snapshot backend and the C3
 * viewport-priority ordering. Returns empty options (all defaults) when no config is present,
 * so lightweight test contexts and untyped callers are unaffected.
 */
export function captureOptionsFromConfig(
  config?: LayaBrowserConfig,
): { backend?: LayaBrowserConfig["snapshotBackend"]; viewportPriority?: boolean } {
  if (!config) return {};
  return {
    backend: config.snapshotBackend,
    viewportPriority: config.viewportPriority,
  };
}
