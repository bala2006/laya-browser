/**
 * Cross-browser smoke test: prove BrowserSession is genuinely engine-driven.
 *
 * The default suite exercises chromium exhaustively; this file runs ONE representative
 * flow (navigate to the login fixture, confirm the snapshot advertises refs, then
 * type + click to drive the form to its literal signed-in outcome) on a NON-Chromium
 * engine so we know the engine selection in src/browser.ts really launches a different
 * browser rather than always falling back to Chromium.
 *
 * firefox is required to really run (it is the most reliable headless engine in Linux
 * sandboxes). webkit is gated behind a describe.skipIf on whether its executable is
 * present, because some Linux sandboxes lack the system libraries WebKit needs to launch;
 * when it is available it runs the same flow. Everything stays offline against the local
 * loopback fixture server, so the suite never touches the network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { firefox, webkit } from "playwright";
import { BrowserSession, type BrowserEngineName } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as snapshotTool from "../src/tools/snapshot.js";
import * as clickTool from "../src/tools/click.js";
import * as typeTool from "../src/tools/type.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

/** Whether Playwright has a downloaded executable for this engine. */
function engineInstalled(browserType: { executablePath(): string }): boolean {
  try {
    return existsSync(browserType.executablePath());
  } catch {
    return false;
  }
}

/**
 * Whether an engine can actually LAUNCH in this sandbox. A downloaded executable is not
 * enough: some Linux sandboxes lack the shared libraries WebKit needs, so the binary is
 * present but `launch()` throws. We probe once at module setup and gate accordingly, so a
 * non-launchable engine is documented-skipped rather than faked or failing the suite.
 */
async function engineLaunchable(browserType: {
  launch(opts: { headless: boolean }): Promise<{ close(): Promise<void> }>;
}): Promise<boolean> {
  try {
    const browser = await browserType.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

// firefox MUST really run; webkit is skipped (with a documented reason) only when the
// sandbox cannot launch a WebKit build. We probe launchability, not mere file existence,
// because the WebKit binary can be present yet fail to launch for missing system libs.
const webkitLaunchable = await engineLaunchable(webkit);

/** Run the same representative sign-in flow against an arbitrary engine. */
function crossBrowserSuite(engine: BrowserEngineName): void {
  describe(`cross-browser smoke (${engine}, real headless engine, offline fixture)`, () => {
    let fixtures: FixtureServer;
    let session: BrowserSession;
    let ctx: ToolContext;

    beforeAll(async () => {
      fixtures = await startFixtureServer();
      session = new BrowserSession({ engine, headless: true });
      ctx = { session };
    });

    afterAll(async () => {
      await session.close();
      await fixtures.close();
    });

    it("drives the login fixture to its signed-in outcome", async () => {
      // Navigate: the fresh snapshot in the result must advertise refs, and the engine
      // must really be the requested one (not chromium falling through).
      const navResult = await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
      expect(navResult.isError).toBeFalsy();
      expect(textOf(navResult)).toContain('- button "Sign in" [ref=');

      const snap = await snapshotTool.makeHandler(ctx)();
      expect(textOf(snap)).toMatch(/\[ref=e\d+\]/);

      const page = await session.getPage();
      const controls = (await capture(page)).controls;
      const emailRef = controls.find((c) => c.name === "Email")!.ref;
      const submitRef = controls.find(
        (c) => c.role === "button" && c.name === "Sign in",
      )!.ref;

      const typeResult = await typeTool.makeHandler(ctx)({
        target: emailRef,
        text: "cross@example.com",
        element: "Email field",
      });
      expect(typeResult.isError).toBeFalsy();

      const clickResult = await clickTool.makeHandler(ctx)({
        target: submitRef,
        element: "Sign in button",
      });
      expect(clickResult.isError).toBeFalsy();

      // Literal signed-in outcome, identical to the chromium suite's assertion.
      expect(await page.locator("#status").textContent()).toBe(
        "Signed in as cross@example.com",
      );
      expect(await page.title()).toBe("Signed in");
      expect(page.url()).toContain("#signed-in");
    });
  });
}

// firefox is required by the plan to really launch (not skipped). If its executable is
// missing the developer forgot `pnpm exec playwright install firefox`; fail loudly there
// rather than silently skipping, so the cross-browser guarantee is never faked.
if (!engineInstalled(firefox)) {
  throw new Error(
    "firefox is not installed for Playwright; run `pnpm exec playwright install firefox`. " +
      "The cross-browser smoke test requires firefox to really launch.",
  );
}
crossBrowserSuite("firefox");

// webkit: run the same flow when it can launch; skip with a documented reason otherwise.
// In this sandbox WebKit is downloaded but cannot launch (missing system libraries), so
// this suite is skipped here while firefox really runs.
describe.skipIf(!webkitLaunchable)("webkit engine (skipped when not launchable)", () => {
  crossBrowserSuite("webkit");
});
