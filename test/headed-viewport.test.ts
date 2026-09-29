/**
 * Headed windows: the page must follow the OS window, so maximizing or resizing fills it
 * instead of leaving a blank strip beside a fixed 1280x800 page. Needs a display: runs when
 * $DISPLAY is set (e.g. under Xvfb), otherwise skips, since a headed launch there falls back to
 * headless by design.
 */
import { describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";

describe.skipIf(!process.env.DISPLAY)("headed window resize (needs a display)", () => {
  it("fills a 1920x1080 window with no blank strip, and keeps the HUD bottom-centre", async () => {
    const session = new BrowserSession({
      headless: false,
      overlay: {
        enabled: true, mode: "on", accent: "#3b82f6", typingEffect: false, waitCountdown: false,
        debugSeeElements: false, activityLog: true, cursorTrail: 0,
      },
    });
    try {
      const page = await session.getPage();
      expect(session.headless).toBe(false);
      await page.setContent("<body style='margin:0'>page</body>");
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: 1920, height: 1080 } });
      await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(1800);
      const dims = await page.evaluate(() => ({ inner: innerWidth, outer: outerWidth }));
      expect(dims.outer - dims.inner).toBeLessThanOrEqual(2);
      await session.getOverlay().setStatus(page, "Reading page");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const r = document.getElementById("__laya_overlay__")!.shadowRoot!.querySelector(".hud")!.getBoundingClientRect();
            return Math.round(Math.abs(r.left + r.width / 2 - innerWidth / 2)) + Math.round(Math.abs(innerHeight - r.bottom - 20));
          }),
        )
        .toBeLessThanOrEqual(2);
    } finally {
      await session.close();
    }
  });
});
