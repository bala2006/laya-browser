import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as tabs from "../src/tools/tabs.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

/**
 * Regression: a tab opened by the PAGE itself via window.open(...) must be tracked, listed,
 * and selectable — not just server-opened tabs. This fails on the pre-fix code (which only
 * appended to `pages` in launch()/newTab()) and passes once launch() subscribes to the
 * context "page" event. Runs against real headless Chromium and local fixtures only.
 */
describe("EXTERNAL tab tracking via window.open (real headless chromium, offline)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let ctx: ToolContext;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    ctx = { session };
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("listTabs() reports a window.open() popup and selectTab() can focus it", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("tabs-opener.html") });
    const opener = await session.getPage();
    expect(opener.url()).toContain("tabs-opener.html");

    // Before clicking, only the opener tab exists.
    let list = await session.listTabs();
    expect(list).toHaveLength(1);

    // The page opens a second tab itself; wait for the context to surface it.
    const popupPromise = session.getPage().then((p) => p.context().waitForEvent("page"));
    await opener.click("#open");
    await popupPromise;

    // The externally-opened popup is now listable, and focus stays on the opener.
    list = await session.listTabs();
    expect(list).toHaveLength(2);
    const urls = list.map((t) => t.url).join(" ");
    expect(urls).toContain("tabs-popup.html");
    expect(list[0]!.active).toBe(true);
    expect(list[1]!.active).toBe(false);

    // Selecting the popup makes it the active page.
    await session.selectTab(1);
    const active = await session.getPage();
    expect(active.url()).toContain("tabs-popup.html");
  });

  it("browser_tabs 'list' surfaces a window.open() popup through the tool", async () => {
    const localSession = new BrowserSession({ headless: true });
    const localCtx: ToolContext = { session: localSession };
    try {
      await navigate.makeHandler(localCtx)({ url: fixtures.url("tabs-opener.html") });
      const opener = await localSession.getPage();

      const popupPromise = opener.context().waitForEvent("page");
      await opener.click("#open");
      await popupPromise;

      const listed = await tabs.makeHandler(localCtx)({ action: "list" });
      expect(listed.isError).toBeFalsy();
      const text = textOf(listed);
      expect(text).toContain("Open tabs (2)");
      expect(text).toContain("tabs-popup.html");
    } finally {
      await localSession.close();
    }
  });
});
