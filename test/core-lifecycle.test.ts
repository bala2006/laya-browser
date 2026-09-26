import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as tabs from "../src/tools/tabs.js";
import * as handleDialog from "../src/tools/handle_dialog.js";
import * as fileUpload from "../src/tools/file_upload.js";
import * as takeScreenshot from "../src/tools/take_screenshot.js";
import * as consoleMessages from "../src/tools/console_messages.js";
import * as networkRequests from "../src/tools/network_requests.js";
import * as networkRequest from "../src/tools/network_request.js";
import * as runCodeUnsafe from "../src/tools/run_code_unsafe.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

describe("CORE parity tools part B: lifecycle + observation (real chromium, offline)", () => {
  let fixtures: FixtureServer;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
  });

  afterAll(async () => {
    await fixtures.close();
  });

  it("browser_tabs creates a second tab and list shows 2 tabs", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    try {
      await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });

      const created = await tabs.makeHandler(ctx)({
        action: "create",
        url: fixtures.url("checkout.html"),
      });
      expect(created.isError).toBeFalsy();

      const list = await tabs.makeHandler(ctx)({ action: "list" });
      expect(list.isError).toBeFalsy();
      const text = textOf(list);
      expect(text).toContain("Open tabs (2)");
      expect(text).toContain("[0]");
      expect(text).toContain("[1]");
      // The active marker sits on the newly created tab.
      expect(text).toMatch(/\*\s+\[1\]/);

      // Selecting tab 0 makes it the page resolveRef/getPage act on.
      const selected = await tabs.makeHandler(ctx)({ action: "select", index: 0 });
      expect(selected.isError).toBeFalsy();
      expect((await session.getPage()).url()).toContain("login.html");

      // Closing tab 0 leaves exactly one tab.
      const closed = await tabs.makeHandler(ctx)({ action: "close", index: 0 });
      expect(closed.isError).toBeFalsy();
      expect(textOf(closed)).toContain("Open tabs (1)");
    } finally {
      await session.close();
    }
  });

  it("browser_handle_dialog accept lets a confirm() proceed", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    try {
      await navigate.makeHandler(ctx)({ url: fixtures.url("dialog.html") });
      const page = await session.getPage();
      expect(await page.locator("#confirm-status").textContent()).toBe("unconfirmed");

      const reg = await handleDialog.makeHandler(ctx)({ accept: true });
      expect(reg.isError).toBeFalsy();
      expect(textOf(reg)).toContain("accept");

      await page.click("#confirm-btn");
      expect(await page.locator("#confirm-status").textContent()).toBe("confirmed");
    } finally {
      await session.close();
    }
  });

  it("browser_handle_dialog dismiss cancels a confirm()", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    try {
      await navigate.makeHandler(ctx)({ url: fixtures.url("dialog.html") });
      const page = await session.getPage();

      await handleDialog.makeHandler(ctx)({ accept: false });
      await page.click("#confirm-btn");
      expect(await page.locator("#confirm-status").textContent()).toBe("cancelled");
    } finally {
      await session.close();
    }
  });

  it("browser_handle_dialog accept with promptText fills a prompt()", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    try {
      await navigate.makeHandler(ctx)({ url: fixtures.url("dialog.html") });
      const page = await session.getPage();

      await handleDialog.makeHandler(ctx)({ accept: true, promptText: "Ada" });
      await page.click("#prompt-btn");
      expect(await page.locator("#prompt-status").textContent()).toBe("name: Ada");
    } finally {
      await session.close();
    }
  });

  it("browser_file_upload sets a file on an input and the DOM reflects it", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    try {
      await navigate.makeHandler(ctx)({ url: fixtures.url("upload.html") });
      const page = await session.getPage();
      expect(await page.locator("#upload-status").textContent()).toBe("no file");

      const dir = await mkdtemp(join(tmpdir(), "laya-upload-"));
      const filePath = join(dir, "resume.txt");
      await writeFile(filePath, "hello");

      const result = await fileUpload.makeHandler(ctx)({ target: "#file", paths: [filePath] });
      expect(result.isError).toBeFalsy();
      expect(await page.locator("#upload-status").textContent()).toBe("file: resume.txt");
    } finally {
      await session.close();
    }
  });

  it("browser_take_screenshot returns a non-empty base64 image content block", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    try {
      await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });

      const result = await takeScreenshot.makeHandler(ctx)({ type: "png" });
      expect(result.isError).toBeFalsy();
      const block = result.content[0] as { type: string; data: string; mimeType: string };
      expect(block.type).toBe("image");
      expect(block.mimeType).toBe("image/png");
      expect(typeof block.data).toBe("string");
      expect(block.data.length).toBeGreaterThan(100);
      // PNG magic bytes begin "iVBORw0KGgo" once base64-encoded.
      expect(block.data.startsWith("iVBORw0KGgo")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("browser_console_messages captures a console.log fired by a fixture on load", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    try {
      await navigate.makeHandler(ctx)({ url: fixtures.url("console.html") });
      // Give the load-time console events a moment to arrive.
      await (await session.getPage()).waitForTimeout(100);

      const all = await consoleMessages.makeHandler(ctx)({});
      expect(all.isError).toBeFalsy();
      expect(textOf(all)).toContain("laya-console-marker");

      const errorsOnly = await consoleMessages.makeHandler(ctx)({ onlyErrors: true });
      expect(textOf(errorsOnly)).toContain("laya-console-error");
      expect(textOf(errorsOnly)).not.toContain("laya-console-marker");
    } finally {
      await session.close();
    }
  });

  it("browser_network_requests lists a same-origin fetch and network_request returns its detail", async () => {
    const session = new BrowserSession({ headless: true });
    const ctx: ToolContext = { session };
    try {
      await navigate.makeHandler(ctx)({ url: fixtures.url("network.html") });
      const page = await session.getPage();
      // Wait for the fixture's fetch to complete and update the DOM.
      await page.waitForFunction(
        () => document.getElementById("status")?.textContent?.startsWith("loaded:"),
        undefined,
        { timeout: 5000 },
      );

      const list = await networkRequests.makeHandler(ctx)();
      expect(list.isError).toBeFalsy();
      expect(textOf(list)).toContain("network-data.html");

      const detail = await networkRequest.makeHandler(ctx)({ url: "network-data.html" });
      expect(detail.isError).toBeFalsy();
      const text = textOf(detail);
      expect(text).toContain("network-data.html");
      expect(text).toContain("status: 200");
      expect(text).toContain("resourceType:");
    } finally {
      await session.close();
    }
  });

  it("browser_run_code_unsafe returns a value when enabled and refuses when disabled", async () => {
    // Disabled by default: it refuses without running anything.
    const disabledSession = new BrowserSession({ headless: true });
    const disabledCtx: ToolContext = { session: disabledSession };
    try {
      await navigate.makeHandler(disabledCtx)({ url: fixtures.url("login.html") });
      const refused = await runCodeUnsafe.makeHandler(disabledCtx)({
        code: "return await page.title();",
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("disabled");
    } finally {
      await disabledSession.close();
    }

    // Enabled: it executes the snippet against the page and returns the value.
    const enabledSession = new BrowserSession({ headless: true });
    const enabledCtx: ToolContext = { session: enabledSession, allowUnsafeCode: true };
    try {
      await navigate.makeHandler(enabledCtx)({ url: fixtures.url("login.html") });
      const result = await runCodeUnsafe.makeHandler(enabledCtx)({
        code: "return await page.title();",
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toBe(JSON.stringify("Sign in"));
    } finally {
      await enabledSession.close();
    }
  });
});
