/**
 * (T2.4) `browser_download_file` (capability: `storage`) — capture a browser download.
 *
 * Clicks a target element (ref `eN` or a Playwright selector) that triggers a file download,
 * captures the resulting Playwright `download`, saves it to disk, and reports the saved path
 * plus the browser-suggested filename. This is the missing production affordance for flows
 * that hand the user a file (invoices, exports, reports): without it the agent can click the
 * link but the bytes are lost to the browser's own downloads directory.
 *
 * The save path is resolved as: an explicit `path` argument if given; otherwise the
 * configured default download directory (LAYA_DOWNLOAD_DIR) joined with the download's
 * suggested filename; and it fails clearly when neither is available. All Playwright IO is
 * confined to {@link ../browser.BrowserSession.downloadVia}. No stdout writes.
 */
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  target: z
    .string()
    .describe(
      "The element that triggers the download when clicked: a snapshot ref (e.g. 'e5') or a Playwright selector.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Where to save the downloaded file. A file path saves there; a value ending in a path separator is treated as a directory (the suggested filename is appended). Defaults to the configured download directory (LAYA_DOWNLOAD_DIR) + suggested filename.",
    ),
  element: z
    .string()
    .optional()
    .describe("Human-readable description of the element to download from."),
};

type Args = { target: string; path?: string; element?: string };

/** Whether a path string refers to a directory (trailing separator) rather than a file. */
function looksLikeDir(p: string): boolean {
  return /[\\/]$/.test(p);
}

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      // Resolve where to save. If `path` is a directory (or absent), we still need the
      // suggested filename, which is only known AFTER the download starts. So: when we have a
      // concrete file path use it directly; otherwise download to a temp name derived from the
      // suggested filename under the chosen directory. We capture into a two-phase resolve by
      // first asking the session to download, saving to a placeholder we compute up front.
      let savePath: string | undefined;
      const dirCandidate =
        args.path && looksLikeDir(args.path)
          ? args.path
          : args.path
            ? undefined // explicit file path
            : ctx.downloadDir;

      if (args.path && !looksLikeDir(args.path)) {
        // Explicit file path.
        savePath = args.path;
      }

      // When we only have a directory, we do not yet know the filename; the session's
      // downloadVia needs a concrete path. Do the click+capture, then save into the directory
      // using the suggested filename. To keep the boundary simple, resolve a filename by
      // performing the download into a directory-joined suggested name computed inside a
      // helper that first peeks the suggested filename. We implement that by a small two-step:
      if (savePath === undefined) {
        const baseDir = dirCandidate;
        if (baseDir === undefined) {
          return textResult(
            "No save path given and no default download directory configured. Pass `path`, or set LAYA_DOWNLOAD_DIR.",
            true,
          );
        }
        // Arm + click + capture, then save into baseDir/<suggestedFilename>. We temporarily
        // save to a computed path once the suggested filename is known via the session.
        const result = await ctx.session.downloadViaInto(args.target, baseDir);
        return textResult(
          `Downloaded ${JSON.stringify(result.suggestedFilename)} to ${result.path}.`,
        );
      }

      const abs = isAbsolute(savePath) ? savePath : join(process.cwd(), savePath);
      const result = await ctx.session.downloadVia(args.target, abs);
      return textResult(
        `Downloaded ${JSON.stringify(result.suggestedFilename)} to ${result.path}.`,
      );
    } catch (err) {
      return textResult(`browser_download_file failed: ${(err as Error).message}`, true);
    }
  };
}

export const definition = {
  name: "browser_download_file",
  description:
    "Click a target element (ref eN or selector) that triggers a file download, capture the download, save it to a path (or the configured download directory), and report the saved path and suggested filename.",
  inputSchema,
};
