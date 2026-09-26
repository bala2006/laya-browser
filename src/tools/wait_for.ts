/** `browser_wait_for` — wait for text to appear, text to disappear, or a fixed time. */
import { z } from "zod";
import { snapshotResult, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  text: z.string().optional().describe("Wait until this text appears on the page."),
  textGone: z.string().optional().describe("Wait until this text is no longer on the page."),
  time: z.number().optional().describe("Wait for this many seconds."),
};

type Args = { text?: string; textGone?: string; time?: number };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    if (args.text === undefined && args.textGone === undefined && args.time === undefined) {
      return textResult("browser_wait_for requires one of: text, textGone, or time.", true);
    }
    try {
      const page = await ctx.session.getPage();
      if (args.time !== undefined) {
        await page.waitForTimeout(args.time * 1000);
      }
      if (args.text !== undefined) {
        await page.getByText(args.text).first().waitFor({ state: "visible" });
      }
      if (args.textGone !== undefined) {
        await page.getByText(args.textGone).first().waitFor({ state: "hidden" });
      }
    } catch (err) {
      return textResult(`Wait failed: ${(err as Error).message}`, true);
    }
    return snapshotResult(ctx, "Wait complete");
  };
}

export const definition = {
  name: "browser_wait_for",
  description: "Wait for text to appear, text to disappear, or a fixed number of seconds.",
  inputSchema,
};
