/**
 * (C3) Viewport-priority ordering tests (real headless chromium).
 *
 * With viewportPriority on, controls that intersect or are near the viewport are ranked ahead
 * of far-offscreen ones in the RETURNED control list, so the downstream ~20-control cap keeps
 * the most relevant controls. The `eN` refs stay in DOM order (so resolveRef stays correct);
 * only the list order changes. These tests use a fixture with a near (above-the-fold) button
 * and a far (well-below-the-fold) button.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

describe("viewport-priority capture ordering (real headless chromium)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    const page = await session.getPage();
    await page.goto(fixtures.url("viewport-priority.html"), {
      waitUntil: "domcontentloaded",
    });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("ranks the in-viewport control before the far-offscreen one when on", async () => {
    const page = await session.getPage();
    const snap = await capture(page, { viewportPriority: true });

    const nearIndex = snap.controls.findIndex((c) => c.name === "Near Button");
    const farIndex = snap.controls.findIndex((c) => c.name === "Far Button");
    expect(nearIndex).toBeGreaterThanOrEqual(0);
    expect(farIndex).toBeGreaterThanOrEqual(0);
    expect(nearIndex).toBeLessThan(farIndex);
  });

  it("preserves DOM order (far before near) when viewport priority is off", async () => {
    const page = await session.getPage();
    const snap = await capture(page, { viewportPriority: false });
    const nearIndex = snap.controls.findIndex((c) => c.name === "Near Button");
    const farIndex = snap.controls.findIndex((c) => c.name === "Far Button");
    // The far button is FIRST in the DOM here, so the plain walk lists it before the near
    // button; viewport-priority (the test above) is what flips this to near-first.
    expect(farIndex).toBeLessThan(nearIndex);
  });

  it("keeps resolveRef correct after viewport-priority reordering", async () => {
    const page = await session.getPage();
    const snap = await capture(page, { viewportPriority: true });
    const far = snap.controls.find((c) => c.name === "Far Button")!;
    // The far button's ref must still resolve to the far button element even though it was
    // reordered to the back of the returned list (refs are stamped in DOM order).
    const locator = session.resolveRef(far.ref);
    expect(await locator.count()).toBe(1);
    expect(await locator.getAttribute("id")).toBe("far");
  });
});
