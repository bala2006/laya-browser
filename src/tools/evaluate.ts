/** `browser_evaluate` — run a JS function on the page or on a resolved element. */
import { z } from "zod";
import {
  elementDescription,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

export const inputSchema = {
  function: z
    .string()
    .describe(
      "A JavaScript function to evaluate, e.g. '() => document.title' or, when a target is given, '(element) => element.textContent'.",
    ),
  element: elementDescription,
  target: targetSchema.optional().describe("Optional ref (eN) or selector to evaluate against."),
};

type Args = { function: string; element?: string; target?: string };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      const page = await ctx.session.getPage();
      let result: unknown;
      if (args.target) {
        const locator = ctx.session.resolveRef(args.target);
        // Playwright treats a bare string as an expression to evaluate, not a function to
        // call, so it would never pass the element in. Compile the caller's function inside
        // the page and invoke it with the element as its argument.
        result = await locator.evaluate((el, fnSource) => {
          // eslint-disable-next-line no-eval
          const fn = (0, eval)(`(${fnSource})`) as (arg: unknown) => unknown;
          return fn(el);
        }, args.function);
      } else {
        // Wrap as an immediately-invoked expression so the caller's function actually runs
        // (a bare '() => ...' string would otherwise evaluate to an uncalled function).
        result = await page.evaluate(`(${args.function})()`);
      }
      // undefined is not valid JSON; render it explicitly so callers see a real value.
      const rendered = result === undefined ? "undefined" : JSON.stringify(result);
      return textResult(rendered);
    } catch (err) {
      return textResult(`Failed to evaluate: ${(err as Error).message}`, true);
    }
  };
}

export const definition = {
  name: "browser_evaluate",
  description:
    "Evaluate a JavaScript function on the page, or on an element (ref eN or selector), and return the JSON result.",
  inputSchema,
};
