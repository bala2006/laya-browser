/**
 * Builds the laya-browser-mcp MCP server for Assist mode.
 *
 * Assist mode is a standalone superset of Playwright MCP: it registers the familiar
 * ref-based browser tools against a shared {@link BrowserSession} and loads NO model
 * weights. (Autopilot / `laya_run_goal` is added in a later phase.)
 *
 * The server advertises a `sampling`-capability note in its instructions: the later
 * Autopilot loop escalates low-confidence decisions to the client LLM via MCP sampling,
 * so clients that intend to use Autopilot should support the sampling capability.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserSession, type BrowserSessionOptions } from "./browser.js";
import { registerAssistTools } from "./tools/index.js";

/** Result of {@link createServer}: the server plus the session it drives. */
export interface CreatedServer {
  server: McpServer;
  session: BrowserSession;
}

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  /** Browser session configuration (headless, viewport, channel). */
  browser?: BrowserSessionOptions;
  /** Inject an existing session (used by tests). Overrides `browser`. */
  session?: BrowserSession;
}

const INSTRUCTIONS = [
  "laya-browser-mcp — a superset of Playwright MCP with a local Laya on-device decision engine.",
  "Assist mode exposes ref-based browser tools that work standalone with no model weights.",
  "Workflow: call browser_snapshot (or any navigating/mutating tool, which returns a fresh snapshot)",
  "to obtain stable [ref=eN] element references, then pass a ref (or a Playwright selector) as the",
  "'target' of browser_click / browser_type / browser_select_option.",
  "Note: the later Autopilot goal-runner escalates low-confidence decisions to the client LLM via",
  "MCP sampling, so clients intending to use Autopilot should support the 'sampling' capability.",
].join(" ");

/** Construct the MCP server, register Assist tools, and wire them to a browser session. */
export function createServer(options: CreateServerOptions = {}): CreatedServer {
  const session = options.session ?? new BrowserSession(options.browser);

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

  registerAssistTools(server, { session });

  return { server, session };
}
