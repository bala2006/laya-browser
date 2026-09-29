/** `browser_navigate_back` — go back to the previous page, then return a fresh snapshot. */
import { snapshotResult, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {};

type Args = Record<string, never>;

export function makeHandler(ctx: ToolContext) {
  return async (_args?: Args): Promise<ToolResult> => {
    const page = await ctx.session.getPage();
    await ctx.session.narrate(undefined, "Going back");
    try {
      await page.goBack({ waitUntil: "domcontentloaded" });
    } catch (err) {
      return textResult(`Failed to navigate back: ${(err as Error).message}`, true);
    }
    return snapshotResult(ctx, `Navigated back to ${page.url()}`);
  };
}

export const definition = {
  name: "browser_navigate_back",
  description: "Navigate back to the previous page and return a snapshot of the resulting page.",
  inputSchema,
};
