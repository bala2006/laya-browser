/**
 * Escalation tests.
 *
 * Verifies the confidence-based escalation path end to end WITHOUT a live MCP client:
 *   - a low-confidence engine decision triggers the injected sampling callback, and the loop
 *     CONSUMES the returned Decision (source = "llm") — asserted by the real page state and
 *     the transcript, not by a spy;
 *   - the escalation parser guards malformed / unresolvable LLM output down to BLOCKED;
 *   - when no sampler is available, escalation degrades to a clear BLOCKED (never throws).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { runGoal } from "../src/autopilot/loop.js";
import {
  escalate,
  parseDecision,
  buildEscalationPrompt,
} from "../src/autopilot/escalation.js";
import type { Decision, LayaDecisionEngine, PageState } from "../src/types.js";
import { asRef } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** An engine that always returns a LOW-confidence CLICK on a bogus target. */
const lowConfidenceEngine: LayaDecisionEngine = {
  available: true,
  async decide(state: PageState) {
    // Point at the first control but with confidence below any sane threshold, forcing
    // escalation regardless of the target.
    const first = state.controls[0];
    if (!first) {
      return {
        operation: "BLOCKED",
        operationConfidence: 1,
        targetConfidence: 1,
        source: "laya",
      };
    }
    return {
      operation: "CLICK",
      operationConfidence: 0.1,
      target: first.ref,
      targetConfidence: 0.1,
      source: "laya",
    };
  },
  async close() {},
};

describe("parseDecision boundary", () => {
  const refs = new Set(["e1", "e2"]);

  it("parses a well-formed targeted decision", () => {
    const d = parseDecision('{"operation":"CLICK","target":"e2"}', refs);
    expect(d.operation).toBe("CLICK");
    expect(d.target).toBe("e2");
    expect(d.source).toBe("llm");
  });

  it("parses a TYPE_TEXT with a value", () => {
    const d = parseDecision('here: {"operation":"TYPE_TEXT","target":"e1","value":"hi"}', refs);
    expect(d.operation).toBe("TYPE_TEXT");
    expect(d).toMatchObject({ target: "e1", value: "hi" });
  });

  it("blocks on an unknown operation", () => {
    expect(parseDecision('{"operation":"FLY","target":"e1"}', refs).operation).toBe("BLOCKED");
  });

  it("blocks a targeted op whose target is not a known ref", () => {
    expect(parseDecision('{"operation":"CLICK","target":"e99"}', refs).operation).toBe("BLOCKED");
  });

  it("blocks on non-JSON garbage", () => {
    expect(parseDecision("no json here", refs).operation).toBe("BLOCKED");
  });

  it("parses a HOVER as a targeted operation", () => {
    const d = parseDecision('{"operation":"HOVER","target":"e1"}', refs);
    expect(d.operation).toBe("HOVER");
    expect(d.target).toBe("e1");
    expect(d.source).toBe("llm");
  });

  it("parses a targetless NAVIGATE_BACK", () => {
    const d = parseDecision('{"operation":"NAVIGATE_BACK"}', refs);
    expect(d.operation).toBe("NAVIGATE_BACK");
    expect(d.target).toBeUndefined();
  });

  it("(R4) parses NAVIGATE with an absolute http(s) url", () => {
    const d = parseDecision('{"operation":"NAVIGATE","url":"https://example.com/a"}', refs);
    expect(d.operation).toBe("NAVIGATE");
    expect(d).toMatchObject({ url: "https://example.com/a", source: "llm" });
  });

  it("(R4) blocks a NAVIGATE without a safe absolute url", () => {
    // The planner's url is untrusted input: a relative path, a javascript: URL, or a missing
    // url must all collapse to BLOCKED rather than reaching page.goto.
    for (const raw of [
      '{"operation":"NAVIGATE"}',
      '{"operation":"NAVIGATE","url":"/relative"}',
      '{"operation":"NAVIGATE","url":"javascript:alert(1)"}',
      '{"operation":"NAVIGATE","url":"//evil.example"}',
    ]) {
      expect(parseDecision(raw, refs).operation).toBe("BLOCKED");
    }
  });

  it("parses a PRESS_KEY carrying a key payload", () => {
    const d = parseDecision('{"operation":"PRESS_KEY","key":"Enter"}', refs);
    expect(d).toMatchObject({ operation: "PRESS_KEY", key: "Enter", source: "llm" });
  });

  it("blocks a PRESS_KEY that is missing its key payload", () => {
    expect(parseDecision('{"operation":"PRESS_KEY"}', refs).operation).toBe("BLOCKED");
    expect(parseDecision('{"operation":"PRESS_KEY","key":"  "}', refs).operation).toBe(
      "BLOCKED",
    );
  });

  it("parses a FILL_FORM batch with known refs into a FILL_FORM decision", () => {
    const d = parseDecision(
      '{"operation":"FILL_FORM","fields":[{"target":"e1","value":"a@b.com"},{"target":"e2","value":"pw"}]}',
      refs,
    );
    expect(d.operation).toBe("FILL_FORM");
    expect(d.source).toBe("llm");
    // Narrow to the FILL_FORM variant so we can assert on its `fields` payload.
    if (d.operation !== "FILL_FORM") throw new Error("expected FILL_FORM");
    expect(d.fields).toEqual([
      { target: "e1", value: "a@b.com" },
      { target: "e2", value: "pw" },
    ]);
    expect(d.target).toBeUndefined();
  });

  it("blocks a FILL_FORM whose fields reference an unknown ref", () => {
    expect(
      parseDecision(
        '{"operation":"FILL_FORM","fields":[{"target":"e1","value":"a@b.com"},{"target":"e99","value":"pw"}]}',
        refs,
      ).operation,
    ).toBe("BLOCKED");
  });

  it("blocks a FILL_FORM with an empty or malformed fields list", () => {
    expect(parseDecision('{"operation":"FILL_FORM","fields":[]}', refs).operation).toBe(
      "BLOCKED",
    );
    expect(parseDecision('{"operation":"FILL_FORM"}', refs).operation).toBe("BLOCKED");
    expect(
      parseDecision(
        '{"operation":"FILL_FORM","fields":[{"target":"e1"}]}',
        refs,
      ).operation,
    ).toBe("BLOCKED");
  });
});

describe("escalate() with an injected sampler", () => {
  it("degrades to BLOCKED (escalated=false) when no sampler is available", async () => {
    const state: PageState = {
      goal: "g",
      url: "http://x/",
      title: "t",
      visibleText: "",
      controls: [],
      recentActions: [],
    };
    const res = await escalate(state, undefined);
    expect(res.decision.operation).toBe("BLOCKED");
    expect(res.escalated).toBe(false);
    expect(res.note).toContain("does not support MCP sampling");
  });

  it("(T4) falls back to Laya's non-BLOCKED guess (escalated=false, warning note) when no sampler", async () => {
    const state: PageState = {
      goal: "g",
      url: "http://x/",
      title: "t",
      visibleText: "",
      controls: [
        {
          ref: asRef("e1"),
          index: 1,
          role: "button",
          name: "Go",
          tag: "button",
          editable: false,
        },
      ],
      recentActions: [],
    };
    const fallback: Decision = {
      operation: "CLICK",
      operationConfidence: 0.5,
      target: asRef("e1"),
      targetConfidence: 0.5,
      source: "laya",
    };
    const res = await escalate(state, undefined, { fallback });
    expect(res.escalated).toBe(false);
    expect(res.decision).toMatchObject({ operation: "CLICK", target: "e1", source: "laya" });
    expect(res.decision.operation).not.toBe("BLOCKED");
    expect(res.note.toLowerCase()).toContain("laya");
  });

  it("(T4) falls back to Laya's guess when the sampler throws", async () => {
    const state: PageState = {
      goal: "g",
      url: "http://x/",
      title: "t",
      visibleText: "",
      controls: [
        {
          ref: asRef("e1"),
          index: 1,
          role: "button",
          name: "Go",
          tag: "button",
          editable: false,
        },
      ],
      recentActions: [],
    };
    const fallback: Decision = {
      operation: "CLICK",
      operationConfidence: 0.4,
      target: asRef("e1"),
      targetConfidence: 0.4,
      source: "laya",
    };
    const res = await escalate(
      state,
      async () => {
        throw new Error("network down");
      },
      { fallback },
    );
    expect(res.escalated).toBe(false);
    expect(res.decision).toMatchObject({ operation: "CLICK", target: "e1", source: "laya" });
    expect(res.note).toContain("unreachable");
  });

  it("(T4) still degrades to BLOCKED when the fallback is itself BLOCKED", async () => {
    const state: PageState = {
      goal: "g",
      url: "http://x/",
      title: "t",
      visibleText: "",
      controls: [],
      recentActions: [],
    };
    const fallback: Decision = {
      operation: "BLOCKED",
      operationConfidence: 0,
      targetConfidence: 0,
      source: "laya",
    };
    const res = await escalate(state, undefined, { fallback });
    expect(res.escalated).toBe(false);
    expect(res.decision.operation).toBe("BLOCKED");
    expect(res.note).toContain("does not support MCP sampling");
  });

  it("consumes a canned LLM decision when the sampler returns JSON", async () => {
    const state: PageState = {
      goal: "g",
      url: "http://x/",
      title: "t",
      visibleText: "",
      controls: [
        {
          ref: asRef("e1"),
          index: 1,
          role: "button",
          name: "Go",
          tag: "button",
          editable: false,
        },
      ],
      recentActions: [],
    };
    const res = await escalate(state, async () => '{"operation":"CLICK","target":"e1"}');
    expect(res.escalated).toBe(true);
    expect(res.decision).toMatchObject({ operation: "CLICK", target: "e1", source: "llm" });
  });

  it("includes the numbered controls in the prompt", () => {
    const state: PageState = {
      goal: "do it",
      url: "http://x/",
      title: "t",
      visibleText: "",
      controls: [
        { ref: asRef("e1"), index: 1, role: "button", name: "Submit", tag: "button", editable: false },
      ],
      recentActions: [],
    };
    const prompt = buildEscalationPrompt(state);
    expect(prompt).toContain("do it");
    expect(prompt).toContain("[e1]");
    expect(prompt).toContain("JSON");
  });
});

describe("Autopilot loop escalation (fake sampling callback, real chromium)", () => {
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

  it("escalates a low-confidence decision to the injected sampler and consumes it", async () => {
    // The injected sampler plays the role of the client LLM: it fills the search box and
    // then clicks Search, choosing targets by their role/name from the page state.
    const sample = async (prompt: string): Promise<string> => {
      // Find the search input ref and the search button ref from the prompt lines.
      const inputMatch = prompt.match(/\[(e\d+)\] (?:searchbox|textbox)/i);
      const buttonMatch = prompt.match(/\[(e\d+)\] button "Search"/i);
      // Decide based on whether the field was already typed. Only inspect the RECENT
      // ACTIONS block (the JSON format hint later in the prompt also contains "TYPE_TEXT").
      const afterRecent = prompt.split("RECENT ACTIONS:")[1] ?? "";
      const recent = afterRecent.split("Respond with ONLY")[0] ?? "";
      const alreadyTyped = /TYPE_TEXT/.test(recent);
      if (!alreadyTyped && inputMatch) {
        return JSON.stringify({
          operation: "TYPE_TEXT",
          target: inputMatch[1],
          value: "laptops",
        });
      }
      if (buttonMatch) {
        return JSON.stringify({ operation: "CLICK", target: buttonMatch[1] });
      }
      return JSON.stringify({ operation: "BLOCKED" });
    };

    const result = await runGoal({
      // No explicit field assignment in the goal, so the deterministic policy does NOT
      // seed a step: the low-confidence engine decision drives escalation to the sampler.
      goal: 'find laptops and expect "Showing results for laptops"',
      session,
      engine: lowConfidenceEngine,
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.6,
      sample,
      maxSteps: 6,
    });

    // Every executed step came from the LLM escalation path.
    const executed = result.transcript.filter(
      (s) => s.operation === "TYPE_TEXT" || s.operation === "CLICK",
    );
    expect(executed.length).toBeGreaterThan(0);
    for (const s of executed) expect(s.source).toBe("llm");

    // And the real page reflects the escalated actions (literal, not a spy).
    const page = await session.getPage();
    expect(await page.locator("#results").textContent()).toBe(
      "Showing results for laptops",
    );
    expect(result.verification.verified).toBe(true);
  });

  it("(T4) a low-confidence Laya step with no sampler runs Laya's guess and keeps going", async () => {
    // The client cannot answer an MCP sampling request (no sampler wired). Under T4 an
    // unreachable LLM must NOT kill autonomy: the low-confidence, non-BLOCKED Laya decision
    // executes as Laya's best guess and the run continues rather than ending BLOCKED.
    const result = await runGoal({
      goal: "click around the page",
      session,
      engine: lowConfidenceEngine,
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.85,
      // no sample callback -> the LLM is unreachable
      maxSteps: 3,
    });
    // The run did not end BLOCKED merely because the LLM was unreachable.
    const acted = result.transcript.filter((s) => s.operation !== "BLOCKED");
    expect(acted.length).toBeGreaterThan(0);
    // Laya's best guess drove the executed step (source 'laya', not 'llm'), with a warning note.
    const layaStep = acted.find((s) => s.source === "laya");
    expect(layaStep).toBeDefined();
    expect(layaStep?.note?.toLowerCase()).toContain("laya");
    // No step ended the run with an unreachable-LLM BLOCKED.
    const llmBlocked = result.transcript.find(
      (s) => s.operation === "BLOCKED" && s.source === "llm",
    );
    expect(llmBlocked).toBeUndefined();
  });

  it("(T4) a run stops BLOCKED only when Laya itself chose BLOCKED (no sampler)", async () => {
    // Engine that always returns BLOCKED: this is Laya itself declining, which IS allowed to
    // stop a run even with no sampler. The R2 no-weights placeholder is BLOCKED too, so the
    // graceful BLOCKED path must be preserved.
    const blockingEngine: LayaDecisionEngine = {
      available: true,
      async decide() {
        return {
          operation: "BLOCKED",
          operationConfidence: 1,
          targetConfidence: 1,
          source: "laya",
        };
      },
      async close() {},
    };
    const result = await runGoal({
      goal: "do something impossible here",
      session,
      engine: blockingEngine,
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.85,
      // no sample callback -> escalation cannot help, and there is no non-BLOCKED fallback
      maxSteps: 3,
    });
    expect(result.outcome).toBe("blocked");
    const last = result.transcript.at(-1);
    expect(last?.operation).toBe("BLOCKED");
    expect(last?.source).toBe("llm");
    expect(last?.note).toContain("MCP sampling");
  });
});
