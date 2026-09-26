#!/usr/bin/env node
/**
 * Bin entry for `laya-browser-mcp`.
 *
 * Boots the Assist-mode MCP server over stdio and installs signal handlers that close
 * the browser cleanly on SIGINT/SIGTERM. No model weights are loaded in Assist mode.
 *
 * Env:
 *   LAYA_BROWSER_HEADLESS=false   run headed (default headless)
 *   LAYA_BROWSER_CHANNEL=chrome   use a specific Chromium channel
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const headless = process.env.LAYA_BROWSER_HEADLESS !== "false";
  const channel = process.env.LAYA_BROWSER_CHANNEL;

  const { server, session } = createServer({
    browser: {
      headless,
      ...(channel ? { channel } : {}),
    },
  });

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;
    // Log to stderr so we never corrupt the stdio JSON-RPC stream on stdout.
    process.stderr.write(`\n[laya-browser-mcp] received ${signal}, shutting down...\n`);
    try {
      await session.close();
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
