/** `browser_drag` — drag one element and drop it onto another. */
import {
  elementDescription,
  snapshotResult,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

export const inputSchema = {
  startElement: elementDescription,
  startTarget: targetSchema,
  endElement: elementDescription,
  endTarget: targetSchema,
};

type Args = {
  startElement?: string;
  startTarget: string;
  endElement?: string;
  endTarget: string;
};

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      // Ensure the page exists before resolving refs: resolveRef() is sync and throws
      // when the browser is still launching. getPage() is idempotent and serialises
      // concurrent launches, matching the other ref-based tools' pattern.
      await ctx.session.getPage();
      const source = ctx.session.resolveRef(args.startTarget);
      const dest = ctx.session.resolveRef(args.endTarget);
      await source.dragTo(dest);
    } catch (err) {
      return textResult(
        `Failed to drag ${args.startTarget} to ${args.endTarget}: ${(err as Error).message}`,
        true,
      );
    }
    const from = args.startElement ?? args.startTarget;
    const to = args.endElement ?? args.endTarget;
    return snapshotResult(ctx, `Dragged ${from} onto ${to}`);
  };
}

export const definition = {
  name: "browser_drag",
  description: "Drag one element (ref eN or selector) and drop it onto another element.",
  inputSchema,
};
