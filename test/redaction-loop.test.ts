/**
 * B1 secret redaction, exercised through the real Autopilot loop (headless chromium).
 *
 * Drives the login fixture's password field via a custom engine that types a known secret,
 * then asserts:
 *   - the transcript detail and the recorded value for the password step render the masked
 *     token and NOT the real password, and
 *   - the LIVE page input actually received the REAL password (automation is not weakened),
 *     verified via page.locator(...).inputValue().
 * A second run with redactSecrets:false confirms the value is NOT masked (opt-out).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { runGoal } from "../src/autopilot/loop.js";
import { renderRunResult } from "../src/tools/run_goal.js";
import { REDACTION_MASK } from "../src/redact.js";
import type { LayaDecisionEngine } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const SECRET = "hunter2-SuperSecret!";

/**
 * An engine that types the secret into the password field on the first step, then reports
 * DONE. Deterministic and independent of any weights.
 */
function typePasswordEngine(): LayaDecisionEngine {
  let typed = false;
  return {
    available: true,
    async decide(state) {
      const pwd = state.controls.find((c) => c.type === "password");
      if (pwd && !typed) {
        typed = true;
        return {
          operation: "TYPE_TEXT",
          operationConfidence: 0.99,
          target: pwd.ref,
          targetConfidence: 0.99,
          value: SECRET,
          source: "laya",
        };
      }
      return { operation: "DONE", operationConfidence: 1, targetConfidence: 1, source: "laya" };
    },
    async close() {},
  };
}

describe("B1 secret redaction through the loop (real chromium)", () => {
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

  it("masks the secret in the transcript/render while typing the real value into the field", async () => {
    const result = await runGoal({
      goal: "sign in",
      session,
      engine: typePasswordEngine(),
      url: fixtures.url("login.html"),
      maxSteps: 4,
      // redactSecrets defaults to true; assert the default masks.
    });

    const typeStep = result.transcript.find((s) => s.operation === "TYPE_TEXT");
    expect(typeStep).toBeDefined();

    // The recorded value + detail are masked, and never carry the real secret.
    expect(typeStep!.value).toBe(REDACTION_MASK);
    expect(typeStep!.detail).toContain(REDACTION_MASK);
    expect(typeStep!.detail).not.toContain(SECRET);
    expect(typeStep!.value).not.toContain(SECRET);

    // The rendered transcript block (what a client sees) also never carries the secret.
    const rendered = renderRunResult(result);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).toContain(REDACTION_MASK);

    // The LIVE input actually received the REAL password (automation not weakened).
    const page = await session.getPage();
    expect(await page.locator("#password").inputValue()).toBe(SECRET);
  });

  it("does NOT mask when redactSecrets is off (opt-out preserves prior behaviour)", async () => {
    const result = await runGoal({
      goal: "sign in",
      session,
      engine: typePasswordEngine(),
      url: fixtures.url("login.html"),
      maxSteps: 4,
      redactSecrets: false,
    });

    const typeStep = result.transcript.find((s) => s.operation === "TYPE_TEXT");
    expect(typeStep).toBeDefined();
    expect(typeStep!.value).toBe(SECRET);
    expect(typeStep!.detail).toContain(SECRET);

    const page = await session.getPage();
    expect(await page.locator("#password").inputValue()).toBe(SECRET);
  });
});
