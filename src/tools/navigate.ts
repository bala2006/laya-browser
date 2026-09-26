/** `browser_navigate` — navigate the page to a URL, then return a fresh snapshot. */
import { z } from "zod";
import { snapshotResult, textResult, type ToolContext, type ToolResult } from "./shared.js";
import { checkDomainAllowed } from "../safety.js";

export const inputSchema = {
  url: z.string().describe("The URL to navigate to."),
};

type Args = { url: string };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    // Domain allow-list guard: refuse off-list navigation when a list is configured.
    const verdict = checkDomainAllowed(args.url, ctx.allowedDomains ?? []);
    if (!verdict.allowed) {
      return textResult(verdict.reason ?? "Navigation blocked by the domain allow-list.", true);
    }
    const page = await ctx.session.getPage();
    try {
      await page.goto(args.url, { waitUntil: "domcontentloaded" });
    } catch (err) {
      return textResult(`Failed to navigate to ${args.url}: ${(err as Error).message}`, true);
    }
    return snapshotResult(ctx, `Navigated to ${page.url()}`);
  };
}

export const definition = {
  name: "browser_navigate",
  description: "Navigate the browser to a URL and return a snapshot of the resulting page.",
  inputSchema,
};
