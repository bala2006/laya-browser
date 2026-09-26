/** `browser_click` — click an element resolved from a ref or selector. */
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
  doubleClick: z.boolean().optional().describe("Whether to perform a double click instead of a single click."),
  button: z
    .enum(["left", "right", "middle"])
    .optional()
    .describe("Mouse button to use for the click. Defaults to left."),
};

type Args = {
  element?: string;
  target: string;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
};

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      // Ensure the page exists before resolving the ref: resolveRef() is sync and throws
      // when the browser is still launching (e.g. a pipelined navigate+click). getPage() is
      // idempotent and serialises concurrent launches, matching the other tools' pattern.
      await ctx.session.getPage();
      const locator = ctx.session.resolveRef(args.target);
      const options = args.button ? { button: args.button } : {};
      if (args.doubleClick) {
        await locator.dblclick(options);
      } else {
        await locator.click(options);
      }
    } catch (err) {
      return textResult(`Failed to click ${args.target}: ${(err as Error).message}`, true);
    }
    const label = args.element ?? args.target;
    return snapshotResult(ctx, `Clicked ${label}`);
  };
}

export const definition = {
  name: "browser_click",
  description: "Click an element identified by a snapshot ref (eN) or a Playwright selector.",
  inputSchema,
};
