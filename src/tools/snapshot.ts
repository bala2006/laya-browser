/** `browser_snapshot` — capture and return the current page's accessibility snapshot. */
import { snapshotResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {};

export function makeHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    return snapshotResult(ctx);
  };
}

export const definition = {
  name: "browser_snapshot",
  description:
    "Capture a compact accessibility snapshot of the current page. Interactive elements carry stable [ref=eN] markers used as targets for other tools.",
  inputSchema,
};
