/** `browser_file_upload` — set files on a file input (or respond to a chooser). */
import { z } from "zod";
import {
  elementDescription,
  snapshotResult,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

export const inputSchema = {
  paths: z
    .array(z.string())
    .describe("Absolute file paths to upload."),
  element: elementDescription,
  target: targetSchema
    .optional()
    .describe("Optional file input ref (eN) or selector to set the files on."),
};

type Args = { paths: string[]; element?: string; target?: string };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    if (!args.paths?.length) {
      return textResult("browser_file_upload requires at least one path in `paths`.", true);
    }
    try {
      // Ensure the page exists before resolving the ref: resolveRef() is sync and throws
      // when the browser is still launching. getPage() is idempotent and serialises
      // concurrent launches, matching the other ref-based tools' pattern.
      const page = await ctx.session.getPage();
      // Follow Playwright MCP semantics: the target is (or contains) a file input, and
      // setInputFiles both dismisses any pending chooser and assigns the files.
      const selector = args.target ?? "input[type=file]";
      const locator = ctx.session.resolveRef(selector);
      await locator.setInputFiles(args.paths);
      void page;
    } catch (err) {
      return textResult(`Failed to upload files: ${(err as Error).message}`, true);
    }
    const label = args.element ?? args.target ?? "file input";
    return snapshotResult(ctx, `Uploaded ${args.paths.length} file(s) to ${label}`);
  };
}

export const definition = {
  name: "browser_file_upload",
  description:
    "Upload one or more files by setting them on a file input identified by a ref (eN) or selector (defaults to the first file input on the page).",
  inputSchema,
};
