import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as navigateBack from "../src/tools/navigate_back.js";
import * as resize from "../src/tools/resize.js";
import * as hover from "../src/tools/hover.js";
import * as find from "../src/tools/find.js";
import * as drag from "../src/tools/drag.js";
import * as drop from "../src/tools/drop.js";
import * as fillForm from "../src/tools/fill_form.js";
import * as evaluate from "../src/tools/evaluate.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("CORE parity tools part A (real headless chromium, no weights)", () => {
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

  it("browser_navigate_back returns to the prior page URL", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    await navigate.makeHandler(ctx)({ url: fixtures.url("checkout.html") });
    const page = await session.getPage();
    expect(page.url()).toContain("checkout.html");

    const result = await navigateBack.makeHandler(ctx)();
    expect(result.isError).toBeFalsy();
    expect(page.url()).toContain("login.html");
  });

  it("browser_resize changes window.innerWidth/innerHeight", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();

    const result = await resize.makeHandler(ctx)({ width: 640, height: 480 });
    expect(result.isError).toBeFalsy();
    expect(await page.evaluate(() => window.innerWidth)).toBe(640);
    expect(await page.evaluate(() => window.innerHeight)).toBe(480);
  });

  it("browser_hover triggers a hover-driven DOM change", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("hover.html") });
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("idle");

    const result = await hover.makeHandler(ctx)({ target: "#trigger", element: "Hover me button" });
    expect(result.isError).toBeFalsy();
    expect(await page.locator("#status").textContent()).toBe("hovered");
  });

  it("browser_find returns a ref for a known label", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const page = await session.getPage();
    const snap = await capture(page);
    const expectedRef = snap.controls.find((c) => c.name === "Email")!.ref;

    const result = await find.makeHandler(ctx)({ text: "Email" });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Found");
    expect(text).toContain(`[ref=${expectedRef}]`);
  });

  it("browser_find supports regexp and reports no match", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });

    const match = await find.makeHandler(ctx)({ regexp: "sign\\s?in" });
    expect(match.isError).toBeFalsy();
    expect(textOf(match)).toMatch(/\[ref=e\d+\]/);

    const miss = await find.makeHandler(ctx)({ text: "no-such-control-xyz" });
    expect(miss.isError).toBe(true);
    expect(textOf(miss)).toContain("No matching controls");
  });

  it("browser_find rejects a query with neither text nor regexp", async () => {
    const result = await find.makeHandler(ctx)({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires either");
  });

  it("browser_drag moves an element into a drop target", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("drag.html") });
    const page = await session.getPage();
    // Before: the source is not a child of the target.
    expect(await page.evaluate(() => document.querySelector("#target #source") !== null)).toBe(false);
    expect(await page.locator("#status").textContent()).toBe("idle");

    const result = await drag.makeHandler(ctx)({
      startTarget: "#source",
      startElement: "draggable box",
      endTarget: "#target",
      endElement: "drop zone",
    });
    expect(result.isError).toBeFalsy();

    // After: the drop handler moved the source into the target and set the status.
    expect(await page.evaluate(() => document.querySelector("#target #source") !== null)).toBe(true);
    expect(await page.locator("#status").textContent()).toBe("dropped");
  });

  it("browser_drop uploads a file to a file input", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("drop.html") });
    const page = await session.getPage();
    expect(await page.locator("#file-status").textContent()).toBe("no file");

    const dir = await mkdtemp(join(tmpdir(), "laya-drop-"));
    const filePath = join(dir, "hello.txt");
    await writeFile(filePath, "hello");

    const result = await drop.makeHandler(ctx)({ target: "#upload", paths: [filePath] });
    expect(result.isError).toBeFalsy();
    expect(await page.locator("#file-status").textContent()).toBe("file: hello.txt");
  });

  it("browser_drop dispatches MIME data onto an element", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("drop.html") });
    const page = await session.getPage();
    expect(await page.locator("#data-status").textContent()).toBe("no data");

    const result = await drop.makeHandler(ctx)({
      target: "#zone",
      data: [{ mimeType: "text/plain", base64: Buffer.from("payload").toString("base64") }],
    });
    expect(result.isError).toBeFalsy();
    expect(await page.locator("#data-status").textContent()).toBe("data: payload");
  });

  it("browser_drop rejects a call with neither paths nor data", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("drop.html") });
    const result = await drop.makeHandler(ctx)({ target: "#zone" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires either");
  });

  it("browser_fill_form fills MULTIPLE fields in one call", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("multi-field-form.html") });
    const page = await session.getPage();

    const result = await fillForm.makeHandler(ctx)({
      fields: [
        { target: "#first", value: "Ada", type: "textbox" },
        { target: "#last", value: "Lovelace", type: "textbox" },
        { target: "#bio", value: "First programmer", type: "textbox" },
        { target: "#country", value: "Canada", type: "combobox" },
        { target: "#subscribe", value: "true", type: "checkbox" },
      ],
    });
    expect(result.isError).toBeFalsy();

    // The DOM must reflect EVERY field.
    expect(await page.locator("#first").inputValue()).toBe("Ada");
    expect(await page.locator("#last").inputValue()).toBe("Lovelace");
    expect(await page.locator("#bio").inputValue()).toBe("First programmer");
    expect(await page.locator("#country").inputValue()).toBe("ca");
    expect(await page.locator("#subscribe").isChecked()).toBe(true);
  });

  it("browser_evaluate returns a computed value on the page", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });

    const arithmetic = await evaluate.makeHandler(ctx)({ function: "() => 2 + 2" });
    expect(arithmetic.isError).toBeFalsy();
    expect(textOf(arithmetic)).toBe("4");

    const title = await evaluate.makeHandler(ctx)({ function: "() => document.title" });
    expect(title.isError).toBeFalsy();
    expect(textOf(title)).toBe(JSON.stringify("Sign in"));
  });

  it("browser_evaluate runs against a resolved element", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const result = await evaluate.makeHandler(ctx)({
      function: "(el) => el.textContent",
      target: "#help",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(JSON.stringify("Need help?"));
  });

  it("browser_evaluate returns an error result when the function throws", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("login.html") });
    const result = await evaluate.makeHandler(ctx)({
      function: "() => { throw new Error('boom'); }",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Failed to evaluate");
  });
});
