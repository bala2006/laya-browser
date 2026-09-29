/**
 * Collapsed duplicate fields (a responsive second search box rendered 0x0, as on Wikipedia and
 * docs.python.org) must not be offered: Autopilot filled every copy and aimed the cursor at
 * (0, 0). Styled 0x0 checkboxes behind a visible label must still be offered.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { capture, captureFast } from "../src/snapshot.js";
import { unfilledGoalFields } from "../src/laya/goal.js";
import type { Control } from "../src/types.js";

const HTML = `<!doctype html><body>
  <input aria-label="Quick search" id="top">
  <input aria-label="Quick search" id="ghost" style="width:0;height:0;padding:0;border:0">
  <label><input type="checkbox" id="cb" style="width:0;height:0;margin:0"> Remember me</label>
  <div style="height:1500px"></div>
  <input aria-label="Quick search" id="footer">
</body>`;

describe("collapsed duplicate fields", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent(HTML);
  });
  afterAll(async () => browser.close());

  const ids = async (controls: Control[]): Promise<string[]> =>
    page.evaluate(
      (refs) => refs.map((r) => document.querySelector(`[data-laya-ref="${r}"]`)?.id ?? "?"),
      controls.map((c) => c.ref as string),
    );

  it("drops a 0x0 text input but keeps a 0x0 checkbox (both capture paths)", async () => {
    for (const snap of [await captureFast(page), await capture(page)]) {
      const found = await ids(snap.controls);
      expect(found).not.toContain("ghost");
      expect(found).toEqual(expect.arrayContaining(["top", "cb", "footer"]));
    }
  });

  it("fills a repeated field once, not every copy", async () => {
    const snap = await captureFast(page);
    const fields = unfilledGoalFields('search for "asyncio"', snap.controls);
    expect(fields).toHaveLength(1);
    expect(await ids([fields[0]!.control])).toEqual(["top"]);
  });
});
