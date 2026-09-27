/**
 * (T1/T3/T5) Local-first autonomy regression + observability tests.
 *
 * These drive the REAL loop against the REAL fixture server and a real headless chromium,
 * with a deterministic scripted engine standing in for Laya, to prove the local-first
 * contract that must not regress:
 *   - T1: a step a deterministic rule can decide carries confidence 0.97 and never consults
 *     the client LLM (the sampler is not called) - the LLM is not in the default path;
 *   - T3: escalation is scoped to EXACTLY one step - the step after an escalation returns to
 *     rules/Laya (source 'rule'/'laya', not 'llm') and one escalation never ends the run;
 *   - T5: every executed step records a finite inferenceMs, and the RunResult carries an
 *     autonomy summary whose math (fullyAutonomous = rule+laya+stub, autonomousPct) is correct.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { runGoal, summariseAutonomy, type StepRecord } from "../src/autopilot/loop.js";
import { RULE_CONFIDENCE } from "../src/autopilot/policy.js";
import type { Decision, LayaDecisionEngine, PageState } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/**
 * A scripted engine: returns the next decision from a queue, resolving any `target` marker of
 * the form `#N` to the ref of the Nth control on the current page. Falls back to DONE when the
 * queue drains, so a test never hangs on the step budget.
 */
function scriptedEngine(script: (state: PageState, step: number) => Decision): LayaDecisionEngine {
  let step = 0;
  return {
    available: true,
    async decide(state: PageState) {
      step += 1;
      return script(state, step);
    },
    async close() {},
  };
}

describe("(T1/T3/T5) local-first autonomy", () => {
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

  it("(T1) a rule-decided step carries confidence 0.97 and never consults the LLM", async () => {
    // The goal names the field value, so the deterministic policy seeds the TYPE_TEXT itself:
    // no engine call and no sampler round-trip are needed for that step.
    let sampled = 0;
    const result = await runGoal({
      goal: 'type "laptops" into the search box and expect "Showing results for laptops"',
      session,
      engine: scriptedEngine(() => ({
        // If Laya were ever asked on the rule step this would show up as a 'laya' source;
        // the assertion below proves the rule seed pre-empts it.
        operation: "DONE",
        operationConfidence: 1,
        targetConfidence: 1,
        source: "laya",
      })),
      url: fixtures.url("search-form.html"),
      sample: async () => {
        sampled += 1;
        return JSON.stringify({ operation: "BLOCKED" });
      },
      maxSteps: 6,
    });

    const ruleSteps = result.transcript.filter((s) => s.source === "rule");
    expect(ruleSteps.length).toBeGreaterThan(0);
    // Rule seeds are high-confidence-deterministic (RULE_CONFIDENCE = 0.97).
    for (const s of ruleSteps) {
      expect(s.operationConfidence).toBe(RULE_CONFIDENCE);
      expect(s.operationConfidence).toBe(0.97);
    }
    // The LLM is never in the default path: a rule-decided step consults no sampler.
    expect(sampled).toBe(0);
    // No executed step was sourced from the LLM.
    expect(result.transcript.every((s) => s.source !== "llm")).toBe(true);
  });

  it("(T3) escalation is scoped to one step; the next step returns to rules/Laya and the run continues", async () => {
    // Step 1: Laya is deliberately LOW confidence, so the loop escalates to the sampler (LLM)
    // which types into the search box. Step 2: Laya is HIGH confidence (>= 0.85) and clicks
    // Search, so it is decided locally - proving no latched 'LLM mode' and that one escalation
    // did not end the run.
    const engine = scriptedEngine((state, step) => {
      const input = state.controls.find((c) => c.role === "searchbox" || c.role === "textbox");
      const button = state.controls.find((c) => c.role === "button");
      if (step === 1 && input) {
        return {
          operation: "TYPE_TEXT",
          operationConfidence: 0.2, // below the 0.85 gate -> escalate this step
          target: input.ref,
          targetConfidence: 0.2,
          value: "laptops",
          source: "laya",
        };
      }
      if (button) {
        return {
          operation: "CLICK",
          operationConfidence: 0.99, // well above the gate -> decided locally
          target: button.ref,
          targetConfidence: 0.99,
          source: "laya",
        };
      }
      return { operation: "DONE", operationConfidence: 1, targetConfidence: 1, source: "laya" };
    });

    // The sampler answers the escalated step by typing into the search box.
    const sample = async (prompt: string): Promise<string> => {
      const inputMatch = prompt.match(/\[(e\d+)\] (?:searchbox|textbox)/i);
      if (inputMatch) {
        return JSON.stringify({ operation: "TYPE_TEXT", target: inputMatch[1], value: "laptops" });
      }
      return JSON.stringify({ operation: "BLOCKED" });
    };

    const result = await runGoal({
      // Deliberately NOT phrased as `search for laptops` so the deterministic policy does not
      // seed step 1 itself: the low-confidence engine decision is what drives the escalation.
      goal: 'find the laptops listing and expect "Showing results for laptops"',
      session,
      engine,
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.85,
      sample,
      maxSteps: 6,
    });

    // Exactly the first step escalated to the LLM.
    const llmSteps = result.transcript.filter((s) => s.source === "llm");
    expect(llmSteps.length).toBe(1);
    expect(llmSteps[0].step).toBe(1);

    // The step AFTER the escalation returned to LOCAL decisioning (rules/Laya, NOT 'llm') -
    // proving escalation is scoped to exactly one step and no 'LLM mode' is latched.
    const afterEscalation = result.transcript.find((s) => s.step === 2);
    expect(afterEscalation).toBeDefined();
    expect(afterEscalation?.source).not.toBe("llm");
    expect(["rule", "laya"]).toContain(afterEscalation?.source);

    // One escalation did not end the run: it progressed and the real page verified.
    expect(result.verification.verified).toBe(true);
    const page = await session.getPage();
    expect(await page.locator("#results").textContent()).toBe("Showing results for laptops");
  });

  it("(T5) records finite inferenceMs per executed step and a correct autonomy summary", async () => {
    const engine = scriptedEngine((state, step) => {
      const input = state.controls.find((c) => c.role === "searchbox" || c.role === "textbox");
      const button = state.controls.find((c) => c.role === "button");
      if (step === 1 && input) {
        return {
          operation: "TYPE_TEXT",
          operationConfidence: 0.99,
          target: input.ref,
          targetConfidence: 0.99,
          value: "laptops",
          source: "laya",
        };
      }
      if (button) {
        return {
          operation: "CLICK",
          operationConfidence: 0.99,
          target: button.ref,
          targetConfidence: 0.99,
          source: "laya",
        };
      }
      return { operation: "DONE", operationConfidence: 1, targetConfidence: 1, source: "laya" };
    });

    const result = await runGoal({
      goal: 'search for laptops and expect "Showing results for laptops"',
      session,
      engine,
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.85,
      maxSteps: 6,
    });

    // Every executed step carries a finite, non-negative inferenceMs.
    const executed = result.transcript.filter(
      (s) => s.operation === "TYPE_TEXT" || s.operation === "CLICK",
    );
    expect(executed.length).toBeGreaterThan(0);
    for (const s of executed) {
      expect(typeof s.inferenceMs).toBe("number");
      expect(Number.isFinite(s.inferenceMs)).toBe(true);
      expect(s.inferenceMs).toBeGreaterThanOrEqual(0);
    }

    // The run-level autonomy summary is present and its math is internally consistent.
    const a = result.autonomy;
    expect(a).toBeDefined();
    if (!a) throw new Error("expected autonomy summary");
    expect(a.total).toBe(result.transcript.length);
    expect(a.fullyAutonomous).toBe(a.rule + a.laya + a.stub);
    expect(a.rule + a.laya + a.stub + a.llm).toBe(a.total);
    // This whole run stayed local (no escalation), so it is 100% autonomous.
    expect(a.llm).toBe(0);
    expect(a.autonomousPct).toBe(1);
  });

  it("(T5) summariseAutonomy is pure and total-safe", () => {
    expect(summariseAutonomy([])).toEqual({
      total: 0,
      rule: 0,
      laya: 0,
      stub: 0,
      llm: 0,
      fullyAutonomous: 0,
      autonomousPct: 0,
    });

    const mk = (source: StepRecord["source"]): StepRecord => ({
      step: 1,
      operation: "CLICK",
      operationConfidence: 1,
      targetConfidence: 1,
      source,
      detail: "x",
    });
    const summary = summariseAutonomy([mk("rule"), mk("laya"), mk("stub"), mk("llm")]);
    expect(summary.total).toBe(4);
    expect(summary.fullyAutonomous).toBe(3);
    expect(summary.autonomousPct).toBe(0.75);
  });
});
