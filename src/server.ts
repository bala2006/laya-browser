/**
 * Builds the laya-browser-mcp MCP server: Assist mode + Autopilot.
 *
 * Assist mode is a standalone superset of Playwright MCP: it registers the familiar
 * ref-based browser tools against a shared {@link BrowserSession} and loads NO model
 * weights. Autopilot adds the `laya_run_goal` tool, backed by a {@link LayaDecisionEngine}
 * (real Laya when weights are present, otherwise an unavailable engine that makes the tool
 * degrade gracefully to an Assist-mode hint).
 *
 * The server advertises a `sampling`-capability note in its instructions: the Autopilot
 * loop can escalate low-confidence decisions to the client LLM via MCP sampling, so clients
 * that intend to use Autopilot should support the sampling capability.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserSession, type BrowserSessionOptions } from "./browser.js";
import { registerAssistTools } from "./tools/index.js";
import * as runGoalTool from "./tools/run_goal.js";
import { UnavailableEngine } from "./laya/index.js";
import { samplerFromServer } from "./autopilot/escalation.js";
import { loadConfig, type LayaBrowserConfig } from "./config.js";
import type { LayaDecisionEngine } from "./types.js";

/** Result of {@link createServer}: the server plus the session it drives. */
export interface CreatedServer {
  server: McpServer;
  session: BrowserSession;
  engine: LayaDecisionEngine;
}

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  /** Browser session configuration (headless, viewport, channel). */
  browser?: BrowserSessionOptions;
  /** Inject an existing session (used by tests). Overrides `browser`. */
  session?: BrowserSession;
  /**
   * The decision engine backing Autopilot. Defaults to an {@link UnavailableEngine} so
   * `laya_run_goal` is always registered but degrades gracefully with no weights.
   */
  engine?: LayaDecisionEngine;
  /**
   * The parsed, typed configuration (thresholds, allow-list, guard). Parsed once by the
   * caller and handed inward. Defaults to {@link loadConfig} over the environment.
   */
  config?: LayaBrowserConfig;
}

const INSTRUCTIONS = [
  "laya-browser-mcp — a superset of Playwright MCP with a local Laya on-device decision engine.",
  "Assist mode exposes ref-based browser tools that work standalone with no model weights:",
  "call browser_snapshot (or any navigating/mutating tool, which returns a fresh snapshot)",
  "to obtain stable [ref=eN] element references, then pass a ref (or a Playwright selector) as the",
  "'target' of browser_click / browser_type / browser_select_option.",
  "Autopilot exposes laya_run_goal: give it a natural-language goal and it drives the page with the",
  "local Laya decision engine, returning a transcript, final snapshot, and an independent verification.",
  "If model weights are absent, laya_run_goal returns a message directing you back to the Assist tools.",
  "Note: the Autopilot goal-runner can escalate low-confidence decisions to the client LLM via",
  "MCP sampling, so clients intending to use Autopilot should support the 'sampling' capability.",
].join(" ");

/** Construct the MCP server, register Assist + Autopilot tools, and wire the session. */
export function createServer(options: CreateServerOptions = {}): CreatedServer {
  const config = options.config ?? loadConfig();
  const session = options.session ?? new BrowserSession(options.browser);
  const engine = options.engine ?? new UnavailableEngine();

  const server = new McpServer(
    {
      name: "laya-browser-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  registerAssistTools(server, { session, allowedDomains: config.allowedDomains });

  server.registerTool(
    runGoalTool.definition.name,
    {
      description: runGoalTool.definition.description,
      inputSchema: runGoalTool.definition.inputSchema,
    },
    runGoalTool.makeHandler({
      session,
      engine,
      confidenceThreshold: config.confidenceThreshold,
      allowedDomains: config.allowedDomains,
      destructiveFormGuard: config.destructiveFormGuard,
      // Resolve the sampler lazily at call time: the client's `sampling` capability is only
      // known after it has connected and initialized, which happens after createServer.
      sample: async (prompt) => {
        const sampler = samplerFromServer(server);
        if (!sampler) {
          throw new Error("client does not support MCP sampling");
        }
        return sampler(prompt);
      },
    }) as never,
  );

  return { server, session, engine };
}
