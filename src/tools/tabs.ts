/** `browser_tabs` — list, create, close, and select browser tabs. */
import { z } from "zod";
import { snapshotResult, textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  action: z
    .enum(["list", "create", "close", "select"])
    .describe("The tab operation: list all tabs, create a new one, close one, or select one."),
  index: z
    .number()
    .int()
    .optional()
    .describe("0-based tab index for 'close' and 'select'."),
  url: z
    .string()
    .optional()
    .describe("Optional URL to open in the new tab for 'create'."),
};

type Args = { action: "list" | "create" | "close" | "select"; index?: number; url?: string };

/** Render the tab list as a stable, human-readable table. */
function renderTabs(
  tabs: Array<{ index: number; title: string; url: string; active: boolean }>,
): string {
  if (tabs.length === 0) return "No open tabs.";
  const lines = tabs.map(
    (t) =>
      `${t.active ? "*" : " "} [${t.index}] ${t.title || "(untitled)"} — ${t.url || "about:blank"}`,
  );
  return `Open tabs (${tabs.length}):\n${lines.join("\n")}`;
}

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      switch (args.action) {
        case "list": {
          const tabs = await ctx.session.listTabs();
          return textResult(renderTabs(tabs));
        }
        case "create": {
          const index = await ctx.session.newTab(args.url);
          return snapshotResult(ctx, `Opened tab ${index}`);
        }
        case "select": {
          if (args.index === undefined) {
            return textResult("browser_tabs 'select' requires an `index`.", true);
          }
          await ctx.session.selectTab(args.index);
          return snapshotResult(ctx, `Selected tab ${args.index}`);
        }
        case "close": {
          if (args.index === undefined) {
            return textResult("browser_tabs 'close' requires an `index`.", true);
          }
          await ctx.session.closeTab(args.index);
          const tabs = await ctx.session.listTabs();
          return textResult(`Closed tab ${args.index}.\n${renderTabs(tabs)}`);
        }
        default: {
          return textResult(`Unknown tab action: ${String(args.action)}`, true);
        }
      }
    } catch (err) {
      return textResult(`Failed to ${args.action} tab: ${(err as Error).message}`, true);
    }
  };
}

export const definition = {
  name: "browser_tabs",
  description:
    "Manage browser tabs: list open tabs, create a new tab (optionally at a URL), close a tab by index, or select a tab by index.",
  inputSchema,
};
