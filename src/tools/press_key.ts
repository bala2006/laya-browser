/** `browser_press_key` — press a keyboard key on the page. */
import { z } from "zod";
import { snapshotResult, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  key: z
    .string()
    .describe("Key to press, e.g. 'Enter', 'ArrowDown', 'a', or a combination like 'Control+A'."),
};

type Args = { key: string };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      const page = await ctx.session.getPage();
      await ctx.session.narrate(undefined, `Pressing ${args.key}`);
      await page.keyboard.press(args.key);
    } catch (err) {
      return textResult(`Failed to press key ${args.key}: ${(err as Error).message}`, true);
    }
    return snapshotResult(ctx, `Pressed ${args.key}`);
  };
}

export const definition = {
  name: "browser_press_key",
  description: "Press a keyboard key (or combination) on the current page.",
  inputSchema,
};
