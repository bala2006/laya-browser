/** `browser_drop` — drop files or MIME data onto an element. */
import { z } from "zod";
import {
  elementDescription,
  snapshotResult,
  targetSchema,
  textResult,
  type ToolContext,
  type ToolResult,
} from "./shared.js";

export const inputSchema = {
  element: elementDescription,
  target: targetSchema,
  paths: z
    .array(z.string())
    .optional()
    .describe("Absolute file paths to drop onto the target (e.g. onto a file input)."),
  data: z
    .array(
      z.object({
        mimeType: z.string().describe("The MIME type of this data item, e.g. 'text/plain'."),
        base64: z.string().describe("The item's contents, base64-encoded."),
      }),
    )
    .optional()
    .describe("MIME data items to drop onto the target via a synthetic drop event."),
};

type DataItem = { mimeType: string; base64: string };
type Args = { element?: string; target: string; paths?: string[]; data?: DataItem[] };

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    if (!args.paths?.length && !args.data?.length) {
      return textResult("browser_drop requires either `paths` or `data`.", true);
    }
    let label = args.element ?? args.target;
    try {
      // Ensure the page exists before resolving the ref: resolveRef() is sync and throws
      // when the browser is still launching. getPage() is idempotent and serialises
      // concurrent launches, matching the other ref-based tools' pattern.
      const page = await ctx.session.getPage();
      const locator = ctx.session.resolveRef(args.target);

      if (args.paths?.length) {
        // A file input accepts paths directly; this is the robust, real path for uploads.
        await locator.setInputFiles(args.paths);
        label = `${label} (${args.paths.length} file(s))`;
      }

      if (args.data?.length) {
        // Decode the MIME items on the Node side, then build a DataTransfer inside the page
        // and dispatch a drop event carrying it. Keeping the decode here avoids relying on
        // atob() in the page context and keeps the payload explicit.
        const items = args.data.map((d) => ({
          mimeType: d.mimeType,
          text: Buffer.from(d.base64, "base64").toString("utf8"),
        }));
        await locator.evaluate((el, payload) => {
          const dt = new DataTransfer();
          for (const item of payload) {
            dt.setData(item.mimeType, item.text);
          }
          const event = new DragEvent("drop", { bubbles: true, cancelable: true });
          // dataTransfer is read-only on the constructed event, so define it explicitly.
          Object.defineProperty(event, "dataTransfer", { value: dt });
          el.dispatchEvent(event);
        }, items);
        label = `${label} (${args.data.length} data item(s))`;
      }
    } catch (err) {
      return textResult(`Failed to drop onto ${args.target}: ${(err as Error).message}`, true);
    }
    return snapshotResult(ctx, `Dropped onto ${label}`);
  };
}

export const definition = {
  name: "browser_drop",
  description:
    "Drop files (via `paths`) or MIME data (via `data`) onto an element identified by a ref (eN) or selector.",
  inputSchema,
};
