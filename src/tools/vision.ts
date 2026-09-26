/**
 * VISION capability tools (capability: `vision`): coordinate-based mouse primitives.
 *
 * Unlike the ref-based tools, these address the page by absolute pixel coordinates, which
 * is what a vision-driven client (one that reasons over a screenshot) needs. Each tool is a
 * thin wrapper over the raw mouse boundary in {@link ../browser.BrowserSession}. Mutating
 * tools return a fresh snapshot so the client sees the resulting page state.
 */
import { z } from "zod";
import type { ToolModule } from "./registry.js";
import { snapshotResult, textResult, type ToolContext, type ToolResult } from "./shared.js";

const buttonSchema = z
  .enum(["left", "right", "middle"])
  .optional()
  .describe("Mouse button to use. Defaults to left.");

// --- browser_mouse_move_xy ---

export const moveInputSchema = {
  x: z.number().describe("Absolute X coordinate in CSS pixels."),
  y: z.number().describe("Absolute Y coordinate in CSS pixels."),
};

type MoveArgs = { x: number; y: number };

export function makeMoveHandler(ctx: ToolContext) {
  return async (args: MoveArgs): Promise<ToolResult> => {
    try {
      await ctx.session.mouseMove(args.x, args.y);
      return textResult(`Moved mouse to (${args.x}, ${args.y}).`);
    } catch (err) {
      return textResult(`Failed to move mouse: ${(err as Error).message}`, true);
    }
  };
}

export const moveDefinition = {
  name: "browser_mouse_move_xy",
  description: "Move the mouse to absolute page coordinates (x, y).",
  inputSchema: moveInputSchema,
};

// --- browser_mouse_click_xy ---

export const clickInputSchema = {
  x: z.number().describe("Absolute X coordinate in CSS pixels."),
  y: z.number().describe("Absolute Y coordinate in CSS pixels."),
  button: buttonSchema,
};

type ClickArgs = { x: number; y: number; button?: "left" | "right" | "middle" };

export function makeClickHandler(ctx: ToolContext) {
  return async (args: ClickArgs): Promise<ToolResult> => {
    try {
      await ctx.session.mouseClick(args.x, args.y, args.button ?? "left");
    } catch (err) {
      return textResult(`Failed to click at (${args.x}, ${args.y}): ${(err as Error).message}`, true);
    }
    return snapshotResult(ctx, `Clicked at (${args.x}, ${args.y})`);
  };
}

export const clickDefinition = {
  name: "browser_mouse_click_xy",
  description: "Move to absolute coordinates (x, y) and click. Returns a fresh page snapshot.",
  inputSchema: clickInputSchema,
};

// --- browser_mouse_drag_xy ---

export const dragInputSchema = {
  startX: z.number().describe("Absolute start X coordinate."),
  startY: z.number().describe("Absolute start Y coordinate."),
  endX: z.number().describe("Absolute end X coordinate."),
  endY: z.number().describe("Absolute end Y coordinate."),
};

type DragArgs = { startX: number; startY: number; endX: number; endY: number };

export function makeDragHandler(ctx: ToolContext) {
  return async (args: DragArgs): Promise<ToolResult> => {
    try {
      await ctx.session.mouseDrag(args.startX, args.startY, args.endX, args.endY);
    } catch (err) {
      return textResult(`Failed to drag: ${(err as Error).message}`, true);
    }
    return snapshotResult(
      ctx,
      `Dragged from (${args.startX}, ${args.startY}) to (${args.endX}, ${args.endY})`,
    );
  };
}

export const dragDefinition = {
  name: "browser_mouse_drag_xy",
  description:
    "Drag the mouse from a start coordinate to an end coordinate (down, move, up). Returns a fresh snapshot.",
  inputSchema: dragInputSchema,
};

// --- browser_mouse_down ---

export const downInputSchema = { button: buttonSchema };

type ButtonArgs = { button?: "left" | "right" | "middle" };

export function makeDownHandler(ctx: ToolContext) {
  return async (args: ButtonArgs): Promise<ToolResult> => {
    try {
      await ctx.session.mouseDown(args.button ?? "left");
      return textResult(`Pressed ${args.button ?? "left"} mouse button.`);
    } catch (err) {
      return textResult(`Failed to press mouse button: ${(err as Error).message}`, true);
    }
  };
}

export const downDefinition = {
  name: "browser_mouse_down",
  description: "Press and hold a mouse button at the current cursor position.",
  inputSchema: downInputSchema,
};

// --- browser_mouse_up ---

export const upInputSchema = { button: buttonSchema };

export function makeUpHandler(ctx: ToolContext) {
  return async (args: ButtonArgs): Promise<ToolResult> => {
    try {
      await ctx.session.mouseUp(args.button ?? "left");
      return textResult(`Released ${args.button ?? "left"} mouse button.`);
    } catch (err) {
      return textResult(`Failed to release mouse button: ${(err as Error).message}`, true);
    }
  };
}

export const upDefinition = {
  name: "browser_mouse_up",
  description: "Release a mouse button at the current cursor position.",
  inputSchema: upInputSchema,
};

// --- browser_mouse_wheel ---

export const wheelInputSchema = {
  deltaX: z.number().optional().describe("Horizontal scroll delta in pixels. Defaults to 0."),
  deltaY: z.number().optional().describe("Vertical scroll delta in pixels. Defaults to 0."),
};

type WheelArgs = { deltaX?: number; deltaY?: number };

export function makeWheelHandler(ctx: ToolContext) {
  return async (args: WheelArgs): Promise<ToolResult> => {
    try {
      await ctx.session.mouseWheel(args.deltaX ?? 0, args.deltaY ?? 0);
      return textResult(`Scrolled by (${args.deltaX ?? 0}, ${args.deltaY ?? 0}).`);
    } catch (err) {
      return textResult(`Failed to scroll: ${(err as Error).message}`, true);
    }
  };
}

export const wheelDefinition = {
  name: "browser_mouse_wheel",
  description: "Scroll the page by a wheel delta (deltaX, deltaY).",
  inputSchema: wheelInputSchema,
};

// --- Registry modules ---

export const moveModule: ToolModule = {
  definition: moveDefinition,
  inputSchema: moveInputSchema,
  makeHandler: makeMoveHandler as ToolModule["makeHandler"],
};

export const clickModule: ToolModule = {
  definition: clickDefinition,
  inputSchema: clickInputSchema,
  makeHandler: makeClickHandler as ToolModule["makeHandler"],
};

export const dragModule: ToolModule = {
  definition: dragDefinition,
  inputSchema: dragInputSchema,
  makeHandler: makeDragHandler as ToolModule["makeHandler"],
};

export const downModule: ToolModule = {
  definition: downDefinition,
  inputSchema: downInputSchema,
  makeHandler: makeDownHandler as ToolModule["makeHandler"],
};

export const upModule: ToolModule = {
  definition: upDefinition,
  inputSchema: upInputSchema,
  makeHandler: makeUpHandler as ToolModule["makeHandler"],
};

export const wheelModule: ToolModule = {
  definition: wheelDefinition,
  inputSchema: wheelInputSchema,
  makeHandler: makeWheelHandler as ToolModule["makeHandler"],
};
