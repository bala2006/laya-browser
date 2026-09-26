/** `browser_handle_dialog` — decide how the NEXT JavaScript dialog is handled. */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  accept: z.boolean().describe("Whether to accept (true) or dismiss (false) the next dialog."),
  promptText: z
    .string()
    .optional()
    .describe("Text to enter for a `prompt` dialog when accepting."),
};

type Args = { accept: boolean; promptText?: string };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    // Register the disposition ahead of the action that triggers the dialog: dialogs are
    // fired by a SUBSEQUENT interaction (e.g. a click that calls confirm()), so the caller
    // sets this first and then performs that action.
    ctx.session.setNextDialog({
      accept: args.accept,
      ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
    });
    const verb = args.accept ? "accept" : "dismiss";
    const suffix =
      args.accept && args.promptText !== undefined
        ? ` with prompt text ${JSON.stringify(args.promptText)}`
        : "";
    return textResult(`The next dialog will be handled: ${verb}${suffix}.`);
  };
}

export const definition = {
  name: "browser_handle_dialog",
  description:
    "Register how the NEXT JavaScript dialog (alert/confirm/prompt/beforeunload) is handled: accept or dismiss, with optional prompt text. Call this before the action that triggers the dialog.",
  inputSchema,
};
