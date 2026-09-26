/**
 * `browser_get_config` (capability: `config`) — return the resolved, effective
 * configuration as JSON.
 *
 * The handler reads the typed {@link LayaBrowserConfig} threaded onto the {@link ToolContext}
 * (parsed once in src/config.ts). It does NOT re-read the environment, honouring the
 * single-parse boundary. When no config is present on the context (e.g. a bare test
 * context), it reports that explicitly rather than fabricating defaults.
 */
import { textResult, type ToolContext, type ToolResult } from "./shared.js";

export const inputSchema = {};

export function makeHandler(ctx: ToolContext) {
  return async (): Promise<ToolResult> => {
    if (!ctx.config) {
      return textResult("No resolved configuration is available on this server.", true);
    }
    return textResult(JSON.stringify(ctx.config, null, 2));
  };
}

export const definition = {
  name: "browser_get_config",
  description:
    "Return the resolved laya-browser configuration (capabilities, browserEngine, headless, viewport, thresholds, allow-list) as JSON.",
  inputSchema,
};
