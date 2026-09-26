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
import type { LayaDecisionEngine, PageState } from "../src/types.js";
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

  it("degrades to BLOCKED when a low-confidence decision has no sampler", async () => {
    const result = await runGoal({
      goal: "do something impossible here",
      session,
      engine: lowConfidenceEngine,
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.6,
      // no sample callback -> escalation cannot help
      maxSteps: 3,
    });
    expect(result.outcome).toBe("blocked");
    const last = result.transcript.at(-1);
    expect(last?.operation).toBe("BLOCKED");
    expect(last?.source).toBe("llm");
    expect(last?.note).toContain("MCP sampling");
  });
});
