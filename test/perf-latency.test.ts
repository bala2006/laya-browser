/**
 * Performance budget (Group P, real headless chromium).
 *
 * These guard the LATENCY work, not correctness:
 *
 *   P1 the settle probe answers as soon as the page is quiet instead of always sleeping its
 *      full cap — but a page that is still mutating keeps the probe observing, so the
 *      "did anything change" signal is never lost;
 *   P2 the per-step HUD narration stays inside a round-trip budget, because every narration
 *      call used to cost its own `page.evaluate` (~13 per step, ~1.4ms of pure round-trip each
 *      before any in-page work happened).
 *
 * Every assertion here fails against the pre-optimisation behaviour: the probe measured
 * 407–420ms on a page that had already settled, and a step cost ~13 round-trips.
 *
 * They are deliberately measurement-shaped (counts, plus a loose wall-clock bound) so they catch
 * a real regression without being flaky on a slow machine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrowserSession,
  DEFAULT_SETTLE_PROBE_MS,
  DEFAULT_SETTLE_QUIET_MS,
} from "../src/browser.js";
import { BrowserOverlay } from "../src/overlay.js";
import type { OverlayConfig } from "../src/config.js";
import { runGoal } from "../src/autopilot/loop.js";
import { StubEngine } from "../src/laya/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** The overlay root id, as injected by the client script. */
const OVERLAY_ROOT = "#__laya_overlay__";

/**
 * Budget for overlay round-trips per step. The pre-optimisation figure was ~13; batching the
 * calls a step emits back-to-back brings it under this. Set with headroom so a slow machine or a
 * slightly different transcript cannot make it flaky, while still failing on a real regression
 * (e.g. reverting the batching).
 */
const ROUND_TRIP_BUDGET_PER_STEP = 10;

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

describe("P1 settle probe resolves on quiescence (real headless chromium)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
  });
  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  /** Time one probe run. */
  async function timedProbe(
    page: Parameters<BrowserSession["probeSettle"]>[0],
    options: { timeoutMs?: number; beforeUrl?: string; quietMs?: number },
  ): Promise<{ ms: number; probe: Awaited<ReturnType<BrowserSession["probeSettle"]>> }> {
    const started = performance.now();
    const probe = await session.probeSettle(page, options);
    return { ms: performance.now() - started, probe };
  }

  it("answers as soon as the page is quiet, rather than waiting out the cap", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("search-form.html"), { waitUntil: "domcontentloaded" });
    // Let the load itself settle, so we time the probe and not the page.
    await page.waitForTimeout(300);

    // CONTROL: the same probe on the same page with the early exit disabled — that is exactly
    // the old behaviour, and it has to wait out the whole window.
    const control = await timedProbe(page, { beforeUrl: page.url(), quietMs: 0 });
    const actual = await timedProbe(page, { beforeUrl: page.url() });

    // Semantics unchanged: a page that did nothing still reports "no change".
    expect(actual.probe.changed).toBe(false);
    expect(actual.probe.mutations).toBe(0);
    expect(control.probe.changed).toBe(false);

    // Asserted RELATIVE to the control rather than against a wall-clock constant: a slow or
    // heavily loaded machine inflates both measurements together, so the ratio stays honest.
    // The quiet exit is a large structural fraction faster — not a few percent — and a revert
    // (both runs taking the full cap) fails this outright.
    expect(actual.ms).toBeLessThan(control.ms * 0.6);
    // Belt and braces, in the same spirit: it must at least beat the configured cap.
    expect(actual.ms).toBeLessThan(DEFAULT_SETTLE_PROBE_MS);
    // ...and it should not be instant, i.e. it really did observe a quiet period.
    expect(actual.ms).toBeGreaterThanOrEqual(DEFAULT_SETTLE_QUIET_MS * 0.5);
  });

  it("keeps observing a page that is still mutating, and still sees the change", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("search-form.html"), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(200);

    // Mutate every 60ms for ~300ms. A probe that answered at the FIRST quiet gap would return
    // long before the mutations stopped (and, depending on timing, could miss the change).
    await page.evaluate(() => {
      let n = 0;
      const id = window.setInterval(() => {
        n += 1;
        document.body.setAttribute("data-perf-tick", String(n));
        if (n >= 5) window.clearInterval(id);
      }, 60);
    });

    const started = performance.now();
    const probe = await session.probeSettle(page, { beforeUrl: page.url() });
    const elapsed = performance.now() - started;

    expect(probe.changed).toBe(true);
    expect(probe.mutations).toBeGreaterThan(0);
    // It waited for the activity to stop rather than exiting at the first quiet gap.
    expect(elapsed).toBeGreaterThan(200);
  });

  it("quietMs: 0 restores the fixed-window behaviour exactly", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("search-form.html"), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(200);

    const started = performance.now();
    await session.probeSettle(page, { beforeUrl: page.url(), timeoutMs: 250, quietMs: 0 });
    const elapsed = performance.now() - started;

    // The escape hatch really does wait out the whole window.
    expect(elapsed).toBeGreaterThanOrEqual(240);
  });
});

describe("P2 batched HUD narration (real headless chromium, overlay forced on)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let roundTrips = 0;
  let restoreInvoke: (() => void) | undefined;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true, overlay: overlayOn() });
    // Instrumented HERE, not inside a test: otherwise running a single test with `-t` would
    // leave the counter unwired and the budget assertion would pass vacuously on 0 round-trips.
    instrument();
  });
  afterAll(async () => {
    restoreInvoke?.();
    await session.close();
    await fixtures.close();
  });

  /**
   * Count the ACTUAL overlay round-trips. Every server-side narration call funnels through the
   * (private at the type level, real at runtime) `invoke`, so wrapping it counts exactly one per
   * `page.evaluate` the HUD performs — the precise quantity the batching reduces.
   */
  function instrument(): void {
    const proto = BrowserOverlay.prototype as unknown as Record<
      string,
      (...args: unknown[]) => Promise<void>
    >;
    const original = proto.invoke;
    proto.invoke = function (this: BrowserOverlay, ...args: unknown[]) {
      roundTrips += 1;
      return original.apply(this, args);
    };
    restoreInvoke = () => {
      proto.invoke = original;
    };
  }

  it("applies a whole batched HUD update in ONE round-trip", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
    const overlay = session.getOverlay();

    const before = roundTrips;
    await overlay.callBatch(page, [
      ["setState", "error"],
      ["setStatus", "batched status line"],
      ["progress", 2, 7],
    ]);
    expect(roundTrips - before).toBe(1);

    // The batching must not change what the HUD ends up showing.
    const dom = await page.evaluate((sel) => {
      const host = document.querySelector(sel) as HTMLElement | null;
      const root = host?.shadowRoot;
      return {
        narration: root?.querySelector(".hud .narration")?.getAttribute("data-text") ?? "",
        progress: root?.querySelector(".hud .progress-text")?.textContent ?? "",
        tone: host?.getAttribute("data-tone") ?? "",
      };
    }, OVERLAY_ROOT);
    expect(dom.narration).toBe("batched status line");
    expect(dom.progress).toBe("2/7");
    // The error tone proves the batched setState really ran.
    expect(dom.tone).toBe("error");
  });

  it("keeps a whole run inside the per-step round-trip budget", async () => {
    const page = await session.getPage();
    roundTrips = 0;
    const result = await runGoal({
      goal: 'search for "laptops" and expect "Showing results for laptops"',
      session,
      engine: new StubEngine(),
      url: fixtures.url("search-form.html"),
      maxSteps: 8,
      overlay: session.getOverlay(),
      overlayPage: page,
    });

    const steps = result.transcript.length;
    expect(result.verification.verified).toBe(true);
    expect(steps).toBeGreaterThan(0);

    const perStep = roundTrips / steps;
    // eslint-disable-next-line no-console
    console.log(
      `P2 narration round-trips: ${roundTrips} over ${steps} steps = ${perStep.toFixed(1)}/step ` +
        `(budget ${ROUND_TRIP_BUDGET_PER_STEP}; pre-batching was ~13/step)`,
    );
    expect(perStep).toBeLessThanOrEqual(ROUND_TRIP_BUDGET_PER_STEP);
  });
});
