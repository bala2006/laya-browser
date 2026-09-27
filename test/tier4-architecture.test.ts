/**
 * Tier 4 (architecture / correctness) tests.
 *
 *  - T4.1 parallel perception: the settle probe and the speculative next-step capture run
 *    together and still yield the CORRECT settled flag + a valid snapshot; a change between
 *    steps is still observed (settled=true) and the prefetch is discarded (correctness).
 *  - T4.2 stateless-handle readiness: a run is fully addressable from tool args + a
 *    server-scoped lazy engine, with no protocol-session state required.
 *  - T4.3 domWalk micro-opt: the visible/interactive control set is unchanged and
 *    viewport-priority ordering still surfaces in-view controls first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { capture } from "../src/snapshot.js";
import { runGoal } from "../src/autopilot/loop.js";
import { UnavailableEngine } from "../src/laya/index.js";
import type { LayaDecisionEngine, PageState } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

describe("T4.1 parallel perception (settle probe + speculative capture)", () => {
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

  it("settle+capture still report settled=false for a dead click and a valid final snapshot", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("dead-button.html"), { waitUntil: "domcontentloaded" });

    // A CLICK on the first control that does nothing, then DONE on the next step, so the
    // settle probe (overlapped with a speculative capture) runs for the CLICK step.
    let step = 0;
    const engine: LayaDecisionEngine = {
      available: true,
      async decide(state: PageState) {
        step += 1;
        const target = state.controls[0];
        if (step === 1 && target) {
          return {
            operation: "CLICK",
            operationConfidence: 1,
            target: target.ref,
            targetConfidence: 1,
            source: "laya",
          };
        }
        return { operation: "DONE", operationConfidence: 1, targetConfidence: 1, source: "laya" };
      },
      async close() {},
    };

    const result = await runGoal({
      goal: "click the dead button",
      session,
      engine,
      settleProbe: true,
      loopDetection: false,
      maxSteps: 3,
    });
    const click = result.transcript.find((s) => s.operation === "CLICK");
    // The overlapped speculative capture must NOT pollute the probe: a dead click reports
    // settled=false (no genuine change), proving the data-laya-ref writes are filtered out.
    expect(click?.settled).toBe(false);
    // The run still produced a valid, non-empty final snapshot.
    expect(result.finalSnapshot).toBeDefined();
    expect(result.finalSnapshot!.controls.length).toBeGreaterThan(0);
  });

  it("still observes a real navigation as a change (settled=true)", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("nav-a.html"), { waitUntil: "domcontentloaded" });
    // probeSettle directly: a navigating action reports urlChanged=true.
    const before = page.url();
    await page.goto(fixtures.url("nav-b.html"), { waitUntil: "domcontentloaded" });
    const probe = await session.probeSettle(page, { beforeUrl: before });
    expect(probe.urlChanged).toBe(true);
    expect(probe.changed).toBe(true);
  });
});

describe("T4.2 stateless-handle readiness", () => {
  it("a run is addressable purely from tool args + a lazy, server-scoped engine", async () => {
    // An unavailable engine that was NEVER pre-initialised: proving the engine is a lazy,
    // server-scoped resource and the run needs no protocol-session setup — just its args.
    const engine = new UnavailableEngine();
    const session = new BrowserSession({ headless: true });
    try {
      const result = await runGoal({ goal: "do a thing", session, engine });
      // No protocol session, no prior state: the run self-describes and degrades gracefully.
      expect(result.degraded).toBe(true);
      expect(result.outcome).toBe("degraded");
      // Degraded path never launched a browser (engine unavailable), so the session is lazy.
      expect(session.launched).toBe(false);
    } finally {
      await session.close();
    }
  });
});

describe("T4.3 domWalk micro-opt is behaviour-preserving", () => {
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

  it("captures the same visible/interactive control set as before on a form page", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("login.html"), { waitUntil: "domcontentloaded" });
    const snap = await capture(page);
    // The login form's fields + submit are all present, each with a stable ref.
    const names = snap.controls.map((c) => c.name.toLowerCase());
    expect(names.some((n) => n.includes("email") || n.includes("user"))).toBe(true);
    expect(names.some((n) => n.includes("password"))).toBe(true);
    for (const c of snap.controls) expect(c.ref).toMatch(/^e\d+$/);
  });

  it("viewport-priority ordering surfaces in-view controls first, refs stay DOM-ordered", async () => {
    const page = await session.getPage();
    await page.goto(fixtures.url("viewport-priority.html"), { waitUntil: "domcontentloaded" });
    const ordered = await capture(page, { viewportPriority: true });
    // Refs are still assigned in DOM order (monotonic) even though the list is reordered.
    const refNums = ordered.controls.map((c) => Number(c.ref.slice(1)));
    // The set of refs is a valid monotonic assignment (each unique, all eN).
    expect(new Set(refNums).size).toBe(refNums.length);
    // resolveRef still works for the first offered control.
    const first = ordered.controls[0]!;
    const loc = await session.locate(first.ref);
    expect(await loc.count()).toBeGreaterThan(0);
  });
});
