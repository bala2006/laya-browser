/** `browser_click` — click an element resolved from a ref or selector. */
import { z } from "zod";
import {
  elementDescription,
  snapshotResult,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";
import { capture } from "../snapshot.js";
import { checkDestructiveSubmit } from "../safety.js";
import type { Control, PageState } from "../types.js";
import { asRef } from "../types.js";

export const inputSchema = {
  element: elementDescription,
  target: targetSchema,
  doubleClick: z.boolean().optional().describe("Whether to perform a double click instead of a single click."),
  button: z
    .enum(["left", "right", "middle"])
    .optional()
    .describe("Mouse button to use for the click. Defaults to left."),
};

type Args = {
  element?: string;
  target: string;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
};

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    // B3 (opt-in, default OFF): when assistDestructiveGuard is on, run the same pure
    // destructive-submit guard the Autopilot uses before this click. We capture a snapshot,
    // build a minimal PageState, resolve the target to a Control, and refuse (no click) when
    // the guard refuses. When the flag is off (default) NONE of this runs and the behaviour
    // below is byte-for-byte unchanged (no snapshot, no guard).
    if (ctx.assistDestructiveGuard) {
      try {
        const page = await ctx.session.getPage();
        const snapshot = await capture(page);
        const state: PageState = {
          goal: "",
          url: snapshot.url,
          title: snapshot.title,
          visibleText: snapshot.visibleText,
          controls: snapshot.controls,
          recentActions: [],
        };
        // Resolve the target to a Control. A snapshot ref (eN) matches directly; a raw
        // selector cannot be mapped to a captured control, so synthesise a minimal control
        // from the human-readable label so the target-name signal is still evaluated
        // (neighbour + password/payment signals still apply from the captured state).
        const target: Control =
          snapshot.controls.find((c) => c.ref === args.target) ??
          ({
            ref: asRef(args.target),
            index: 0,
            role: "button",
            name: args.element ?? args.target,
            tag: "button",
            editable: false,
          } as Control);
        const verdict = checkDestructiveSubmit(target, state, true);
        if (!verdict.allowed) {
          return textResult(
            `Refusing to click ${args.element ?? args.target}: ${
              verdict.reason ?? "the destructive-action guard refused this click."
            }`,
            true,
          );
        }
      } catch (err) {
        return textResult(
          `Failed to evaluate the destructive-action guard for ${args.target}: ${
            (err as Error).message
          }`,
          true,
        );
      }
    }
    try {
      // Ensure the page exists before resolving the ref: resolveRef() is sync and throws
      // when the browser is still launching (e.g. a pipelined navigate+click). getPage() is
      // idempotent and serialises concurrent launches, matching the other tools' pattern.
      await ctx.session.getPage();
      const locator = ctx.session.resolveRef(args.target);
      const options = args.button ? { button: args.button } : {};
      if (args.doubleClick) {
        await locator.dblclick(options);
      } else {
        await locator.click(options);
      }
    } catch (err) {
      return textResult(`Failed to click ${args.target}: ${(err as Error).message}`, true);
    }
    const label = args.element ?? args.target;
    return snapshotResult(ctx, `Clicked ${label}`);
  };
}

export const definition = {
  name: "browser_click",
  description: "Click an element identified by a snapshot ref (eN) or a Playwright selector.",
  inputSchema,
};
