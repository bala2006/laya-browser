/** `browser_network_request` — return one captured network request in full detail. */
import { z } from "zod";
import { textResult, type ToolContext, type ToolResult } from "./shared.js";
import type { NetworkRequestRecord } from "../types.js";

export const inputSchema = {
  index: z
    .number()
    .int()
    .optional()
    .describe("0-based index of the request in the captured list (from browser_network_requests)."),
  url: z
    .string()
    .optional()
    .describe("Select the most recent captured request whose URL contains this substring."),
};

type Args = { index?: number; url?: string };

/** Render a single record's full detail as readable text. */
function renderDetail(r: NetworkRequestRecord): string {
  const lines: string[] = [
    `${r.method} ${r.url}`,
    `resourceType: ${r.resourceType ?? "(unknown)"}`,
    `status: ${r.status !== undefined ? `${r.status} ${r.statusText ?? ""}`.trim() : "(pending)"}`,
  ];
  if (r.failure) lines.push(`failure: ${r.failure}`);
  if (r.requestHeaders) {
    lines.push("requestHeaders:");
    for (const [k, v] of Object.entries(r.requestHeaders)) lines.push(`  ${k}: ${v}`);
  }
  if (r.responseHeaders) {
    lines.push("responseHeaders:");
    for (const [k, v] of Object.entries(r.responseHeaders)) lines.push(`  ${k}: ${v}`);
  }
  return lines.join("\n");
}

export function makeHandler(ctx: ToolContext) {
  return async (args: Args): Promise<ToolResult> => {
    const requests = ctx.session.getNetworkRequests();
    if (requests.length === 0) {
      return textResult("No network requests captured.", true);
    }
    let record: NetworkRequestRecord | undefined;
    if (args.index !== undefined) {
      record = requests[args.index];
      if (!record) {
        return textResult(
          `No request at index ${args.index}; captured 0..${requests.length - 1}.`,
          true,
        );
      }
    } else if (args.url !== undefined) {
      // Prefer the most recent match so a repeated URL returns the latest attempt.
      for (let i = requests.length - 1; i >= 0; i--) {
        if (requests[i]!.url.includes(args.url)) {
          record = requests[i];
          break;
        }
      }
      if (!record) {
        return textResult(`No captured request URL contains ${JSON.stringify(args.url)}.`, true);
      }
    } else {
      return textResult("browser_network_request requires either `index` or `url`.", true);
    }
    return textResult(renderDetail(record));
  };
}

export const definition = {
  name: "browser_network_request",
  description:
    "Return the full detail (method, URL, resource type, status, headers) of one captured network request, selected by `index` or by a `url` substring.",
  inputSchema,
};
