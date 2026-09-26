/** `browser_resize` — resize the page viewport, then return a fresh snapshot. */
import { z } from "zod";
import { snapshotResult, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  width: z.number().int().positive().describe("Viewport width in pixels."),
  height: z.number().int().positive().describe("Viewport height in pixels."),
};

type Args = { width: number; height: number };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    const page = await ctx.session.getPage();
    try {
      await page.setViewportSize({ width: args.width, height: args.height });
    } catch (err) {
      return textResult(`Failed to resize viewport: ${(err as Error).message}`, true);
    }
    return snapshotResult(ctx, `Resized viewport to ${args.width}x${args.height}`);
  };
}

export const definition = {
  name: "browser_resize",
  description: "Resize the browser viewport to the given width and height, then return a snapshot.",
  inputSchema,
};
