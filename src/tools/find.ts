/** `browser_find` — search the current snapshot for controls matching text or a regexp. */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";
import { capture } from "../snapshot.js";
import type { Control } from "../types.js";

export const inputSchema = {
  text: z
    .string()
    .optional()
    .describe("Case-insensitive substring to match against a control's name/value/role."),
  regexp: z
    .string()
    .optional()
    .describe("A JavaScript regular expression source to match against a control's name/value/role."),
};

type Args = { text?: string; regexp?: string };

/** Whether a control matches the given predicate on its searchable fields. */
function controlMatches(control: Control, predicate: (haystack: string) => boolean): boolean {
  const fields = [control.name, control.value ?? "", control.role];
  return fields.some((f) => f.length > 0 && predicate(f));
}

/** Render a matching control as a compact line the client can act on. */
function describe(control: Control): string {
  const parts = [`- ${control.role} ${JSON.stringify(control.name)} [ref=${control.ref}]`];
  if (control.value) parts.push(`(value=${JSON.stringify(control.value)})`);
  return parts.join(" ");
}

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    if (!args.text && !args.regexp) {
      return textResult("browser_find requires either `text` or `regexp`.", true);
    }

    let predicate: (haystack: string) => boolean;
    if (args.regexp) {
      let re: RegExp;
      try {
        re = new RegExp(args.regexp, "i");
      } catch (err) {
        return textResult(`Invalid regexp: ${(err as Error).message}`, true);
      }
      predicate = (haystack) => re.test(haystack);
    } else {
      const needle = args.text!.toLowerCase();
      predicate = (haystack) => haystack.toLowerCase().includes(needle);
    }

    // Search the SNAPSHOT (reusing capture()'s Control[]), not a fresh DOM walk of our own.
    const page = await ctx.session.getPage();
    const snap = await capture(page);
    const matches = snap.controls.filter((c) => controlMatches(c, predicate));

    const lines: string[] = [];
    if (matches.length > 0) {
      lines.push(`Found ${matches.length} matching control(s):`);
      for (const c of matches) lines.push(describe(c));
    } else {
      lines.push("No matching controls found.");
    }

    // Also note whether the query appears in the page's visible text, so the caller knows
    // the text exists even when it is not tied to an interactive control.
    if (predicate(snap.visibleText)) {
      lines.push("");
      lines.push("(the query also appears in the page's visible text)");
    }

    return textResult(lines.join("\n"), matches.length === 0);
  };
}

export const definition = {
  name: "browser_find",
  description:
    "Search the current page snapshot for controls whose name/value/role matches a text substring or a regexp, returning each match's ref (eN).",
  inputSchema,
};
