import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as route from "../src/tools/route.js";
import { assistToolNames } from "../src/tools/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("NETWORK capability tools (real headless chromium, offline)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let ctx: ToolContext;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    ctx = { session };
    // Launch so the context exists before we register routes.
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("browser_route fulfills a fixture fetch with canned JSON the page displays", async () => {
    // The fixture fetches same-origin 'api/data.json' (which does NOT exist on disk);
    // the route rule fulfills it with canned JSON, and the page echoes the body.
    const routeRes = await route.makeRouteHandler(ctx)({
      url: "**/api/data.json",
      action: "fulfill",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mocked: true, id: 42 }),
    });
    expect(routeRes.isError).toBeFalsy();

    await navigate.makeHandler(ctx)({ url: fixtures.url("mock-fetch.html") });
    const page = await session.getPage();
    await page.click("#load");
    await page.waitForFunction(() =>
      (document.getElementById("status")?.textContent ?? "").startsWith("ok:"),
    );
    const status = await page.locator("#status").textContent();
    expect(status).toBe(`ok:${JSON.stringify({ mocked: true, id: 42 })}`);
  });

  it("browser_route_list enumerates the active rule, browser_unroute removes it", async () => {
    const listRes = await route.makeListHandler(ctx)();
    expect(textOf(listRes)).toContain("**/api/data.json -> fulfill 200");

    const unrouteRes = await route.makeUnrouteHandler(ctx)({ url: "**/api/data.json" });
    expect(unrouteRes.isError).toBeFalsy();
    expect(textOf(unrouteRes)).toContain("Removed route");

    const listAfter = await route.makeListHandler(ctx)();
    expect(textOf(listAfter)).toBe("No active routes.");

    // Removing a non-existent route reports so without erroring.
    const missing = await route.makeUnrouteHandler(ctx)({ url: "**/nope" });
    expect(missing.isError).toBeFalsy();
    expect(textOf(missing)).toContain("No active route");
  });

  it("browser_route abort fails a matching request", async () => {
    await route.makeRouteHandler(ctx)({ url: "**/api/data.json", action: "abort" });
    await navigate.makeHandler(ctx)({ url: fixtures.url("mock-fetch.html") });
    const page = await session.getPage();
    await page.click("#load");
    await page.waitForFunction(() =>
      (document.getElementById("status")?.textContent ?? "").startsWith("error:"),
    );
    expect(await page.locator("#status").textContent()).toMatch(/^error:/);
    await route.makeUnrouteHandler(ctx)({ url: "**/api/data.json" });
  });

  it("browser_network_state_set offline makes a fetch fail, online restores it", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("mock-fetch.html") });
    const page = await session.getPage();

    const offRes = await route.makeNetworkStateHandler(ctx)({ offline: true });
    expect(offRes.isError).toBeFalsy();
    // A real same-origin fetch must reject while offline.
    const offlineFailed = await page.evaluate(() =>
      fetch("network-data.html")
        .then(() => false)
        .catch(() => true),
    );
    expect(offlineFailed).toBe(true);

    const onRes = await route.makeNetworkStateHandler(ctx)({ offline: false });
    expect(onRes.isError).toBeFalsy();
    const onlineOk = await page.evaluate(() =>
      fetch("network-data.html")
        .then((r) => r.ok)
        .catch(() => false),
    );
    expect(onlineOk).toBe(true);
  });

  it("network tools are gated behind the 'network' capability", async () => {
    const coreOnly = assistToolNames([]);
    expect(coreOnly).not.toContain("browser_route");
    expect(coreOnly).not.toContain("browser_network_state_set");

    const withNetwork = assistToolNames(["network"]);
    expect(withNetwork).toContain("browser_route");
    expect(withNetwork).toContain("browser_route_list");
    expect(withNetwork).toContain("browser_unroute");
    expect(withNetwork).toContain("browser_network_state_set");

    // Enabling 'network' must not pull in 'storage' tools, and vice versa.
    expect(withNetwork).not.toContain("browser_cookie_set");
    expect(assistToolNames(["storage"])).not.toContain("browser_route");
  });
});
