/**
 * TESTING capability tools (capability: `testing`): locator generation and a family of
 * verify_* assertions. Each tool acts on the shared session; the verify_* tools return a
 * clear PASS/FAIL text result (an isError:true result on FAIL), so a client sees a literal
 * outcome that mirrors Playwright's expect assertions.
 *
 * Each tool is its own definition/handler registered separately, but they share this module
 * because they all belong to the same testing surface.
 */
import { z } from "zod";
import type { ToolModule } from "./registry.js";
import {
  elementDescription,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";
import { capture } from "../snapshot.js";

/** A snapshot ref looks like `e` followed by one or more digits. */
const REF_PATTERN = /^e\d+$/;

/**
 * Synthesize a stable Playwright locator string for the element addressed by `target`.
 *
 * When `target` is a snapshot ref (`eN`), we look it up in a fresh snapshot and prefer a
 * role+name locator (`getByRole('button', { name: 'Sign in' })`), falling back to a text
 * locator, and finally to the underlying `data-laya-ref` selector. When `target` is already
 * a raw selector we echo it back as a `locator(...)` call. The returned string is a real,
 * usable Playwright expression that resolves the same element.
 */
async function locatorFor(ctx: ToolContext, target: string): Promise<string> {
  const trimmed = target.trim();
  if (!REF_PATTERN.test(trimmed)) {
    // A raw selector: express it as a locator() call verbatim.
    return `page.locator(${JSON.stringify(trimmed)})`;
  }
  const page = await ctx.session.getPage();
  const snap = await capture(page);
  const control = snap.controls.find((c) => c.ref === trimmed);
  if (control && control.name) {
    return `page.getByRole(${JSON.stringify(control.role)}, { name: ${JSON.stringify(
      control.name,
    )} })`;
  }
  if (control && control.value) {
    return `page.getByText(${JSON.stringify(control.value)})`;
  }
  // Stable fallback: the data-laya-ref attribute the snapshot stamps.
  return `page.locator(${JSON.stringify(`[data-laya-ref="${trimmed}"]`)})`;
}

// --- browser_generate_locator ---

export const generateLocatorInputSchema = {
  element: elementDescription,
  target: targetSchema,
};

type GenerateLocatorArgs = { element?: string; target: string };

export function makeGenerateLocatorHandler(ctx: ToolContext) {
  return async (args: GenerateLocatorArgs): Promise<ToolResult> => {
    try {
      await ctx.session.getPage();
      const locator = await locatorFor(ctx, args.target);
      return textResult(locator);
    } catch (err) {
      return textResult(`Failed to generate locator: ${(err as Error).message}`, true);
    }
  };
}

export const generateLocatorDefinition = {
  name: "browser_generate_locator",
  description:
    "Generate a stable Playwright locator expression (getByRole/getByText/locator) for the element identified by a snapshot ref (eN) or a selector.",
  inputSchema: generateLocatorInputSchema,
};

// --- browser_verify_element_visible ---

export const verifyElementVisibleInputSchema = {
  element: elementDescription,
  target: targetSchema,
};

type VerifyElementVisibleArgs = { element?: string; target: string };

export function makeVerifyElementVisibleHandler(ctx: ToolContext) {
  return async (args: VerifyElementVisibleArgs): Promise<ToolResult> => {
    try {
      await ctx.session.getPage();
      const locator = ctx.session.resolveRef(args.target);
      const visible = await locator.first().isVisible();
      const label = args.element ?? args.target;
      return visible
        ? textResult(`PASS: element ${label} is visible.`)
        : textResult(`FAIL: element ${label} is not visible.`, true);
    } catch (err) {
      return textResult(
        `FAIL: could not verify visibility of ${args.target}: ${(err as Error).message}`,
        true,
      );
    }
  };
}

export const verifyElementVisibleDefinition = {
  name: "browser_verify_element_visible",
  description:
    "Assert that the element identified by a ref (eN) or selector is visible. Returns PASS or FAIL.",
  inputSchema: verifyElementVisibleInputSchema,
};

// --- browser_verify_text_visible ---

export const verifyTextVisibleInputSchema = {
  text: z.string().describe("The exact text expected to be visible on the page."),
};

type VerifyTextVisibleArgs = { text: string };

export function makeVerifyTextVisibleHandler(ctx: ToolContext) {
  return async (args: VerifyTextVisibleArgs): Promise<ToolResult> => {
    try {
      const page = await ctx.session.getPage();
      const visible = await page.getByText(args.text).first().isVisible();
      return visible
        ? textResult(`PASS: text ${JSON.stringify(args.text)} is visible.`)
        : textResult(`FAIL: text ${JSON.stringify(args.text)} is not visible.`, true);
    } catch (err) {
      return textResult(
        `FAIL: could not verify text ${JSON.stringify(args.text)}: ${(err as Error).message}`,
        true,
      );
    }
  };
}

export const verifyTextVisibleDefinition = {
  name: "browser_verify_text_visible",
  description: "Assert that the given text is visible somewhere on the page. Returns PASS or FAIL.",
  inputSchema: verifyTextVisibleInputSchema,
};

// --- browser_verify_list_visible ---

export const verifyListVisibleInputSchema = {
  element: elementDescription,
  target: targetSchema.describe("Ref (eN) or selector for the list container element."),
  items: z
    .array(z.string())
    .optional()
    .describe("Optional item texts that must each be visible inside the list."),
};

type VerifyListVisibleArgs = { element?: string; target: string; items?: string[] };

export function makeVerifyListVisibleHandler(ctx: ToolContext) {
  return async (args: VerifyListVisibleArgs): Promise<ToolResult> => {
    try {
      const page = await ctx.session.getPage();
      const list = ctx.session.resolveRef(args.target);
      const label = args.element ?? args.target;
      if (!(await list.first().isVisible())) {
        return textResult(`FAIL: list ${label} is not visible.`, true);
      }
      for (const item of args.items ?? []) {
        // Scope the text lookup to inside the list container.
        const inList = list.first().getByText(item);
        if (!(await inList.first().isVisible().catch(() => false))) {
          return textResult(`FAIL: list item ${JSON.stringify(item)} is not visible in ${label}.`, true);
        }
      }
      const count = args.items?.length ?? 0;
      return textResult(
        `PASS: list ${label} is visible${count > 0 ? ` with ${count} expected item(s)` : ""}.`,
      );
    } catch (err) {
      return textResult(
        `FAIL: could not verify list ${args.target}: ${(err as Error).message}`,
        true,
      );
    }
  };
}

export const verifyListVisibleDefinition = {
  name: "browser_verify_list_visible",
  description:
    "Assert that a list container (ref eN or selector) is visible and, optionally, that each expected item text is visible inside it. Returns PASS or FAIL.",
  inputSchema: verifyListVisibleInputSchema,
};

// --- browser_verify_value ---

export const verifyValueInputSchema = {
  element: elementDescription,
  target: targetSchema.describe("Ref (eN) or selector for the field to inspect."),
  value: z.string().describe("The expected value of the field."),
};

type VerifyValueArgs = { element?: string; target: string; value: string };

export function makeVerifyValueHandler(ctx: ToolContext) {
  return async (args: VerifyValueArgs): Promise<ToolResult> => {
    try {
      await ctx.session.getPage();
      const locator = ctx.session.resolveRef(args.target).first();
      const actual = await locator.inputValue();
      const label = args.element ?? args.target;
      return actual === args.value
        ? textResult(`PASS: ${label} value equals ${JSON.stringify(args.value)}.`)
        : textResult(
            `FAIL: ${label} value is ${JSON.stringify(actual)}, expected ${JSON.stringify(
              args.value,
            )}.`,
            true,
          );
    } catch (err) {
      return textResult(
        `FAIL: could not verify value of ${args.target}: ${(err as Error).message}`,
        true,
      );
    }
  };
}

export const verifyValueDefinition = {
  name: "browser_verify_value",
  description:
    "Assert that a form field (ref eN or selector) has an exact value. Returns PASS or FAIL.",
  inputSchema: verifyValueInputSchema,
};

// --- Registry modules ---

export const generateLocatorModule: ToolModule = {
  definition: generateLocatorDefinition,
  inputSchema: generateLocatorInputSchema,
  makeHandler: makeGenerateLocatorHandler as ToolModule["makeHandler"],
};

export const verifyElementVisibleModule: ToolModule = {
  definition: verifyElementVisibleDefinition,
  inputSchema: verifyElementVisibleInputSchema,
  makeHandler: makeVerifyElementVisibleHandler as ToolModule["makeHandler"],
};

export const verifyTextVisibleModule: ToolModule = {
  definition: verifyTextVisibleDefinition,
  inputSchema: verifyTextVisibleInputSchema,
  makeHandler: makeVerifyTextVisibleHandler as ToolModule["makeHandler"],
};

export const verifyListVisibleModule: ToolModule = {
  definition: verifyListVisibleDefinition,
  inputSchema: verifyListVisibleInputSchema,
  makeHandler: makeVerifyListVisibleHandler as ToolModule["makeHandler"],
};

export const verifyValueModule: ToolModule = {
  definition: verifyValueDefinition,
  inputSchema: verifyValueInputSchema,
  makeHandler: makeVerifyValueHandler as ToolModule["makeHandler"],
};
