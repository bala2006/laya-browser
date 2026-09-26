/**
 * Storage-state save/restore tools (capability: `storage`).
 *
 * `browser_storage_state` writes the context's cookies + per-origin localStorage to a JSON
 * file (Playwright's storageState format). `browser_set_storage_state` reads that file back
 * and restores it into the live session, so a caller can persist and resume an
 * authenticated session across runs.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolModule } from "./registry.js";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

// --- browser_storage_state ---

export const saveInputSchema = {
  path: z.string().describe("Filesystem path to write the storage-state JSON to."),
};

type SaveArgs = { path: string };

export function makeSaveHandler(ctx: ToolContext) {
  return async (args: SaveArgs): Promise<ToolResult> => {
    try {
      const state = await ctx.session.saveStorageState(args.path);
      const cookieCount = state.cookies?.length ?? 0;
      const originCount = state.origins?.length ?? 0;
      return textResult(
        `Saved storage state to ${args.path} (${cookieCount} cookie(s), ${originCount} origin(s)).`,
      );
    } catch (err) {
      return textResult(`Failed to save storage state: ${(err as Error).message}`, true);
    }
  };
}

export const saveDefinition = {
  name: "browser_storage_state",
  description:
    "Save the browser context's cookies and per-origin localStorage to a JSON file (Playwright storageState format).",
  inputSchema: saveInputSchema,
};

// --- browser_set_storage_state ---

export const restoreInputSchema = {
  path: z.string().describe("Filesystem path to a storage-state JSON file to restore."),
};

type RestoreArgs = { path: string };

export function makeRestoreHandler(ctx: ToolContext) {
  return async (args: RestoreArgs): Promise<ToolResult> => {
    try {
      const raw = await readFile(args.path, "utf8");
      const state = JSON.parse(raw) as {
        cookies?: Array<Record<string, unknown>>;
        origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
      };
      await ctx.session.restoreStorageState(
        state as Parameters<typeof ctx.session.restoreStorageState>[0],
      );
      const cookieCount = state.cookies?.length ?? 0;
      const originCount = state.origins?.length ?? 0;
      return textResult(
        `Restored storage state from ${args.path} (${cookieCount} cookie(s), ${originCount} origin(s)).`,
      );
    } catch (err) {
      return textResult(`Failed to restore storage state: ${(err as Error).message}`, true);
    }
  };
}

export const restoreDefinition = {
  name: "browser_set_storage_state",
  description:
    "Restore cookies and per-origin localStorage from a storage-state JSON file into the current session.",
  inputSchema: restoreInputSchema,
};

// --- Registry modules ---

export const saveModule: ToolModule = {
  definition: saveDefinition,
  inputSchema: saveInputSchema,
  makeHandler: makeSaveHandler as ToolModule["makeHandler"],
};

export const restoreModule: ToolModule = {
  definition: restoreDefinition,
  inputSchema: restoreInputSchema,
  makeHandler: makeRestoreHandler as ToolModule["makeHandler"],
};
