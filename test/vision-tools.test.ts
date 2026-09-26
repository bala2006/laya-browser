import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import type { ToolContext } from "../src/tools/shared.js";
import * as navigate from "../src/tools/navigate.js";
import * as vision from "../src/tools/vision.js";
import { assistToolNames } from "../src/tools/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

describe("VISION capability tools (real headless chromium, offline)", () => {
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

  it("mouse_click_xy fires the fixture button's click handler at its coordinates", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("vision.html") });
    const page = await session.getPage();

    // The button is positioned at left:100 top:100, 120x60 -> centre ~ (160, 130).
    const box = await page.locator("#target").boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    expect(await page.locator("#status").textContent()).toBe("not clicked");
    const res = await vision.makeClickHandler(ctx)({ x: cx, y: cy });
    expect(res.isError).toBeFalsy();
    expect(await page.locator("#status").textContent()).toBe("clicked");
  });

  it("mouse_wheel scrolls the page (window.scrollY increases)", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("vision.html") });
    const page = await session.getPage();

    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const res = await vision.makeWheelHandler(ctx)({ deltaY: 500 });
    expect(res.isError).toBeFalsy();
    // Give the scroll a beat to apply, then assert it moved.
    await page.waitForFunction(() => window.scrollY > 0);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  it("mouse_move/down/up drive raw button events without error", async () => {
    await navigate.makeHandler(ctx)({ url: fixtures.url("vision.html") });
    const page = await session.getPage();
    const box = await page.locator("#target").boundingBox();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    expect((await vision.makeMoveHandler(ctx)({ x: cx, y: cy })).isError).toBeFalsy();
    expect((await vision.makeDownHandler(ctx)({})).isError).toBeFalsy();
    expect((await vision.makeUpHandler(ctx)({})).isError).toBeFalsy();
    // down+up over the button fires its click handler.
    expect(await page.locator("#status").textContent()).toBe("clicked");
  });

  it("vision tools are gated behind the 'vision' capability", async () => {
    const coreOnly = assistToolNames([]);
    expect(coreOnly).not.toContain("browser_mouse_click_xy");

    const withVision = assistToolNames(["vision"]);
    expect(withVision).toContain("browser_mouse_move_xy");
    expect(withVision).toContain("browser_mouse_click_xy");
    expect(withVision).toContain("browser_mouse_drag_xy");
    expect(withVision).toContain("browser_mouse_down");
    expect(withVision).toContain("browser_mouse_up");
    expect(withVision).toContain("browser_mouse_wheel");
    expect(withVision).not.toContain("browser_pdf_save");
  });
});
