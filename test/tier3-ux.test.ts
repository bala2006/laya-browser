/**
 * Tier 3 (UX / feedback) tests.
 *
 *  - T3.1 live token/step-cost meter: driving the overlay renders a meter DOM node showing
 *    step / LLM-escalation / token counts.
 *  - T3.3 replay HTML viewer: the exported HTML is a non-empty, self-contained scrubber that
 *    contains a per-step screenshot and the step's decision.
 *  - T3.4 cursor trail: moveCursor with a trail length leaves fading breadcrumb dots.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.js";
import { BrowserOverlay } from "../src/overlay.js";
import type { OverlayConfig } from "../src/config.js";
import * as exportRun from "../src/tools/export_run.js";
import type { ExportRunContext } from "../src/tools/export_run.js";
import { createRunArtifactsHolder } from "../src/tools/run_artifacts.js";
import type { RunStepArtifact } from "../src/autopilot/loop.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

function overlayOn(overrides: Partial<OverlayConfig> = {}): OverlayConfig {
  return {
    enabled: true,
    mode: "on",
    accent: "#3b82f6",
    typingEffect: false,
    waitCountdown: false,
    debugSeeElements: false,
    activityLog: true,
    cursorTrail: 6,
    ...overrides,
  };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("T3.1/T3.4 overlay meter + cursor trail (real headless chromium, overlay forced on)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    // Overlay forced ON so it injects even headless (mirrors overlay.test.ts).
    session = new BrowserSession({ headless: true, overlay: overlayOn() });
  });
  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("renders the token/step-cost meter with step, LLM, and token counts", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
    const overlay: BrowserOverlay = session.getOverlay();

    await overlay.meter(page, 3, 1, 1500);
    const meterText = await page.evaluate(
      () =>
        document.getElementById("__laya_overlay__")?.shadowRoot?.querySelector("[data-laya-meter]")
          ?.textContent ?? "",
    );
    expect(meterText).toContain("3 steps");
    expect(meterText).toContain("1 LLM");
    // 1500 tokens renders compactly as ~1.5k.
    expect(meterText).toContain("1.5k");
  });

  it("draws a breadcrumb trail between two cursor positions", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
    const overlay: BrowserOverlay = session.getOverlay();

    // First move sets the anchor (no trail yet), second move draws the trail dots.
    await overlay.moveCursor(page, 50, 50, "", 6);
    await overlay.moveCursor(page, 300, 300, "Filling field", 6);
    // Count trail dots present immediately after the move (they fade out over ~0.5s).
    const dotCount = await page.evaluate(
      () =>
        document.getElementById("__laya_overlay__")?.shadowRoot?.querySelectorAll(".trail").length ?? 0,
    );
    expect(dotCount).toBeGreaterThan(0);
  });
});

describe("T3.3 self-contained scrubbable replay HTML export", () => {
  it("writes a non-empty self-contained HTML replay with per-step screenshot + decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laya-replay-"));
    try {
      const steps: RunStepArtifact[] = [
        {
          step: 1,
          operation: "CLICK",
          target: "e5",
          operationConfidence: 0.92,
          targetConfidence: 0.88,
          source: "laya",
          detail: 'CLICK e5 (button "Sign in")',
          durationMs: 42,
          snapshot: "URL: http://x/\nTitle: Sign in\n- button \"Sign in\" [ref=e5]",
          // A 1x1 transparent PNG (base64) so the viewer has a real embedded screenshot.
          screenshotPng:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ];
      const holder = createRunArtifactsHolder();
      holder.last = {
        goal: "sign in",
        outcome: "done",
        finishedAt: new Date().toISOString(),
        steps,
      };
      const ctx = { session: {} as never, artifacts: holder } as ExportRunContext;
      const res = await exportRun.makeHandler(ctx)({
        path: join(dir, "replay.html"),
        format: "html",
      });
      expect(res.isError).toBeFalsy();

      const html = await readFile(join(dir, "replay.html"), "utf8");
      expect(html.length).toBeGreaterThan(500);
      // Self-contained: no external script/style/link references.
      expect(html).not.toMatch(/<script[^>]+src=/i);
      expect(html).not.toMatch(/<link[^>]+href=/i);
      // Scrubber controls + inlined data + per-step screenshot + decision.
      expect(html).toContain('id="scrub"');
      expect(html).toContain("laya-run-data");
      expect(html).toContain("data:image/png;base64");
      expect(html).toContain("CLICK");
      expect(html).toContain("Sign in");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports no run recorded when the holder is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laya-replay-empty-"));
    try {
      const ctx = {
        session: {} as never,
        artifacts: createRunArtifactsHolder(),
      } as ExportRunContext;
      const res = await exportRun.makeHandler(ctx)({ path: dir });
      expect(textOf(res)).toContain("No Autopilot run has been recorded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
