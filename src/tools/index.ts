/**
 * Registers the Assist-mode tools on an {@link McpServer}, wired to a shared
 * {@link ToolContext}. This is the single place that knows the full Assist toolset.
 *
 * The toolset is modelled as a capability-gating {@link REGISTRY} table: a tool with no
 * `capability` is CORE and always registered, while a tool tagged with a capability is
 * registered only when that capability is in the enabled set handed to
 * {@link registerAssistTools}. Default (empty) capabilities therefore register exactly the
 * core tools, mirroring Playwright MCP.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Capability } from "../config.js";
import type { ToolContext } from "./shared.js";
import type { RegisteredTool, ToolModule } from "./registry.js";

import * as navigate from "./navigate.js";
import * as snapshot from "./snapshot.js";
import * as click from "./click.js";
import * as type from "./type.js";
import * as selectOption from "./select_option.js";
import * as pressKey from "./press_key.js";
import * as waitFor from "./wait_for.js";
import * as close from "./close.js";

/**
 * The full Assist toolset as a capability-gating table. Every entry today is CORE
 * (no `capability`), so the default core-only configuration registers all of them.
 * Later feature groups add entries tagged with a capability.
 */
export const REGISTRY: readonly RegisteredTool[] = [
  { module: navigate as unknown as ToolModule },
  { module: snapshot as unknown as ToolModule },
  { module: click as unknown as ToolModule },
  { module: type as unknown as ToolModule },
  { module: selectOption as unknown as ToolModule },
  { module: pressKey as unknown as ToolModule },
  { module: waitFor as unknown as ToolModule },
  { module: close as unknown as ToolModule },
];

/** Whether a registry entry is enabled given the set of enabled capabilities. */
function isEnabled(entry: RegisteredTool, enabled: ReadonlySet<Capability>): boolean {
  return entry.capability === undefined || enabled.has(entry.capability);
}

/**
 * The names of the Assist-mode tools that register under a given capability set, in
 * registration order. Defaults to core-only (no capabilities enabled).
 */
export function assistToolNames(
  capabilities: readonly Capability[] = [],
): string[] {
  const enabled = new Set(capabilities);
  return REGISTRY.filter((entry) => isEnabled(entry, enabled)).map(
    (entry) => entry.module.definition.name,
  );
}

/** The names of the CORE Assist-mode tools, always registered, in registration order. */
export const ASSIST_TOOL_NAMES = assistToolNames();

/**
 * Register the Assist-mode tools on the given server. CORE tools are always registered;
 * capability-tagged tools are registered only when their capability is in `capabilities`.
 */
export function registerAssistTools(
  server: McpServer,
  ctx: ToolContext,
  capabilities: readonly Capability[] = [],
): void {
  const enabled = new Set(capabilities);

  for (const entry of REGISTRY) {
    if (!isEnabled(entry, enabled)) continue;
    const mod = entry.module;
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
