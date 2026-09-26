import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as testing from "../src/tools/testing.js";
import { assistToolNames } from "../src/tools/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("TESTING capability tools (real headless chromium, offline)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let ctx: ToolContext;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    ctx = { session };
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("generate_locator returns a usable locator that resolves the element", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
    const page = await session.getPage();
    const snap = await capture(page);
    const nameRef = snap.controls.find((c) => c.tag === "input")!.ref;

    const res = await testing.makeGenerateLocatorHandler(ctx)({ target: nameRef });
    expect(res.isError).toBeFalsy();
    const expr = textOf(res);
    // It should be a real Playwright locator expression.
    expect(expr).toMatch(/^page\.(getByRole|getByText|locator)\(/);

    // A raw selector target is echoed back as a locator() call that resolves the element.
    const rawRes = await testing.makeGenerateLocatorHandler(ctx)({ target: "#name" });
    expect(textOf(rawRes)).toBe('page.locator("#name")');
  });

  it("verify_element_visible passes for a visible element and fails for a hidden one", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
    const pass = await testing.makeVerifyElementVisibleHandler(ctx)({ target: "#ready" });
    expect(pass.isError).toBeFalsy();
    expect(textOf(pass)).toContain("PASS");

    const fail = await testing.makeVerifyElementVisibleHandler(ctx)({ target: "#hidden-btn" });
    expect(fail.isError).toBe(true);
    expect(textOf(fail)).toContain("FAIL");
  });

  it("verify_text_visible passes for present text and fails for absent text", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
    const pass = await testing.makeVerifyTextVisibleHandler(ctx)({ text: "Banana" });
    expect(pass.isError).toBeFalsy();
    expect(textOf(pass)).toContain("PASS");

    const fail = await testing.makeVerifyTextVisibleHandler(ctx)({ text: "Durian" });
    expect(fail.isError).toBe(true);
    expect(textOf(fail)).toContain("FAIL");
  });

  it("verify_list_visible passes when the list and its items are visible, fails otherwise", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
    const pass = await testing.makeVerifyListVisibleHandler(ctx)({
      target: "#fruits",
      items: ["Apple", "Cherry"],
    });
    expect(pass.isError).toBeFalsy();
    expect(textOf(pass)).toContain("PASS");

    const fail = await testing.makeVerifyListVisibleHandler(ctx)({
      target: "#fruits",
      items: ["Apple", "Durian"],
    });
    expect(fail.isError).toBe(true);
    expect(textOf(fail)).toContain("FAIL");
  });

  it("verify_value passes on a match and fails on a mismatch", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("list.html") });
    const pass = await testing.makeVerifyValueHandler(ctx)({ target: "#name", value: "Ada" });
    expect(pass.isError).toBeFalsy();
    expect(textOf(pass)).toContain("PASS");

    const fail = await testing.makeVerifyValueHandler(ctx)({ target: "#name", value: "Grace" });
    expect(fail.isError).toBe(true);
    expect(textOf(fail)).toContain("FAIL");
  });

  it("testing tools are gated behind the 'testing' capability", async () => {
    const coreOnly = assistToolNames([]);
    expect(coreOnly).not.toContain("browser_generate_locator");
    expect(coreOnly).not.toContain("browser_verify_element_visible");

    const withTesting = assistToolNames(["testing"]);
    expect(withTesting).toContain("browser_generate_locator");
    expect(withTesting).toContain("browser_verify_element_visible");
    expect(withTesting).toContain("browser_verify_text_visible");
    expect(withTesting).toContain("browser_verify_list_visible");
    expect(withTesting).toContain("browser_verify_value");
    // Other groups must NOT come along with 'testing'.
    expect(withTesting).not.toContain("browser_pdf_save");
    expect(withTesting).not.toContain("browser_mouse_click_xy");
  });
});
