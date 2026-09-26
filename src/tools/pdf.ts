/**
 * `browser_pdf_save` (capability: `pdf`) — render the current page to a PDF file.
 *
 * Backed by `page.pdf`, which in Playwright is Chromium-only (it drives the DevTools
 * print-to-PDF path). On Firefox/WebKit the underlying call throws, and the tool surfaces
 * that as a clear error rather than pretending to succeed.
 */
import { z } from "zod";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {
  path: z
    .string()
    .optional()
    .describe(
      "Filesystem path to write the PDF to. When omitted, a temporary file is created and its path returned.",
    ),
};

type Args = { path?: string };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    try {
      // Choose an output path up front so the byte count can be reported deterministically.
      let outPath = args.path;
      if (!outPath) {
        const dir = await mkdtemp(join(tmpdir(), "laya-pdf-"));
        outPath = join(dir, "page.pdf");
      }
      const buffer = await ctx.session.pdf(outPath);
      // page.pdf writes the file when given a path, but also ensure it is on disk when the
      // engine returned bytes without honouring the path (defensive; Chromium honours it).
      if (buffer.length > 0) {
        await writeFile(outPath, buffer);
      }
      return textResult(`Saved PDF to ${outPath} (${buffer.length} bytes).`);
    } catch (err) {
      return textResult(
        `Failed to save PDF: ${(err as Error).message} (browser_pdf_save requires Chromium).`,
        true,
      );
    }
  };
}

export const definition = {
  name: "browser_pdf_save",
  description:
    "Save the current page as a PDF file (Chromium-only; uses the print-to-PDF path). Returns the output path and byte size.",
  inputSchema,
};
