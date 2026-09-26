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

/** Interpret a string value as a boolean for checkbox/radio fields. */
function asChecked(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "checked" || v === "on" || v === "1" || v === "yes";
}

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
        const kind = field.type ?? "textbox";
        switch (kind) {
          case "checkbox":
          case "radio":
            await locator.setChecked(asChecked(field.value));
            break;
          case "combobox":
            // Try matching by label first, then fall back to value, like browser_select_option.
            await locator
              .selectOption({ label: field.value })
              .catch(async () => {
                await locator.selectOption(field.value);
              });
            break;
          case "slider":
          case "textbox":
          default:
            await locator.fill(field.value);
            break;
        }
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
