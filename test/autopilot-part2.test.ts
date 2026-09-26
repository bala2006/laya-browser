/**
 * Part 2 (FEAT-007): faster automation via the broadened operation set.
 *
 * All offline, driving REAL headless Chromium against local HTML fixtures with the
 * StubEngine (or a tiny custom engine that returns a single scripted decision). Proves:
 *   (a) a multi-field goal completes via ONE FILL_FORM batch in FEWER steps than the
 *       per-field TYPE_TEXT path, with each field's DOM value asserted;
 *   (b) HOVER, NAVIGATE_BACK, PRESS_KEY execute and change the page;
 *   (c) SCREENSHOT and VERIFY terminal steps record a result;
 *   (d) an UnavailableEngine still degrades gracefully (degraded=true);
 *   (e) a rule-vs-laya/stub-vs-escalation breakdown + wall-clock is reported.
 *
 * The real-weights suite stays gated behind LAYA_MODEL_DIR in test/autopilot.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { StubEngine, UnavailableEngine } from "../src/laya/index.js";
import { runGoal } from "../src/autopilot/loop.js";
import { runBenchmark, formatSummaryTable } from "./benchmark/harness.js";
import type { Control, Decision, LayaDecisionEngine, PageState } from "../src/types.js";
import { asRef } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** A one-shot engine that returns a scripted decision built from the live PageState. */
function scriptedEngine(pick: (state: PageState) => Decision): LayaDecisionEngine {
  return {
    available: true,
    async decide(state: PageState): Promise<Decision> {
      return pick(state);
    },
    async close() {},
  };
}

/** Find a control by a substring of its accessible name (case-insensitive). */
function byName(state: PageState, name: string): Control | undefined {
  const needle = name.toLowerCase();
  return state.controls.find((c) => c.name.toLowerCase().includes(needle));
}

describe("Autopilot Part 2: faster automation (real headless chromium, StubEngine)", () => {
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

  it("completes a multi-field login goal via ONE FILL_FORM batch, in fewer steps", async () => {
    const engine = new StubEngine();
    const result = await runGoal({
      goal:
        'email is "user@example.com" and password is "hunter2" and expect "Signed in as user@example.com"',
      session,
      engine,
      url: fixtures.url("login.html"),
      maxSteps: 8,
    });

    expect(result.outcome).toBe("done");
    expect(result.verification.verified).toBe(true);

    // Exactly ONE FILL_FORM step, filling BOTH fields in a single batch.
    const fillSteps = result.transcript.filter((s) => s.operation === "FILL_FORM");
    expect(fillSteps.length).toBe(1);
    expect(fillSteps[0]?.fields?.length).toBe(2);
    // No per-field TYPE_TEXT steps were emitted (the batch replaced them).
    expect(result.transcript.some((s) => s.operation === "TYPE_TEXT")).toBe(false);
    // One CLICK to submit after the batch.
    expect(result.transcript.some((s) => s.operation === "CLICK")).toBe(true);

    // The batch path is FEWER steps than the per-field path (2 typed fields would be
    // TYPE_TEXT + TYPE_TEXT + CLICK = 3; the batch is FILL_FORM + CLICK = 2, then DONE).
    const actionSteps = result.transcript.filter(
      (s) => s.operation !== "DONE" && s.operation !== "BLOCKED",
    ).length;
    const perFieldSteps = 2 /* TYPE_TEXT x2 */ + 1 /* CLICK */;
    expect(actionSteps).toBeLessThan(perFieldSteps);

    // The real DOM literally reflects both filled fields and the signed-in outcome.
    const page = await session.getPage();
    expect(await page.locator("#email").inputValue()).toBe("user@example.com");
    expect(await page.locator("#password").inputValue()).toBe("hunter2");
    expect(await page.locator("#status").textContent()).toBe(
      "Signed in as user@example.com",
    );
  });

  it("keeps the single-field path (no FILL_FORM) for a one-field goal", async () => {
    const engine = new StubEngine();
    const result = await runGoal({
      goal: 'email is "solo@example.com" and expect "Signed in as solo@example.com"',
      session,
      engine,
      url: fixtures.url("login.html"),
      maxSteps: 8,
    });
    expect(result.outcome).toBe("done");
    // One field -> a plain TYPE_TEXT, never a batch.
    expect(result.transcript.some((s) => s.operation === "TYPE_TEXT")).toBe(true);
    expect(result.transcript.some((s) => s.operation === "FILL_FORM")).toBe(false);
  });

  it("executes HOVER and changes the page", async () => {
    const engine = scriptedEngine((state) => {
      const trigger = byName(state, "hover me");
      if (!trigger) {
        return {
          operation: "BLOCKED",
          operationConfidence: 1,
          targetConfidence: 1,
          source: "laya",
        };
      }
      return {
        operation: "HOVER",
        operationConfidence: 1,
        target: trigger.ref,
        targetConfidence: 1,
        source: "laya",
      };
    });
    const result = await runGoal({
      goal: "hover the trigger and expect hovered",
      session,
      engine,
      url: fixtures.url("hover.html"),
      maxSteps: 3,
    });
    const hover = result.transcript.find((s) => s.operation === "HOVER");
    expect(hover).toBeDefined();
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("hovered");
  });

  it("executes PRESS_KEY and changes the page", async () => {
    // Script a single PRESS_KEY Enter, then let the loop stop on the budget.
    const engine = scriptedEngine(() => ({
      operation: "PRESS_KEY",
      operationConfidence: 1,
      targetConfidence: 1,
      key: "Enter",
      source: "laya",
    }));
    const result = await runGoal({
      goal: "press enter to submit",
      session,
      engine,
      url: fixtures.url("keyboard.html"),
      maxSteps: 1,
    });
    const press = result.transcript.find((s) => s.operation === "PRESS_KEY");
    expect(press?.key).toBe("Enter");
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("submitted");
  });

  it("executes NAVIGATE_BACK and returns to the previous page", async () => {
    const page = await session.getPage();
    // Start on A, navigate to B, then let the loop go back to A.
    await page.goto(fixtures.url("nav-a.html"), { waitUntil: "domcontentloaded" });
    await page.goto(fixtures.url("nav-b.html"), { waitUntil: "domcontentloaded" });
    expect(await page.locator("#marker").textContent()).toBe("This is page B");

    const engine = scriptedEngine(() => ({
      operation: "NAVIGATE_BACK",
      operationConfidence: 1,
      targetConfidence: 1,
      source: "laya",
    }));
    const result = await runGoal({
      goal: "go back to the previous page",
      session,
      engine,
      maxSteps: 1,
    });
    expect(result.transcript.some((s) => s.operation === "NAVIGATE_BACK")).toBe(true);
    expect(await page.locator("#marker").textContent()).toBe("This is page A");
  });

  it("records a VERIFY terminal step result against the live page", async () => {
    const engine = scriptedEngine(() => ({
      operation: "VERIFY",
      operationConfidence: 1,
      targetConfidence: 1,
      marker: "This is page A",
      source: "laya",
    }));
    const page = await session.getPage();
    await page.goto(fixtures.url("nav-a.html"), { waitUntil: "domcontentloaded" });
    const result = await runGoal({
      goal: "verify page A loaded",
      session,
      engine,
      maxSteps: 3,
    });
    const verify = result.transcript.find((s) => s.operation === "VERIFY");
    expect(verify).toBeDefined();
    expect(verify?.marker).toBe("This is page A");
    expect(verify?.verified).toBe(true);
    // VERIFY is terminal: it is the last step.
    expect(result.transcript.at(-1)?.operation).toBe("VERIFY");
  });

  it("records a SCREENSHOT terminal step", async () => {
    const engine = scriptedEngine(() => ({
      operation: "SCREENSHOT",
      operationConfidence: 1,
      targetConfidence: 1,
      source: "laya",
    }));
    const page = await session.getPage();
    await page.goto(fixtures.url("nav-a.html"), { waitUntil: "domcontentloaded" });
    const result = await runGoal({
      goal: "capture the page",
      session,
      engine,
      maxSteps: 3,
    });
    const shot = result.transcript.find((s) => s.operation === "SCREENSHOT");
    expect(shot).toBeDefined();
    expect(shot?.verified).toBe(true);
    expect(result.transcript.at(-1)?.operation).toBe("SCREENSHOT");
  });

  it("still degrades gracefully with an UnavailableEngine (degraded=true)", async () => {
    const engine = new UnavailableEngine();
    const result = await runGoal({
      goal:
        'email is "user@example.com" and password is "hunter2" and expect "Signed in"',
      session,
      engine,
      url: fixtures.url("login.html"),
    });
    expect(result.degraded).toBe(true);
    expect(result.outcome).toBe("degraded");
    expect(result.transcript.length).toBe(0);
  });

  it("reports the rule/laya/stub/llm breakdown + timing and PROVES the batch is faster", async () => {
    const results = await runBenchmark({ makeEngine: () => new StubEngine() });
    // eslint-disable-next-line no-console
    console.log("\n" + formatSummaryTable(results, "StubEngine (Part 2)") + "\n");

    const single = results.find((r) => r.name === "login");
    const multi = results.find((r) => r.name === "login-multi");
    expect(single).toBeDefined();
    expect(multi).toBeDefined();

    // The multi-field case used the batch: exactly one FILL_FORM, no TYPE_TEXT.
    expect(multi!.executedOps.filter((o) => o === "FILL_FORM").length).toBe(1);
    expect(multi!.executedOps.includes("TYPE_TEXT")).toBe(false);
    expect(multi!.success).toBe(true);

    // Every step was resolved LOCALLY by the deterministic rule layer (no escalation).
    expect(multi!.sourceCounts.llm).toBe(0);
    expect(multi!.sourceCounts.rule).toBeGreaterThan(0);

    // A hypothetical per-field run of the same TWO fields would be TYPE_TEXT + TYPE_TEXT +
    // CLICK (+ DONE); the batch run is FILL_FORM + CLICK (+ DONE): strictly fewer steps.
    const perFieldEquivalent = 2 + 1 + 1;
    expect(multi!.steps).toBeLessThan(perFieldEquivalent);
    expect(multi!.wallMs).toBeGreaterThanOrEqual(0);
  });
});
