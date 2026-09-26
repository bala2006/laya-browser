/** `browser_console_messages` — return the console messages captured this session. */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  onlyErrors: z
    .boolean()
    .optional()
    .describe("When true, return only error-level messages."),
};

type Args = { onlyErrors?: boolean };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    let messages = ctx.session.getConsoleMessages();
    if (args.onlyErrors) {
      messages = messages.filter((m) => m.type === "error");
    }
    if (messages.length === 0) {
      return textResult("No console messages captured.");
    }
    const lines = messages.map((m) => {
      const loc = m.location?.url
        ? ` (${m.location.url}${m.location.lineNumber !== undefined ? `:${m.location.lineNumber}` : ""})`
        : "";
      return `[${m.type}] ${m.text}${loc}`;
    });
    return textResult(`Console messages (${messages.length}):\n${lines.join("\n")}`);
  };
}

export const definition = {
  name: "browser_console_messages",
  description:
    "Return the console messages (and uncaught page errors) captured since the session started; optionally filter to errors only.",
  inputSchema,
};
