import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as snapshotTool from "../src/tools/snapshot.js";
import * as clickTool from "../src/tools/click.js";
import * as typeTool from "../src/tools/type.js";
import * as selectTool from "../src/tools/select_option.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("Assist-mode tools (real headless chromium, no weights)", () => {
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

  it("browser_navigate returns a snapshot of the target page", async () => {
    const handler = navigate.makeHandler(ctx);
    const result = await handler({ url: fixtures.url("login.html") });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Navigated to");
    expect(text).toContain('- button "Sign in" [ref=');
  });

  it("browser_snapshot advertises interactive refs", async () => {
    const handler = snapshotTool.makeHandler(ctx);
    const result = await handler();
    expect(textOf(result)).toMatch(/\[ref=e\d+\]/);
  });

  it("browser_type + browser_click drive a form to a changed result", async () => {
    // Fresh page state.
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();

    // Find the email + submit refs from a live snapshot.
    const snap = await capture(page);
    const emailRef = snap.controls.find((c) => c.name === "Email")!.ref;
    const submitRef = snap.controls.find((c) => c.role === "button" && c.name === "Sign in")!.ref;

    const typeResult = await typeTool.makeHandler(ctx)({
      target: emailRef,
      text: "user@example.com",
      element: "Email field",
    });
    expect(typeResult.isError).toBeFalsy();
    expect(await page.locator("#email").inputValue()).toBe("user@example.com");

    const clickResult = await clickTool.makeHandler(ctx)({
      target: submitRef,
      element: "Sign in button",
    });
    expect(clickResult.isError).toBeFalsy();

    // Literal outcome: status text, title, and URL hash all change on success.
    expect(await page.locator("#status").textContent()).toBe("Signed in as user@example.com");
    expect(await page.title()).toBe("Signed in");
    expect(page.url()).toContain("#signed-in");
  });

  it("browser_click accepts a raw selector as target", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    await typeTool.makeHandler(ctx)({ target: "#email", text: "raw@example.com" });
    await clickTool.makeHandler(ctx)({ target: "#submit" });
    expect(await page.locator("#status").textContent()).toBe("Signed in as raw@example.com");
  });

  it("browser_select_option chooses an option by label", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const snap = await capture(page);
    const roleRef = snap.controls.find((c) => c.name === "Role")!.ref;

    const result = await selectTool.makeHandler(ctx)({ target: roleRef, values: ["Admin"] });
    expect(result.isError).toBeFalsy();
    expect(await page.locator("#role").inputValue()).toBe("admin");
  });

  it("returns an error result for a target that matches nothing", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const result = await clickTool.makeHandler(ctx)({ target: "e9999" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Failed to click");
  });

  // Regression: ref-based tools must await getPage() before resolveRef(), because
  // resolveRef() is synchronous and throws while the browser is still launching.
  // A real MCP client pipelines calls against one shared session, so a browser_type
  // can reach resolveRef() before the page exists. These tests use their OWN fresh,
  // never-launched session so the page really is undefined at the first ref resolution;
  // they fail (with "call getPage() first") if the getPage() await is removed.
  describe("resolveRef before page exists (pipelined-call regression)", () => {
    let raceSession: BrowserSession;
    let raceCtx: ToolContext;

    beforeAll(() => {
      raceSession = new BrowserSession({ headless: true });
      raceCtx = { session: raceSession };
    });

    afterAll(async () => {
      await raceSession.close();
    });

    it("browser_type succeeds as the first action, before any page is created", async () => {
      // No prior navigate/getPage on this session: the page is undefined here.
      expect(raceSession.launched).toBe(false);
      // Navigate so there is a document to type into, but do it as a pipelined pair:
      // kick off navigate and immediately issue type WITHOUT awaiting navigate first,
      // exactly as an MCP client that pipelines requests over stdio would.
      const navPromise = navigate
        .makeHandler(raceCtx)({ url: fixtures.url("login.html") });
      const typePromise = typeTool.makeHandler(raceCtx)({
        target: "#email",
        text: "race@example.com",
        element: "Email field",
      });
      const [, typeResult] = await Promise.all([navPromise, typePromise]);

      // The type must have succeeded, and the DOM must actually reflect the typed value.
      expect(typeResult.isError).toBeFalsy();
      const page = await raceSession.getPage();
      expect(await page.locator("#email").inputValue()).toBe("race@example.com");
    });

    it("browser_click resolves a ref immediately after navigate on a fresh session", async () => {
      const clickSession = new BrowserSession({ headless: true });
      const clickCtx: ToolContext = { session: clickSession };
      try {
        const navPromise = navigate
          .makeHandler(clickCtx)({ url: fixtures.url("login.html") });
        const clickPromise = clickTool.makeHandler(clickCtx)({
          target: "#help",
          element: "Help link",
        });
        const [, clickResult] = await Promise.all([navPromise, clickPromise]);

        expect(clickResult.isError).toBeFalsy();
        const page = await clickSession.getPage();
        // The help link sets the URL hash on click: a literal DOM/nav outcome.
        expect(page.url()).toContain("#help");
      } finally {
        await clickSession.close();
      }
    });
  });
});
