#!/usr/bin/env node
/**
 * Bin entry for `laya-browser-mcp`.
 *
 * Boots the Assist-mode MCP server over stdio and installs signal handlers that close
 * the browser cleanly on SIGINT/SIGTERM. No model weights are loaded in Assist mode.
 *
 * Env:
 *   LAYA_BROWSER_HEADLESS=true    run headless (default: headed; a headed launch with no
 *                                 display server auto-falls-back to headless)
 *   LAYA_BROWSER_CHANNEL=chrome   use a specific Chromium channel
 *   LAYA_BROWSER_OVERLAY=auto|on|off   agentLens visual overlay (default: auto = on when headed)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createEngine } from "./laya/index.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  // Parse ALL configuration once from the environment (Boundary Discipline) and hand the
  // typed config inward. No other module reads process.env for these settings.
  const config = loadConfig();

  // Build the Autopilot engine from that config: engine=stub selects the deterministic
  // stub; modelDir points at a local ONNX bundle; otherwise the engine is unavailable and
  // laya_run_goal degrades gracefully to the Assist-mode tools.
  const engine = await createEngine({
    engine: config.engine,
    ...(config.modelDir !== undefined ? { modelDir: config.modelDir } : {}),
    ...(config.repo !== undefined ? { repo: config.repo } : {}),
    ...(config.subfolder !== undefined ? { subfolder: config.subfolder } : {}),
    ...(config.revision !== undefined ? { revision: config.revision } : {}),
    ...(config.cacheDir !== undefined ? { cacheDir: config.cacheDir } : {}),
    ...(config.executionProviders !== undefined
      ? { executionProviders: config.executionProviders }
      : {}),
  });
  if (engine.available) {
    process.stderr.write("[laya-browser-mcp] Autopilot engine loaded.\n");
  } else {
    process.stderr.write(
      "[laya-browser-mcp] no Laya weights; Autopilot will degrade to Assist mode.\n",
    );
  }

  // createServer derives the browser session (engine/headless/viewport/channel) from the
  // typed config, so we hand it the config and let it build the session.
  const { server, session } = createServer({
    engine,
    config,
  });

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;
    // Log to stderr so we never corrupt the stdio JSON-RPC stream on stdout.
    process.stderr.write(`\n[laya-browser-mcp] received ${signal}, shutting down...\n`);
    try {
      await session.close();
      await engine.close().catch(() => {});
    } finally {
      await server.close().catch(() => {});
      process.exit(0);
    }
  };

  process.on("SIGINT", (s) => void shutdown(s));
  process.on("SIGTERM", (s) => void shutdown(s));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[laya-browser-mcp] Assist-mode server ready on stdio.\n");
}

main().catch((err) => {
  process.stderr.write(`[laya-browser-mcp] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
