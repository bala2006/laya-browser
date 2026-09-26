/**
 * Registers the eight Assist-mode tools on an {@link McpServer}, wired to a shared
 * {@link ToolContext}. This is the single place that knows the full Assist toolset, so
 * `server.ts` and tests can register everything with one call.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./shared.js";

import * as navigate from "./navigate.js";
import * as snapshot from "./snapshot.js";
import * as click from "./click.js";
import * as type from "./type.js";
import * as selectOption from "./select_option.js";
import * as pressKey from "./press_key.js";
import * as waitFor from "./wait_for.js";
import * as close from "./close.js";

/** The names of all Assist-mode tools, in registration order. */
export const ASSIST_TOOL_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_press_key",
  "browser_wait_for",
  "browser_close",
] as const;

/** Register every Assist-mode tool on the given server. */
export function registerAssistTools(server: McpServer, ctx: ToolContext): void {
  const modules = [
    navigate,
    snapshot,
    click,
    type,
    selectOption,
    pressKey,
    waitFor,
    close,
  ];

  for (const mod of modules) {
    server.registerTool(
      mod.definition.name,
      {
        description: mod.definition.description,
        inputSchema: mod.definition.inputSchema,
      },
      // Handlers accept the validated args object; zero-arg tools ignore it.
      mod.makeHandler(ctx) as never,
    );
  }
}
