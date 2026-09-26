/** `browser_select_option` — choose one or more options in a <select>. */
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
  element: elementDescription,
  target: targetSchema,
  values: z
    .array(z.string())
    .describe("Option value(s) or label(s) to select. Multiple for a multi-select."),
};

type Args = { element?: string; target: string; values: string[] };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      const locator = ctx.session.resolveRef(args.target);
      // Try matching by label first, then fall back to value, so callers can use either.
      await locator.selectOption(args.values.map((v) => ({ label: v }))).catch(async () => {
        await locator.selectOption(args.values);
      });
    } catch (err) {
      return textResult(`Failed to select option in ${args.target}: ${(err as Error).message}`, true);
    }
    const label = args.element ?? args.target;
    return snapshotResult(ctx, `Selected ${JSON.stringify(args.values)} in ${label}`);
  };
}

export const definition = {
  name: "browser_select_option",
  description: "Select one or more options in a dropdown identified by a snapshot ref (eN) or selector.",
  inputSchema,
};
