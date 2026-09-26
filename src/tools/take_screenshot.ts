/** `browser_take_screenshot` — capture the page or an element as an image. */
import { z } from "zod";
import {
  elementDescription,
  imageResult,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

export const inputSchema = {
  type: z
    .enum(["png", "jpeg", "webp"])
    .optional()
    .describe("Image format for the screenshot. Defaults to png."),
  fullPage: z
    .boolean()
    .optional()
    .describe("Capture the full scrollable page instead of just the viewport (ignored for element shots)."),
  element: elementDescription,
  target: targetSchema
    .optional()
    .describe("Optional element ref (eN) or selector to screenshot instead of the page."),
  filename: z
    .string()
    .optional()
    .describe("Optional file name hint for the client to save the image under."),
};

type ScreenshotType = "png" | "jpeg" | "webp";
type Args = {
  type?: ScreenshotType;
  fullPage?: boolean;
  element?: string;
  target?: string;
  filename?: string;
};

const MIME: Record<ScreenshotType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    const type: ScreenshotType = args.type ?? "png";
    try {
      // Ensure the page exists before resolving the ref: resolveRef() is sync and throws
      // when the browser is still launching.
      const page = await ctx.session.getPage();
      let buffer: Buffer;
      if (args.target) {
        const locator = ctx.session.resolveRef(args.target);
        buffer = await locator.screenshot({ type });
      } else {
        buffer = await page.screenshot({ type, fullPage: args.fullPage ?? false });
      }
      return imageResult(buffer.toString("base64"), MIME[type]);
    } catch (err) {
      return textResult(`Failed to take screenshot: ${(err as Error).message}`, true);
    }
  };
}

export const definition = {
  name: "browser_take_screenshot",
  description:
    "Capture a screenshot of the page (or a single element via a ref/selector) as a PNG, JPEG, or WebP image content block.",
  inputSchema,
};
