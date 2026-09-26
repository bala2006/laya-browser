/**
 * The capability-gating registry for Assist-mode tools.
 *
 * Rather than scattering `if (caps.has(...))` conditionals through the registration code,
 * the full toolset is modelled as a table of {@link RegisteredTool} entries. A tool with
 * no `capability` is CORE and always registered; a tool tagged with a capability is
 * registered only when that capability is present in the enabled set. This keeps the
 * gating declarative and lets `ASSIST_TOOL_NAMES` be derived from the same table.
 */
import type { z } from "zod";
import type { Capability } from "../config.js";
import type { ToolContext, ToolResult } from "./shared.js";

/**
 * The uniform shape every Assist tool module exports: a `definition` (name, description,
 * zod raw-shape input schema), a `makeHandler` factory bound to a {@link ToolContext},
 * and the raw `inputSchema` shape itself.
 */
export interface ToolModule {
  definition: {
    name: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
  };
  makeHandler: (ctx: ToolContext) => (args: never) => Promise<ToolResult>;
  inputSchema: Record<string, z.ZodTypeAny>;
}

/**
 * A registry entry: the tool module plus the capability required to enable it. A missing
 * `capability` means the tool is CORE and always registered.
 */
export interface RegisteredTool {
  module: ToolModule;
  capability?: Capability;
}
