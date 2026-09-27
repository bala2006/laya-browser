/**
 * Lightweight timing probes to QUANTIFY the Tier 1/4 optimizations (informational; not a
 * pass/fail gate beyond a loose sanity bound). Prints numbers used in the PR summary.
 *
 *  - T4.1: overlapping the settle probe with the next-step capture vs. doing them serially.
 *  - T1.1: the escalation prompt's stable prefix is identical across steps (cache-reusable).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { BrowserSession } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import {
  ESCALATION_PROMPT_PREFIX,
  buildEscalationPrompt,
} from "../src/autopilot/escalation.js";
import type { PageState } from "../src/types.js";
import { asRef } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

describe("Tier 1/4 timing probes (real headless chromium)", () => {
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

  it("T4.1: settle+capture overlapped is no slower than serial (and typically faster)", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("big-text.html"), { waitUntil: "domcontentloaded" });
    const beforeUrl = page.url();

    // Serial: probe THEN capture.
    const s0 = performance.now();
    for (let i = 0; i < 3; i++) {
      await session.probeSettle(page, { beforeUrl, timeoutMs: 120 });
      await capture(page);
    }
    const serialMs = performance.now() - s0;

    // Overlapped: probe and capture together (the loop's T4.1 pattern).
    const p0 = performance.now();
    for (let i = 0; i < 3; i++) {
      await Promise.all([
        session.probeSettle(page, { beforeUrl, timeoutMs: 120 }),
        capture(page),
      ]);
    }
    const overlapMs = performance.now() - p0;

    // eslint-disable-next-line no-console
    console.log(
      `T4.1 perception: serial=${serialMs.toFixed(0)}ms overlapped=${overlapMs.toFixed(0)}ms ` +
        `(saved ~${(serialMs - overlapMs).toFixed(0)}ms over 3 iters)`,
    );
    // Overlapping hides the capture cost inside the probe window, so it should not be slower
    // by more than measurement noise.
    expect(overlapMs).toBeLessThan(serialMs + 150);
  });

  it("T1.1: the escalation prompt's stable prefix is byte-identical across differing states", () => {
    const mk = (goal: string): PageState => ({
      goal,
      url: "http://x/" + goal,
      title: goal,
      visibleText: "state for " + goal,
      controls: [
        { ref: asRef("e1"), index: 1, role: "button", name: goal, tag: "button", editable: false },
      ],
      recentActions: [],
    });
    const a = buildEscalationPrompt(mk("alpha"));
    const b = buildEscalationPrompt(mk("beta different page entirely"));
    // Both prompts share the exact same leading prefix (cache-reusable tokens).
    expect(a.startsWith(ESCALATION_PROMPT_PREFIX)).toBe(true);
    expect(b.startsWith(ESCALATION_PROMPT_PREFIX)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `T1.1 stable prefix length: ${ESCALATION_PROMPT_PREFIX.length} chars ` +
        `(~${Math.ceil(ESCALATION_PROMPT_PREFIX.length / 4)} tokens reused per escalation)`,
    );
  });
});
