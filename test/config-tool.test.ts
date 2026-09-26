import { describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as getConfig from "../src/tools/get_config.js";
import { assistToolNames } from "../src/tools/index.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("CONFIG capability tool", () => {
  it("browser_get_config returns the resolved config JSON (capabilities + browserEngine + headless)", async () => {
    const config = loadConfig(
      { capabilities: ["config"], browserEngine: "chromium", headless: true },
      {},
    );
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session, config };

    const res = await getConfig.makeHandler(ctx)();
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as {
      capabilities: string[];
      browserEngine: string;
      headless: boolean;
    };
    expect(parsed.capabilities).toContain("config");
    expect(parsed.browserEngine).toBe("chromium");
    expect(parsed.headless).toBe(true);

    await session.close();
  });

  it("reports an error when no config is threaded onto the context", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    const res = await getConfig.makeHandler(ctx)();
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("No resolved configuration");
    await session.close();
  });

  it("config tool is gated behind the 'config' capability", () => {
    expect(assistToolNames([])).not.toContain("browser_get_config");
    expect(assistToolNames(["config"])).toContain("browser_get_config");
    expect(assistToolNames(["testing"])).not.toContain("browser_get_config");
  });
});
