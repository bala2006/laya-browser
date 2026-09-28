/**
 * Group A reliability tests (real headless chromium, no weights).
 *
 * Covers the three self-healing / reliability behaviours added to the Autopilot loop:
 *   A1  a stale ref is re-resolved by accessible name + role and the action still succeeds,
 *       recording `retries >= 1` on the step;
 *   A2  the purely-observational settle probe reports `changed=false` for a dead/no-op click
 *       and `changed=true` / `urlChanged=true` for a navigating action (no networkidle);
 *   A3  a rogue engine that repeats the identical CLICK on a static page bails early with the
 *       additive `stuck` outcome, well before the step budget is exhausted.
 *
 * These use small custom {@link LayaDecisionEngine} objects so the decision is fully
 * deterministic, mirroring the patterns in autopilot.test.ts / safety.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { runGoal, resolveByNameRole } from "../src/autopilot/loop.js";
import { capture } from "../src/snapshot.js";
import type { Decision, LayaDecisionEngine, PageState } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Find a control in a page state by exact role + accessible name. */
function refFor(state: PageState, role: string, name: string): string | undefined {
  return state.controls.find((c) => c.role === role && String(c.name) === name)?.ref;
}

describe("Autopilot reliability (Group A, real headless chromium)", () => {
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

  it("A1: self-heals a stale ref by name+role and records retries>=1", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("stale-ref.html"), { waitUntil: "domcontentloaded" });

    // The rogue engine targets the Confirm button ref as the loop OBSERVED it this step, then
    // rebuilds the target so that ref goes stale BEFORE execute() runs against it (the
    // replacement keeps the same name+role). The loop must re-resolve the identically-named
    // replacement button by name+role and click it.
    let rebuilt = false;
    const staleEngine: LayaDecisionEngine = {
      available: true,
      async decide(state: PageState): Promise<Decision> {
        const ref = refFor(state, "button", "Confirm")!;
        if (!rebuilt) {
          rebuilt = true;
          await page.evaluate(() => (window as unknown as { rebuildTarget: () => void }).rebuildTarget());
        }
        return {
          operation: "CLICK",
          operationConfidence: 1,
          target: ref,
          targetConfidence: 1,
          source: "laya",
        };
      },
      async close() {},
    };

    const result = await runGoal({
      goal: "confirm the choice",
      session,
      engine: staleEngine,
      maxSteps: 3,
      selfHealRetries: 1,
    });

    // The click ultimately succeeded against the re-resolved element.
    expect(await page.locator("#status").textContent()).toBe("confirmed");
    const click = result.transcript.find((s) => s.operation === "CLICK");
    expect(click).toBeDefined();
    expect(click?.retries).toBeGreaterThanOrEqual(1);
  });

  it("A1: resolveByNameRole re-resolves the fresh element after a rebuild", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("stale-ref.html"), { waitUntil: "domcontentloaded" });
    await page.evaluate(() => (window as unknown as { rebuildTarget: () => void }).rebuildTarget());
    const ref = await resolveByNameRole(session, page, "Confirm", "button");
    expect(ref).toBeDefined();
    // The resolved ref points at a live, clickable Confirm button.
    await session.resolveRef(ref!).click();
    expect(await page.locator("#status").textContent()).toBe("confirmed");
  });

  it("A2: settle probe reports changed=false for a dead/no-op click", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("dead-button.html"), { waitUntil: "domcontentloaded" });
    const state = await capture(page);
    const deadRef = refFor(state, "button", "Do nothing");
    expect(deadRef).toBeDefined();

    const beforeUrl = page.url();
    await session.resolveRef(deadRef!).click();
    const probe = await session.probeSettle(page, { beforeUrl });
    expect(probe.changed).toBe(false);
    expect(probe.urlChanged).toBe(false);
    expect(probe.mutations).toBe(0);
  });

  it("A2: settle probe reports urlChanged=true for a navigating click", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("nav-a.html"), { waitUntil: "domcontentloaded" });
    const state = await capture(page);
    const linkRef = refFor(state, "link", "Go to page B");
    expect(linkRef).toBeDefined();

    const beforeUrl = page.url();
    await session.resolveRef(linkRef!).click();
    const probe = await session.probeSettle(page, { beforeUrl });
    expect(probe.changed).toBe(true);
    expect(probe.urlChanged).toBe(true);
  });

  it("A2: records settled on step records during a run", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("dead-button.html"), { waitUntil: "domcontentloaded" });

    // A rogue engine that clicks the dead button once (targeting it as the loop OBSERVED it),
    // then declares DONE, so the run has a single non-terminal CLICK step whose settle probe
    // should observe no change.
    let clicked = false;
    const engine: LayaDecisionEngine = {
      available: true,
      async decide(state: PageState): Promise<Decision> {
        if (!clicked) {
          clicked = true;
          return {
            operation: "CLICK",
            operationConfidence: 1,
            target: refFor(state, "button", "Do nothing")!,
            targetConfidence: 1,
            source: "laya",
          };
        }
        return {
          operation: "DONE",
          operationConfidence: 1,
          targetConfidence: 1,
          source: "laya",
        };
      },
      async close() {},
    };

    const result = await runGoal({
      goal: "do nothing on this page",
      session,
      engine,
      maxSteps: 4,
      // Loop detection off here so the two distinct steps (CLICK then DONE) run cleanly.
      loopDetection: false,
    });
    const click = result.transcript.find((s) => s.operation === "CLICK");
    expect(click?.settled).toBe(false);
  });

  it("A3: a rogue always-same-CLICK engine bails with outcome 'stuck' before maxSteps", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("loop-trap.html"), { waitUntil: "domcontentloaded" });

    // Always chooses the identical CLICK (targeting the button as the loop OBSERVED it) on a
    // page that never changes.
    const rogue: LayaDecisionEngine = {
      available: true,
      async decide(state: PageState): Promise<Decision> {
        return {
          operation: "CLICK",
          operationConfidence: 1,
          target: refFor(state, "button", "Spin forever")!,
          targetConfidence: 1,
          source: "laya",
        };
      },
      async close() {},
    };

    const maxSteps = 15;
    const result = await runGoal({
      goal: "keep spinning forever",
      session,
      engine: rogue,
      maxSteps,
      loopDetection: true,
      loopWindow: 3,
    });

    expect(result.outcome).toBe("stuck");
    // Bailed well before the full budget was burned.
    expect(result.transcript.length).toBeLessThan(maxSteps);
    const last = result.transcript.at(-1);
    expect(last?.operation).toBe("BLOCKED");
    expect(last?.detail).toContain("stuck");
  });

  it("A3: loop detection off lets the run use its full budget", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("loop-trap.html"), { waitUntil: "domcontentloaded" });

    const rogue: LayaDecisionEngine = {
      available: true,
      async decide(state: PageState): Promise<Decision> {
        return {
          operation: "CLICK",
          operationConfidence: 1,
          target: refFor(state, "button", "Spin forever")!,
          targetConfidence: 1,
          source: "laya",
        };
      },
      async close() {},
    };

    const maxSteps = 4;
    const result = await runGoal({
      goal: "keep spinning forever",
      session,
      engine: rogue,
      maxSteps,
      loopDetection: false,
    });
    // Without loop detection the run exhausts its budget instead of bailing as stuck.
    expect(result.outcome).toBe("max_steps");
    expect(result.transcript.length).toBe(maxSteps);
  });
});
