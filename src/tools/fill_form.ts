/** `browser_fill_form` — fill multiple form fields in one call, then return one snapshot. */
import { z } from "zod";
import {
  elementDescription,
  snapshotResult,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";
import { applyFieldValue } from "./fill.js";

const fieldSchema = z.object({
  element: elementDescription,
  target: targetSchema,
  value: z
    .string()
    .describe(
      "The value to set. For a checkbox/radio pass 'true'/'false' (or 'checked'/'unchecked'); for a combobox the option label or value; for a slider the numeric value as a string.",
    ),
  type: z
    .enum(["textbox", "checkbox", "radio", "combobox", "slider"])
    .optional()
    .describe("The kind of field, controlling how `value` is applied. Defaults to 'textbox'."),
});

export const inputSchema = {
  fields: z.array(fieldSchema).min(1).describe("The fields to fill, applied in order in a single call."),
};

type Field = z.infer<typeof fieldSchema>;
type Args = { fields: Field[] };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    // Ensure the page exists ONCE before resolving any refs: resolveRef() is sync and throws
    // when the browser is still launching. getPage() is idempotent and serialises concurrent
    // launches, matching the other ref-based tools' pattern.
    await ctx.session.getPage();
    for (const field of args.fields) {
      const label = field.element ?? field.target;
      try {
        const locator = ctx.session.resolveRef(field.target);
        // Reuse the shared field-fill logic so the tool and the Autopilot batch fill match.
        await applyFieldValue(locator, field.value, field.type ?? "textbox");
      } catch (err) {
        return textResult(`Failed to fill ${label}: ${(err as Error).message}`, true);
      }
    }
    return snapshotResult(ctx, `Filled ${args.fields.length} field(s)`);
  };
}

export const definition = {
  name: "browser_fill_form",
  description:
    "Fill multiple form fields (textbox/checkbox/radio/combobox/slider) in a single call, then return one snapshot.",
  inputSchema,
};
