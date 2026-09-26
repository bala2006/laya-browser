/** `browser_close` — close the browser session and release resources. */
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {};

export function makeHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    await ctx.session.close();
    return textResult("Browser closed.");
  };
}

export const definition = {
  name: "browser_close",
  description: "Close the browser session and release all resources.",
  inputSchema,
};
