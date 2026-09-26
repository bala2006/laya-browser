/**
 * `browser_run_code_unsafe` — execute a raw Playwright snippet against the active page.
 *
 * RISK: this runs arbitrary, caller-supplied JavaScript with full access to the Playwright
 * `page` object (navigation, evaluation, file system via Playwright APIs, etc). It is
 * therefore gated behind an explicit opt-in (`LAYA_ALLOW_UNSAFE_CODE=true` /
 * `config.allowUnsafeCode`). When the flag is off the tool is still listed but refuses,
 * so clients discover it exists yet cannot execute code without a deliberate opt-in.
 */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  code: z
    .string()
    .describe(
      "A JavaScript snippet run as an async function body with the Playwright `page` in scope, e.g. 'return await page.title();'.",
    ),
};

type Args = { code: string };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    if (!ctx.allowUnsafeCode) {
      return textResult(
        "browser_run_code_unsafe is disabled. Set LAYA_ALLOW_UNSAFE_CODE=true to enable running raw Playwright code against the page.",
        true,
      );
    }
    try {
      const result = await ctx.session.runCode(args.code);
      const rendered = result === undefined ? "undefined" : JSON.stringify(result);
      return textResult(rendered);
    } catch (err) {
      return textResult(`Failed to run code: ${(err as Error).message}`, true);
    }
  };
}

export const definition = {
  name: "browser_run_code_unsafe",
  description:
    "DANGEROUS: run a raw Playwright JavaScript snippet (async function body with `page` in scope) against the active page and return its JSON result. Disabled unless LAYA_ALLOW_UNSAFE_CODE=true.",
  inputSchema,
};
