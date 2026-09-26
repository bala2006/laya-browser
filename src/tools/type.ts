/** `browser_type` — type text into an editable element, optionally submitting. */
import { z } from "zod";
import {
  elementDescription,
  snapshotResult,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

export const inputSchema = {
  element: elementDescription,
  target: targetSchema,
  text: z.string().describe("The text to type into the element."),
  submit: z.boolean().optional().describe("Whether to press Enter after typing."),
  slowly: z
    .boolean()
    .optional()
    .describe("Type one character at a time (fires key events) instead of filling at once."),
};

type Args = {
  element?: string;
  target: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
};

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      // Ensure the page exists before resolving the ref: resolveRef() is sync and throws
      // when the browser is still launching (e.g. a pipelined navigate+type). getPage() is
      // idempotent and serialises concurrent launches, matching the other tools' pattern.
      await ctx.session.getPage();
      const locator = ctx.session.resolveRef(args.target);
      if (args.slowly) {
        await locator.click();
        await locator.pressSequentially(args.text);
      } else {
        await locator.fill(args.text);
      }
      if (args.submit) {
        await locator.press("Enter");
      }
    } catch (err) {
      return textResult(`Failed to type into ${args.target}: ${(err as Error).message}`, true);
    }
    const label = args.element ?? args.target;
    return snapshotResult(ctx, `Typed ${JSON.stringify(args.text)} into ${label}`);
  };
}

export const definition = {
  name: "browser_type",
  description: "Type text into an editable element identified by a snapshot ref (eN) or selector.",
  inputSchema,
};
