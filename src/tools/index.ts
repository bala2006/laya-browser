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
import * as navigateBack from "./navigate_back.js";
import * as resize from "./resize.js";
import * as snapshot from "./snapshot.js";
import * as click from "./click.js";
import * as type from "./type.js";
import * as hover from "./hover.js";
import * as find from "./find.js";
import * as drag from "./drag.js";
import * as drop from "./drop.js";
import * as fillForm from "./fill_form.js";
import * as evaluate from "./evaluate.js";
import * as selectOption from "./select_option.js";
import * as pressKey from "./press_key.js";
import * as waitFor from "./wait_for.js";
import * as close from "./close.js";
import * as tabs from "./tabs.js";
import * as handleDialog from "./handle_dialog.js";
import * as fileUpload from "./file_upload.js";
import * as takeScreenshot from "./take_screenshot.js";
import * as consoleMessages from "./console_messages.js";
import * as networkRequests from "./network_requests.js";
import * as networkRequest from "./network_request.js";
import * as runCodeUnsafe from "./run_code_unsafe.js";
import * as cookies from "./cookies.js";
import * as localStorageTools from "./localstorage.js";
import * as sessionStorageTools from "./sessionstorage.js";
import * as storageState from "./storage_state.js";
import * as route from "./route.js";
import * as testing from "./testing.js";
import * as pdf from "./pdf.js";
import * as vision from "./vision.js";
import * as getConfig from "./get_config.js";
import * as devtools from "./devtools.js";

/**
 * The full Assist toolset as a capability-gating table. Every entry today is CORE
 * (no `capability`), so the default core-only configuration registers all of them.
 * Later feature groups add entries tagged with a capability.
 */
export const REGISTRY: readonly RegisteredTool[] = [
  { module: navigate as unknown as ToolModule },
  { module: navigateBack as unknown as ToolModule },
  { module: resize as unknown as ToolModule },
  { module: snapshot as unknown as ToolModule },
  { module: click as unknown as ToolModule },
  { module: type as unknown as ToolModule },
  { module: hover as unknown as ToolModule },
  { module: find as unknown as ToolModule },
  { module: drag as unknown as ToolModule },
  { module: drop as unknown as ToolModule },
  { module: fillForm as unknown as ToolModule },
  { module: evaluate as unknown as ToolModule },
  { module: selectOption as unknown as ToolModule },
  { module: pressKey as unknown as ToolModule },
  { module: waitFor as unknown as ToolModule },
  { module: close as unknown as ToolModule },
  { module: tabs as unknown as ToolModule },
  { module: handleDialog as unknown as ToolModule },
  { module: fileUpload as unknown as ToolModule },
  { module: takeScreenshot as unknown as ToolModule },
  { module: consoleMessages as unknown as ToolModule },
  { module: networkRequests as unknown as ToolModule },
  { module: networkRequest as unknown as ToolModule },
  // Always listed (CORE) but refuses at call time unless allowUnsafeCode is set.
  { module: runCodeUnsafe as unknown as ToolModule },

  // STORAGE capability group: cookies, localStorage, sessionStorage, storage state.
  { module: cookies.listModule, capability: "storage" },
  { module: cookies.getModule, capability: "storage" },
  { module: cookies.setModule, capability: "storage" },
  { module: cookies.deleteModule, capability: "storage" },
  { module: cookies.clearModule, capability: "storage" },
  { module: localStorageTools.list, capability: "storage" },
  { module: localStorageTools.get, capability: "storage" },
  { module: localStorageTools.set, capability: "storage" },
  { module: localStorageTools.del, capability: "storage" },
  { module: localStorageTools.clear, capability: "storage" },
  { module: sessionStorageTools.list, capability: "storage" },
  { module: sessionStorageTools.get, capability: "storage" },
  { module: sessionStorageTools.set, capability: "storage" },
  { module: sessionStorageTools.del, capability: "storage" },
  { module: sessionStorageTools.clear, capability: "storage" },
  { module: storageState.saveModule, capability: "storage" },
  { module: storageState.restoreModule, capability: "storage" },

  // NETWORK capability group: route mocking + connectivity toggle.
  { module: route.routeModule, capability: "network" },
  { module: route.listModule, capability: "network" },
  { module: route.unrouteModule, capability: "network" },
  { module: route.networkStateModule, capability: "network" },

  // TESTING capability group: locator generation + verify_* assertions.
  { module: testing.generateLocatorModule, capability: "testing" },
  { module: testing.verifyElementVisibleModule, capability: "testing" },
  { module: testing.verifyTextVisibleModule, capability: "testing" },
  { module: testing.verifyListVisibleModule, capability: "testing" },
  { module: testing.verifyValueModule, capability: "testing" },

  // PDF capability group: save the page as a PDF (Chromium-only).
  { module: pdf as unknown as ToolModule, capability: "pdf" },

  // VISION capability group: coordinate-based mouse primitives.
  { module: vision.moveModule, capability: "vision" },
  { module: vision.clickModule, capability: "vision" },
  { module: vision.dragModule, capability: "vision" },
  { module: vision.downModule, capability: "vision" },
  { module: vision.upModule, capability: "vision" },
  { module: vision.wheelModule, capability: "vision" },

  // CONFIG capability group: report the resolved configuration.
  { module: getConfig as unknown as ToolModule, capability: "config" },

  // DEVTOOLS capability group: real tracing + highlight, honest no-ops for codegen/video.
  { module: devtools.startTracingModule, capability: "devtools" },
  { module: devtools.stopTracingModule, capability: "devtools" },
  { module: devtools.highlightModule, capability: "devtools" },
  { module: devtools.hideHighlightModule, capability: "devtools" },
  { module: devtools.startVideoModule, capability: "devtools" },
  { module: devtools.stopVideoModule, capability: "devtools" },
  { module: devtools.videoChapterModule, capability: "devtools" },
  { module: devtools.videoShowActionsModule, capability: "devtools" },
  { module: devtools.videoHideActionsModule, capability: "devtools" },
  { module: devtools.startRecordingModule, capability: "devtools" },
  { module: devtools.stopRecordingModule, capability: "devtools" },
  { module: devtools.annotateModule, capability: "devtools" },
  { module: devtools.resumeModule, capability: "devtools" },
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
