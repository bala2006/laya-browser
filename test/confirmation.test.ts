/**
 * B2 human-in-the-loop confirmation hook, exercised through the loop (real chromium).
 *
 * Reuses delete-account.html and a custom engine that wants to CLICK "Delete account" (which
 * the destructive-form guard refuses by default). Asserts:
 *   - confirmDestructive + a confirm callback that APPROVES -> the CLICK proceeds, the page
 *     mutates, the outcome is not blocked, and the step records "approved via confirmation";
 *   - a confirm callback that REFUSES -> the run stays blocked and the page is NOT mutated;
 *   - confirm ABSENT (even with confirmDestructive on) -> refuse-by-default is preserved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { runGoal } from "../src/autopilot/loop.js";
import type { LayaDecisionEngine } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** An engine that clicks the "Delete account" button once, then reports DONE. */
function clickDeleteEngine(): LayaDecisionEngine {
  let clicked = false;
  return {
    available: true,
    async decide(state) {
      const del = state.controls.find((c) => /delete/i.test(c.name));
      if (del && !clicked) {
        clicked = true;
        return {
          operation: "CLICK",
          operationConfidence: 0.99,
          target: del.ref,
          targetConfidence: 0.99,
          source: "laya",
        };
      }
      return { operation: "DONE", operationConfidence: 1, targetConfidence: 1, source: "laya" };
    },
    async close() {},
  };
}

describe("B2 confirmation hook through the loop (real chromium)", () => {
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

  it("proceeds with the destructive CLICK when confirm approves, and records approval", async () => {
    let asked = "";
    const result = await runGoal({
      goal: "delete the account",
      session,
      engine: clickDeleteEngine(),
      url: fixtures.url("delete-account.html"),
      maxSteps: 4,
      confirmDestructive: true,
      confirm: async (prompt) => {
        asked = prompt;
        return true;
      },
    });

    // The run was NOT blocked: the CLICK executed after approval.
    expect(result.outcome).not.toBe("blocked");
    // The prompt named the target control.
    expect(asked).toContain("Delete account");
    // The approval is recorded on the CLICK step.
    const clickStep = result.transcript.find((s) => s.operation === "CLICK");
    expect(clickStep).toBeDefined();
    expect(clickStep!.note).toContain("approved via confirmation");
    // The page was mutated by the approved click.
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("Account deleted");
  });

  it("stays blocked and does not mutate the page when confirm refuses", async () => {
    const result = await runGoal({
      goal: "delete the account",
      session,
      engine: clickDeleteEngine(),
      url: fixtures.url("delete-account.html"),
      maxSteps: 4,
      confirmDestructive: true,
      confirm: async () => false,
    });

    expect(result.outcome).toBe("blocked");
    const last = result.transcript.at(-1);
    expect(last?.operation).toBe("BLOCKED");
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("Account active");
  });

  it("(R3) asks even without confirmDestructive, instead of hard-blocking the goal", async () => {
    // The flag used to gate the ask, so a client that COULD be asked was still hard-blocked
    // unless an operator flipped a separate switch. The ask now follows the confirm callback
    // alone, which is what makes a goal able to finish a destructive submit autonomously.
    let asked = "";
    const result = await runGoal({
      goal: "delete the account",
      session,
      engine: clickDeleteEngine(),
      url: fixtures.url("delete-account.html"),
      maxSteps: 4,
      // confirmDestructive deliberately NOT set.
      confirm: async (prompt) => {
        asked = prompt;
        return true;
      },
    });

    expect(asked).toContain("Delete account");
    expect(result.outcome).not.toBe("blocked");
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("Account deleted");
  });

  it("preserves refuse-by-default when confirm is absent (even with confirmDestructive on)", async () => {
    const result = await runGoal({
      goal: "delete the account",
      session,
      engine: clickDeleteEngine(),
      url: fixtures.url("delete-account.html"),
      maxSteps: 4,
      confirmDestructive: true,
      // no confirm callback supplied.
    });

    expect(result.outcome).toBe("blocked");
    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe("Account active");
  });
});
