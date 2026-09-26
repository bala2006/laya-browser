/**
 * Shared field-fill logic reused by the `browser_fill_form` tool AND the Autopilot loop's
 * FILL_FORM batch operation.
 *
 * Factored out so the deterministic Autopilot batch fill and the Assist-mode tool apply
 * fields identically (a checkbox/radio/combobox/textbox is set the same way in both), keeping
 * the "faster" single-batch path consistent with the manual tool. This module is a thin
 * wrapper over a Playwright {@link Locator}; the IO stays at the caller's boundary.
 */
import type { Locator } from "playwright";

/** The kind of field, controlling how a string `value` is applied. */
export type FieldKind = "textbox" | "checkbox" | "radio" | "combobox" | "slider";

/** Interpret a string value as a boolean for checkbox/radio fields. */
export function asChecked(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "checked" || v === "on" || v === "1" || v === "yes";
}

/**
 * Apply a single field's value to its already-resolved locator, dispatching on the field
 * kind. `combobox` matches by option label first, then falls back to value (like
 * `browser_select_option`). `textbox`/`slider` and any unknown kind fill the value directly.
 */
export async function applyFieldValue(
  locator: Locator,
  value: string,
  kind: FieldKind = "textbox",
): Promise<void> {
  switch (kind) {
    case "checkbox":
    case "radio":
      await locator.setChecked(asChecked(value));
      break;
    case "combobox":
      await locator.selectOption({ label: value }).catch(async () => {
        await locator.selectOption(value);
      });
      break;
    case "slider":
    case "textbox":
    default:
      await locator.fill(value);
      break;
  }
}
