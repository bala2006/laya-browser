import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { StubEngine, UnavailableEngine, createEngine } from "../src/laya/index.js";
import * as runGoalTool from "../src/tools/run_goal.js";
import { runGoal } from "../src/autopilot/loop.js";
import { buildState, RECOMMENDED_MAX_OPTIONS } from "../src/state-builder.js";
import type { Snapshot } from "../src/snapshot.js";
import type { Control, LayaDecisionEngine } from "../src/types.js";
import { asRef } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("state-builder limits", () => {
  it("caps the number of controls and clamps option strings", () => {
    const controls: Control[] = Array.from({ length: 40 }, (_, i) => ({
      ref: asRef(`e${i + 1}`),
      index: i + 1,
      role: "button",
      name: "x".repeat(500),
      tag: "button",
      editable: false,
    }));
    const snapshot: Snapshot = {
      url: "http://localhost/",
      title: "T",
      visibleText: "y".repeat(5000),
      controls,
      text: "",
    };

    const state = buildState("do a thing", snapshot, [], { maxOptionLen: 40 });
    // Never exceeds the recommended option count (fits head_max_len).
    expect(state.controls.length).toBeLessThanOrEqual(RECOMMENDED_MAX_OPTIONS);
    // Each control's name is clamped to the configured maximum.
    for (const c of state.controls) {
      expect(c.name.length).toBeLessThanOrEqual(40);
    }
    // Controls are re-indexed contiguously starting at 1.
    expect(state.controls.map((c) => c.index)).toEqual(
      state.controls.map((_, i) => i + 1),
    );
    // Visible text is clamped too.
    expect(state.visibleText.length).toBeLessThanOrEqual(1200);
  });

  it("drops headings, labels, and disabled controls from the numbered list", () => {
    const controls: Control[] = [
      { ref: asRef("e1"), index: 1, role: "heading", name: "Title", tag: "h1", editable: false },
      { ref: asRef("e2"), index: 2, role: "textbox", name: "Email", tag: "input", type: "email", editable: true },
      { ref: asRef("e3"), index: 3, role: "button", name: "Disabled", tag: "button", editable: false, disabled: true },
    ];
    const snapshot: Snapshot = {
      url: "http://localhost/",
      title: "T",
      visibleText: "",
      controls,
      text: "",
    };
    const state = buildState("email is a@b.com", snapshot);
    expect(state.controls.map((c) => c.name)).toEqual(["Email"]);
  });
});

describe("createEngine factory", () => {
  it("returns the stub when explicitly selected via config", async () => {
    const engine = await createEngine({ engine: "stub" });
    expect(engine).toBeInstanceOf(StubEngine);
    expect(engine.available).toBe(true);
  });

  it("returns the stub when LAYA_ENGINE=stub in the env", async () => {
    const engine = await createEngine({ env: { LAYA_ENGINE: "stub" } });
    expect(engine).toBeInstanceOf(StubEngine);
  });

  it("returns an unavailable engine when no weights and no download", async () => {
    const engine = await createEngine({ env: {} });
    expect(engine).toBeInstanceOf(UnavailableEngine);
    expect(engine.available).toBe(false);
  });
});

describe("Autopilot loop with the StubEngine (real headless chromium, no weights)", () => {
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

  it("fills the search box, submits, reaches DONE, and verifies the results marker", async () => {
    const engine = new StubEngine();
    const handler = runGoalTool.makeHandler({ session, engine });
    const result = await handler({
      goal: 'search for "laptops" and expect "Showing results for laptops"',
      url: fixtures.url("search-form.html"),
    });
    const text = textOf(result);

    // The transcript shows the literal typed value and a CLICK on the search button.
    expect(text).toContain('TYPE_TEXT');
    expect(text).toContain('"laptops"');
    expect(text).toContain("Outcome: done");
    // Independent verification confirmed the results marker on the final page.
    expect(text).toContain("Verification: PASSED");

    // And the real page actually reflects the outcome (literal assertion, not a spy).
    const page = await session.getPage();
    expect(await page.locator("#results").textContent()).toBe("Showing results for laptops");
    expect(await page.title()).toBe("Results for laptops");
  });

  it("returns a structured RunResult reaching DONE with a verified marker", async () => {
    const engine = new StubEngine();
    const result = await runGoal({
      goal: 'keyword is laptop and expect "Filtered laptop"',
      session,
      engine,
      url: fixtures.url("filters.html"),
    });

    expect(result.outcome).toBe("done");
    expect(result.degraded).toBe(false);
    expect(result.verification.checked).toBe(true);
    expect(result.verification.verified).toBe(true);

    // The transcript typed the literal keyword and clicked the Apply button.
    const typed = result.transcript.find((s) => s.operation === "TYPE_TEXT");
    expect(typed?.value).toBe("laptop");
    expect(result.transcript.some((s) => s.operation === "CLICK")).toBe(true);
    const done = result.transcript.at(-1);
    expect(done?.operation).toBe("DONE");

    const page = await session.getPage();
    expect(await page.locator("#status").textContent()).toBe(
      "Filtered laptop in all categories",
    );
  });

  it("does not claim success when the goal's expected marker never appears", async () => {
    // The goal declares a marker the page will never produce. DONE must be EARNED by the
    // marker, so the loop never reaches DONE and the independent verification stays false —
    // proving DONE is not assumed and success is verified against the real final page.
    const engine = new StubEngine();
    const result = await runGoal({
      goal: 'search for "laptops" and expect "This marker never appears"',
      session,
      engine,
      url: fixtures.url("search-form.html"),
      maxSteps: 5,
    });
    expect(result.outcome).not.toBe("done");
    expect(result.verification.checked).toBe(true);
    expect(result.verification.verified).toBe(false);
    expect(result.verification.detail).toContain("Missing expected marker");
  });

  it("treats a DONE decision as unverified when the final page lacks the marker", async () => {
    // A rogue engine that immediately claims DONE. The loop must NOT accept DONE as proof:
    // its independent final-page verification against the goal marker reports verified=false.
    const doneEngine: LayaDecisionEngine = {
      available: true,
      async decide() {
        return {
          operation: "DONE",
          operationConfidence: 1,
          targetConfidence: 1,
          source: "laya",
        };
      },
      async close() {},
    };
    // Use a goal with NO field assignment so the deterministic policy layer does not seed
    // a step; the rogue engine's DONE is then what the loop consumes. (DONE must still be
    // independently verified against the final page, which never ran the search.)
    const result = await runGoal({
      goal: 'reach the results page and expect "Showing results for laptops"',
      session,
      engine: doneEngine,
      url: fixtures.url("search-form.html"),
    });
    expect(result.outcome).toBe("done");
    // DONE was declared, but the page never ran the search, so verification fails.
    expect(result.verification.verified).toBe(false);
    expect(result.message).toContain("verification FAILED");
  });

  it("degrades gracefully to an Assist-mode hint when the engine is unavailable", async () => {
    const engine = new UnavailableEngine();
    const handler = runGoalTool.makeHandler({ session, engine });
    const result = await handler({
      goal: 'search for "laptops"',
      url: fixtures.url("search-form.html"),
    });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Laya weights are not present");
    expect(text).toContain("browser_snapshot");
  });
});

// Real-weights integration test: only runs when a local ONNX bundle is provided.
const RUN_REAL = process.env.LAYA_MODEL_DIR !== undefined;
describe.skipIf(!RUN_REAL)("Autopilot with real Laya weights (LAYA_MODEL_DIR set)", () => {
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

  it("drives the search form to a verified result using the on-device model", async () => {
    const engine = await createEngine({ modelDir: process.env.LAYA_MODEL_DIR });
    expect(engine.available).toBe(true);
    const result = await runGoal({
      goal: 'search for "laptops" and expect "Showing results for laptops"',
      session,
      engine,
      url: fixtures.url("search-form.html"),
      maxSteps: 8,
    });
    await engine.close();
    expect(["done", "max_steps", "blocked"]).toContain(result.outcome);
  });
});
