/** `browser_hover` — hover over an element resolved from a ref or selector. */
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
};

type Args = { element?: string; target: string };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      // Ensure the page exists before resolving the ref: resolveRef() is sync and throws
      // when the browser is still launching (e.g. a pipelined navigate+hover). getPage() is
      // idempotent and serialises concurrent launches, matching the other tools' pattern.
      await ctx.session.getPage();
      const locator = ctx.session.resolveRef(args.target);
      await locator.hover();
    } catch (err) {
      return textResult(`Failed to hover over ${args.target}: ${(err as Error).message}`, true);
    }
    const label = args.element ?? args.target;
    return snapshotResult(ctx, `Hovered over ${label}`);
  };
}

export const definition = {
  name: "browser_hover",
  description: "Hover over an element identified by a snapshot ref (eN) or a Playwright selector.",
  inputSchema,
};
