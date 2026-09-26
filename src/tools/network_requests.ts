/** `browser_network_requests` — list the network requests captured this session. */
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {};

export function makeHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    const requests = ctx.session.getNetworkRequests();
    if (requests.length === 0) {
      return textResult("No network requests captured.");
    }
    const lines = requests.map((r, i) => {
      const status = r.status !== undefined ? String(r.status) : r.failure ? "FAILED" : "pending";
      return `[${i}] ${r.method} ${status} ${r.url}`;
    });
    return textResult(`Network requests (${requests.length}):\n${lines.join("\n")}`);
  };
}

export const definition = {
  name: "browser_network_requests",
  description:
    "List the network requests captured since the session started, one per line (index, method, status, URL).",
  inputSchema,
};
