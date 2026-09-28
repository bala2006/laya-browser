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
import { createRunArtifactsHolder } from "./tools/run_artifacts.js";
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

/**
 * (B2) Ask the connected client for inline human approval of a destructive action via MCP
 * elicitation, returning `true` only on an explicit accept.
 *
 * Resolved lazily at call time behind a check of the client's `elicitation` capability
 * (mirroring how {@link samplerFromServer} gates sampling). When the client did not advertise
 * elicitation, or the request fails, or the human declines/cancels, this resolves to `false`
 * so the loop preserves its refuse-by-default fail-safe. Never throws.
 *
 * (R1) The request is BOUNDED by `timeoutMs`: elicitation waits on a human, and a prompt
 * nobody answers would otherwise block the tool call until the client's own 60s request
 * timeout fired as `-32001` RequestTimeout. On timeout this resolves to `false`, which is the
 * SAME outcome as a refusal, so the fail-safe is preserved.
 */
async function confirmViaElicitation(
  server: McpServer,
  prompt: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const capabilities = server.server.getClientCapabilities();
    if (!capabilities?.elicitation) return false;
    const result = await server.server.elicitInput(
      {
        message: prompt,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve",
              description: "Approve this destructive action.",
            },
          },
          required: ["approve"],
        },
      },
      { timeout: timeoutMs },
    );
    // Only an explicit accept with approve === true authorises the action; a decline, a
    // cancel, or a missing/false field is treated as a refusal (fail-safe).
    return result.action === "accept" && result.content?.approve === true;
  } catch {
    return false;
  }
}

/** Construct the MCP server, register Assist + Autopilot tools, and wire the session. */
export function createServer(options: CreateServerOptions = {}): CreatedServer {
  const config = options.config ?? loadConfig();
  // Build the browser session from the typed config so the engine (chromium/firefox/webkit)
  // is driven by LAYA_BROWSER. An explicit `browser` override (used by callers/tests) takes
  // precedence over the config-derived defaults; an injected `session` overrides both.
  const browserOptions: BrowserSessionOptions = {
    engine: config.browserEngine,
    headless: config.headless,
    viewport: config.viewport,
    overlay: config.overlay,
    ...(config.channel !== undefined ? { channel: config.channel } : {}),
    // (T2.1) Auto session persistence: load on launch (if file exists), save on close().
    ...(config.storageStatePath !== undefined
      ? { storageStatePath: config.storageStatePath }
      : {}),
    ...options.browser,
  };
  const session = options.session ?? new BrowserSession(browserOptions);
  const engine = options.engine ?? new UnavailableEngine();

  // (D1) The shared holder for the most recent Autopilot run's observability artifacts. It is
  // passed BY REFERENCE into both the laya_run_goal tool context (which records into it when a
  // run enables artifact recording) and the laya_export_run tool context (which reads it to
  // write a replay). One session -> one "current" run, so a single holder suffices.
  const artifacts = createRunArtifactsHolder();

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

  registerAssistTools(
    server,
    {
      session,
      allowedDomains: config.allowedDomains,
      allowUnsafeCode: config.allowUnsafeCode,
      // (B3) Opt-in destructive guard for Assist tools (default off). When off, Assist tools
      // behave exactly as before; when on, browser_click refuses a destructive click.
      assistDestructiveGuard: config.assistDestructiveGuard,
      config,
      // (D1) Share the last-run artifacts holder so laya_export_run can write a replay.
      artifacts,
      // (T1.2) Lazily-resolved sampler for the `browser_extract`/ask_page tool. The client's
      // `sampling` capability is only known after connect/initialize (post-createServer), so
      // resolve it at call time; when the client lacks sampling this returns undefined and the
      // extract tool degrades to returning the most relevant text span (never throws).
      sample: async (prompt) => {
        const sampler = samplerFromServer(server, {
          timeoutMs: config.clientRequestTimeoutMs,
        });
        if (!sampler) throw new Error("client does not support MCP sampling");
        return sampler(prompt);
      },
      // (T2.4) Default directory for browser_download_file when no explicit path is given.
      ...(config.downloadDir !== undefined ? { downloadDir: config.downloadDir } : {}),
    },
    config.capabilities,
  );

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
      waitMs: config.autopilotWaitMs,
      selfHealRetries: config.selfHealRetries,
      settleProbe: config.settleProbe,
      loopDetection: config.loopDetection,
      loopWindow: config.loopWindow,
      // (B1) Mask secret values/patterns out of the transcript/overlay/logs.
      redactSecrets: config.redactSecrets,
      // (C1) Which snapshot backend the loop captures with (domwalk default vs aria).
      snapshotBackend: config.snapshotBackend,
      // (C3) Order/cap controls by viewport visibility first.
      viewportPriority: config.viewportPriority,
      // (C2) Send only the snapshot delta to the LLM on escalation when a diff exists.
      deltaPrompt: true,
      // (D1) Per-step replay recording is an explicit opt-in (LAYA_RECORD_ARTIFACTS, default
      // OFF) so a normal run captures no screenshots. When off the shared holder simply never
      // receives a run and laya_export_run reports none recorded.
      recordArtifacts: config.recordArtifacts,
      // (T1.4) Per-step screenshots stay off unless explicitly enabled (text-first pipeline).
      loopScreenshots: config.loopScreenshots,
      // (T1.3) Bound the visible text carried into state / escalation prompts.
      stateTextLimit: config.stateTextLimit,
      // (T2.2) Auto-dismiss cookie/consent/modal overlays before each step (opt-in).
      autoDismiss: config.autoDismiss,
      // (T2.3) Descend into same-origin iframes / open shadow roots up to this depth.
      frameDepth: config.frameDepth,
      // (D1) Share the artifacts holder so a run records per-step artifacts for the
      // laya_export_run replay tool WHEN recording is enabled above. The holder alone does
      // NOT enable recording.
      artifacts,
      // (B2) Wire the real confirmation via MCP elicitation, resolved lazily at call time
      // (the client's `elicitation` capability is only known after it connects/initializes,
      // which happens after createServer). Mirrors how `sample` is wired for sampling. When
      // the client lacks elicitation, confirm resolves to false (refuse), preserving the
      // refuse-by-default fail-safe. Never throws.
      confirm: async (prompt) =>
        confirmViaElicitation(server, prompt, config.clientRequestTimeoutMs),
      // Resolve the sampler lazily at call time: the client's `sampling` capability is only
      // known after it has connected and initialized, which happens after createServer.
      sample: async (prompt) => {
        const sampler = samplerFromServer(server, {
          timeoutMs: config.clientRequestTimeoutMs,
        });
        if (!sampler) {
          throw new Error("client does not support MCP sampling");
        }
        return sampler(prompt);
      },
      // (R2) Resolve the client's sampling capability lazily. It is what lets a goal run with NO
      // local weights: the client plans the step itself. Without it the run degrades to the
      // Assist-mode hint exactly as before.
      plannerAvailable: () => Boolean(server.server.getClientCapabilities()?.sampling),
    }) as never,
  );

  return { server, session, engine };
}
