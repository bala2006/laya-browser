/**
 * (R2) Autonomy without local weights.
 *
 * The goal command used to refuse outright whenever the Laya engine had no weights, so a goal
 * could not run at all until a ~1.7GB model bundle was in place. These tests assert the new
 * contract against the REAL page and the REAL independent verification, not a self-report:
 *   - with no engine but a client that can plan, the run completes and the final-page check
 *     passes, with every executed step sourced from the client LLM;
 *   - the deterministic rule layer still seeds the high-confidence steps, so a goal does not
 *     need an LLM round-trip for a step the rules can decide;
 *   - with neither planner the run still degrades (launch-free) to the Assist-mode hint.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { runGoal } from "../src/autopilot/loop.js";
import { UnavailableEngine } from "../src/laya/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

describe("(R2) goal command plans without local weights", () => {
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

  /** A sampler standing in for the client LLM: types into the search box, then clicks Search. */
  const searchSampler = async (prompt: string): Promise<string> => {
    const inputMatch = prompt.match(/\[(e\d+)\] (?:searchbox|textbox)/i);
    const buttonMatch = prompt.match(/\[(e\d+)\] button "Search"/i);
    const afterRecent = prompt.split("RECENT ACTIONS:")[1] ?? "";
    const recent = afterRecent.split("Respond with ONLY")[0] ?? "";
    if (!/TYPE_TEXT/.test(recent) && inputMatch) {
      return JSON.stringify({ operation: "TYPE_TEXT", target: inputMatch[1], value: "laptops" });
    }
    if (buttonMatch) return JSON.stringify({ operation: "CLICK", target: buttonMatch[1] });
    return JSON.stringify({ operation: "BLOCKED" });
  };

  it("runs the goal with an unavailable engine and verifies the real page", async () => {
    const result = await runGoal({
      goal: 'find laptops and expect "Showing results for laptops"',
      session,
      engine: new UnavailableEngine(),
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.6,
      sample: searchSampler,
      plannerAvailable: () => true,
      maxSteps: 6,
    });

    expect(result.degraded).toBe(false);
    expect(result.outcome).toBe("done");
    expect(result.verification.verified).toBe(true);

    const acted = result.transcript.filter(
      (s) => s.operation === "TYPE_TEXT" || s.operation === "CLICK",
    );
    expect(acted.length).toBeGreaterThan(0);
    for (const s of acted) expect(s.source).toBe("llm");

    // Literal, not a spy: the real DOM carries the marker the sampler drove it to, and the
    // engine that would have thrown on `decide` was never consulted.
    const page = await session.getPage();
    expect(await page.locator("#results").textContent()).toBe("Showing results for laptops");
  });

  it("keeps the deterministic rule layer for a goal that states its own field value", async () => {
    // The goal names the value, so the policy seeds the TYPE_TEXT itself and no LLM round-trip
    // is needed for that step even with no weights loaded.
    let sampled = 0;
    const result = await runGoal({
      goal: 'type "laptops" into the search box and expect "Showing results for laptops"',
      session,
      engine: new UnavailableEngine(),
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.6,
      sample: async (prompt) => {
        sampled += 1;
        return searchSampler(prompt);
      },
      plannerAvailable: () => true,
      maxSteps: 6,
    });

    const ruleSteps = result.transcript.filter((s) => s.source === "rule");
    expect(ruleSteps.length).toBeGreaterThan(0);
    expect(result.verification.verified).toBe(true);
    expect(sampled).toBeLessThan(result.transcript.length);
  });

  it("(R4) reaches another page via a planner-chosen NAVIGATE", async () => {
    // A goal that can only be satisfied on a DIFFERENT page. Nothing in the local rule layer or
    // the DOM of page A can get there, so the only way the run finishes is a NAVIGATE the
    // planner chose - the capability the goal command was missing.
    const navSampler = async (prompt: string): Promise<string> => {
      if (/Page B/.test(prompt)) return JSON.stringify({ operation: "DONE" });
      return JSON.stringify({ operation: "NAVIGATE", url: fixtures.url("nav-b.html") });
    };

    const result = await runGoal({
      goal: 'get to page B and expect "This is page B"',
      session,
      engine: new UnavailableEngine(),
      url: fixtures.url("nav-a.html"),
      sample: navSampler,
      plannerAvailable: () => true,
      allowedDomains: ["127.0.0.1"],
      maxSteps: 4,
    });

    expect(result.degraded).toBe(false);
    expect(result.transcript.some((s) => s.operation === "NAVIGATE")).toBe(true);
    expect(result.verification.verified).toBe(true);
    const page = await session.getPage();
    expect(page.url()).toContain("nav-b.html");
    expect(await page.locator("#marker").textContent()).toBe("This is page B");
  });

  it("(R4) refuses a NAVIGATE the allow-list blocks and a confirm declines", async () => {
    const result = await runGoal({
      goal: "go somewhere off-list",
      session,
      engine: new UnavailableEngine(),
      url: fixtures.url("nav-a.html"),
      sample: async () => JSON.stringify({ operation: "NAVIGATE", url: "https://evil.example/x" }),
      plannerAvailable: () => true,
      allowedDomains: ["127.0.0.1"],
      confirm: async () => false,
      maxSteps: 3,
    });

    expect(result.outcome).toBe("blocked");
    const page = await session.getPage();
    expect(page.url()).not.toContain("evil.example");
    expect(await page.locator("#marker").textContent()).toBe("This is page A");
  });

  it("degrades to the Assist-mode hint when the client cannot plan either", async () => {
    const result = await runGoal({
      goal: "find laptops",
      session,
      engine: new UnavailableEngine(),
      url: fixtures.url("search-form.html"),
      sample: searchSampler,
      plannerAvailable: () => false,
      maxSteps: 3,
    });

    expect(result.degraded).toBe(true);
    expect(result.outcome).toBe("degraded");
    expect(result.message).toContain("Assist-mode tools instead");
    expect(result.transcript).toHaveLength(0);
  });
});
