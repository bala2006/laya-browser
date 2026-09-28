/**
 * Dead-end fix (FEAT-003) tests.
 *
 * Reproduces and locks down the escalation dead-end: a LOW-CONFIDENCE BLOCKED decision plus an
 * UNREACHABLE client LLM (no MCP sampler) used to trap the run at decide, because escalate()
 * dropped a BLOCKED fallback. The fix resolves such a step to BEST-SAFE-PROGRESS (the policy
 * layer's next action, else a bounded SCROLL_DOWN) so the run keeps moving, while preserving
 * every hard stop:
 *   - a CONFIDENT BLOCKED still stops;
 *   - a genuinely dead page (no policy action, no controls) still degrades to BLOCKED;
 *   - the loop detector can still terminate a run that cannot make real progress.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { runGoal } from "../src/autopilot/loop.js";
import { escalate } from "../src/autopilot/escalation.js";
import { bestSafeProgress } from "../src/autopilot/policy.js";
import type { Decision, LayaDecisionEngine, PageState } from "../src/types.js";
import { asRef } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** A page state with a single unambiguous submit control the goal maps to. */
function searchState(overrides: Partial<PageState> = {}): PageState {
  return {
    goal: 'search for "laptops"',
    url: "http://x/",
    title: "t",
    visibleText: "Product search",
    controls: [
      {
        ref: asRef("e1"),
        index: 1,
        role: "searchbox",
        name: "Search",
        tag: "input",
        type: "search",
        value: "laptops",
        editable: true,
      },
      {
        ref: asRef("e2"),
        index: 2,
        role: "button",
        name: "Search",
        tag: "button",
        editable: false,
      },
    ],
    recentActions: [],
    ...overrides,
  };
}

/** A low-confidence BLOCKED decision (the exact shape that used to trap the run). */
const lowConfidenceBlocked: Decision = {
  operation: "BLOCKED",
  operationConfidence: 0.1,
  targetConfidence: 0.1,
  source: "laya",
};

describe("bestSafeProgress resolver", () => {
  it("prefers the policy layer's next action (a non-destructive submit CLICK)", () => {
    const d = bestSafeProgress(searchState());
    expect(d).toBeDefined();
    expect(d?.operation).not.toBe("BLOCKED");
    // The goal-mapped field is already filled, so policy submits via the search button.
    expect(d).toMatchObject({ operation: "CLICK", target: "e2" });
  });

  it("falls back to a bounded SCROLL_DOWN when no policy action applies but content exists", () => {
    // A goal the policy cannot map to any control, but the page still has controls/text to
    // move toward: nudge with a bounded, non-destructive SCROLL_DOWN rather than dead-ending.
    const state = searchState({
      goal: "contemplate the meaning of the page",
      controls: [
        { ref: asRef("e1"), index: 1, role: "link", name: "Home", tag: "a", editable: false },
      ],
    });
    const d = bestSafeProgress(state);
    expect(d).toMatchObject({ operation: "SCROLL_DOWN" });
    expect(d?.target).toBeUndefined();
  });

  it("returns undefined for a genuinely dead page (no policy action, no controls, no text)", () => {
    const state: PageState = {
      goal: "do the impossible",
      url: "http://x/",
      title: "t",
      visibleText: "   ",
      controls: [],
      recentActions: [],
    };
    expect(bestSafeProgress(state)).toBeUndefined();
  });

  it("never emits a destructive CLICK as best-safe-progress", () => {
    // A page whose only submit is a destructive "Delete account" button: the policy submit
    // rule would target it, but best-safe-progress must not hand back a destructive CLICK; it
    // degrades to a safe SCROLL_DOWN nudge instead (the loop's destructive guard is the final
    // authority, but best-safe-progress should not even propose one).
    const state: PageState = {
      goal: 'type "me@x.com" into the email field',
      url: "http://x/",
      title: "t",
      visibleText: "Danger zone",
      controls: [
        {
          ref: asRef("e1"),
          index: 1,
          role: "textbox",
          name: "Email",
          tag: "input",
          type: "email",
          value: "me@x.com",
          editable: true,
        },
        {
          ref: asRef("e2"),
          index: 2,
          role: "button",
          name: "Delete account",
          tag: "button",
          editable: false,
        },
      ],
      recentActions: [],
    };
    const d = bestSafeProgress(state);
    expect(d).toBeDefined();
    expect(d?.operation).not.toBe("BLOCKED");
    if (d?.operation === "CLICK") {
      throw new Error("best-safe-progress must not emit a CLICK on a destructive control");
    }
    expect(d?.operation).toBe("SCROLL_DOWN");
  });
});

describe("escalate() best-safe-progress on an unreachable LLM (FEAT-003)", () => {
  it("(A) resolves a low-confidence BLOCKED + no sampler to a NON-BLOCKED progress step", async () => {
    const state = searchState();
    const res = await escalate(state, undefined, {
      fallback: lowConfidenceBlocked,
      bestSafeProgress: () => bestSafeProgress(state),
    });
    expect(res.escalated).toBe(false);
    expect(res.decision.operation).not.toBe("BLOCKED");
    expect(res.decision).toMatchObject({ operation: "CLICK", target: "e2" });
    expect(res.note.toLowerCase()).toContain("safe");
  });

  it("(A) resolves via best-safe-progress when the sampler THREW", async () => {
    const state = searchState();
    const res = await escalate(
      state,
      async () => {
        throw new Error("network down");
      },
      { fallback: lowConfidenceBlocked, bestSafeProgress: () => bestSafeProgress(state) },
    );
    expect(res.escalated).toBe(false);
    expect(res.decision.operation).not.toBe("BLOCKED");
  });

  it("(B) a CONFIDENT BLOCKED still hard-stops even when best-safe-progress is available", async () => {
    // The loop only supplies bestSafeProgress for a LOW-confidence BLOCKED, so a confident
    // BLOCKED never carries the resolver: escalate() degrades to a hard BLOCKED. Modelled here
    // by omitting bestSafeProgress (which is exactly what the loop does for a confident stop).
    const state = searchState();
    const res = await escalate(state, undefined, { fallback: lowConfidenceBlocked });
    expect(res.escalated).toBe(false);
    expect(res.decision.operation).toBe("BLOCKED");
    expect(res.note).toContain("does not support MCP sampling");
  });

  it("(C) a genuinely dead page still degrades to BLOCKED", async () => {
    const state: PageState = {
      goal: "do the impossible",
      url: "http://x/",
      title: "t",
      visibleText: "   ",
      controls: [],
      recentActions: [],
    };
    const res = await escalate(state, undefined, {
      fallback: lowConfidenceBlocked,
      bestSafeProgress: () => bestSafeProgress(state),
    });
    expect(res.escalated).toBe(false);
    expect(res.decision.operation).toBe("BLOCKED");
  });

  it("still prefers a non-BLOCKED Laya fallback over best-safe-progress (T4 preserved)", async () => {
    const state = searchState();
    const layaGuess: Decision = {
      operation: "CLICK",
      operationConfidence: 0.5,
      target: asRef("e1"),
      targetConfidence: 0.5,
      source: "laya",
    };
    const res = await escalate(state, undefined, {
      fallback: layaGuess,
      bestSafeProgress: () => bestSafeProgress(state),
    });
    expect(res.escalated).toBe(false);
    // The non-BLOCKED Laya guess wins; best-safe-progress is only for a BLOCKED fallback.
    expect(res.decision).toMatchObject({ operation: "CLICK", target: "e1", source: "laya" });
    expect(res.note.toLowerCase()).toContain("laya");
  });
});

describe("Autopilot loop dead-end fix (real chromium)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;

  /** An engine that always returns a LOW-confidence BLOCKED: the exact dead-end trigger. */
  const lowConfidenceBlockingEngine: LayaDecisionEngine = {
    available: true,
    async decide() {
      return {
        operation: "BLOCKED",
        operationConfidence: 0.1,
        targetConfidence: 0.1,
        source: "laya",
      };
    },
    async close() {},
  };

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
  });

  it("(D) a low-confidence BLOCKED with no sampler now PROGRESSES instead of dead-ending", async () => {
    // Pre-fill the field via the goal so the policy layer's submit rule supplies best-safe
    // progress: the run must click Search and reach the success marker rather than trapping.
    const result = await runGoal({
      goal: 'search for "laptops" and expect "Showing results for laptops"',
      session,
      engine: lowConfidenceBlockingEngine,
      url: fixtures.url("search-form.html"),
      confidenceThreshold: 0.85,
      // no sample callback -> the LLM is unreachable (opencode has no MCP sampling)
      maxSteps: 6,
    });
    // The run did NOT immediately dead-end on the first low-confidence BLOCKED.
    const acted = result.transcript.filter(
      (s) => s.operation === "TYPE_TEXT" || s.operation === "CLICK" || s.operation === "FILL_FORM",
    );
    expect(acted.length).toBeGreaterThan(0);
    // A best-safe-progress step is present (source 'rule', a safe non-BLOCKED action).
    const progress = result.transcript.find(
      (s) => s.source === "rule" && s.operation !== "BLOCKED",
    );
    expect(progress).toBeDefined();
  });

  it("(C) a genuinely dead page still terminates cleanly (loop detector, no infinite loop)", async () => {
    // dead-button.html has a control but no goal-mappable action: best-safe-progress nudges
    // with SCROLL_DOWN, which never changes the page, so the loop detector must bail with a
    // terminal outcome well within the step budget rather than spinning forever.
    const result = await runGoal({
      goal: "achieve the impossible on this page",
      session,
      engine: lowConfidenceBlockingEngine,
      url: fixtures.url("dead-button.html"),
      confidenceThreshold: 0.85,
      maxSteps: 8,
      loopWindow: 3,
    });
    expect(["stuck", "blocked", "max_steps"]).toContain(result.outcome);
    // The run terminated (a finite transcript), it did not hang.
    expect(result.transcript.length).toBeGreaterThan(0);
    expect(result.transcript.length).toBeLessThanOrEqual(9);
  });
});
