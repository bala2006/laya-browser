/**
 * D1 session trace / replay export, exercised through the real Autopilot loop (headless
 * chromium) and the laya_export_run tool.
 *
 * Runs a goal with per-step artifact recording enabled (via the shared artifacts holder the
 * run_goal + export_run tools share), then calls laya_export_run to a temp path with format
 * 'both' and asserts:
 *   - both the JSON and HTML files are written and NON-EMPTY,
 *   - the JSON parses and contains per-step decision + confidence + timing entries, and
 *   - any secret text is masked (never present in either artifact).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser.js";
import * as runGoalTool from "../src/tools/run_goal.js";
import * as exportRun from "../src/tools/export_run.js";
import { createRunArtifactsHolder } from "../src/tools/run_artifacts.js";
import { REDACTION_MASK } from "../src/redact.js";
import type { LayaDecisionEngine } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const SECRET = "hunter2-SuperSecret!";

/** Pull the plain text out of a tool result. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

/** An engine that types the secret into the password field, then reports DONE. */
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
          operationConfidence: 0.97,
          target: pwd.ref,
          targetConfidence: 0.95,
          value: SECRET,
          source: "laya",
        };
      }
      return { operation: "DONE", operationConfidence: 1, targetConfidence: 1, source: "laya" };
    },
    async close() {},
  };
}

describe("D1 laya_export_run replay export (real chromium)", () => {
  let fixtures: FixtureServer;
  let session: BrowserSession;
  let tmp: string;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    session = new BrowserSession({ headless: true });
    tmp = await mkdtemp(join(tmpdir(), "laya-export-"));
  });

  afterAll(async () => {
    await session.close();
    await fixtures.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("records per-step artifacts and writes non-empty JSON + HTML replays with secrets masked", async () => {
    // The shared holder wired into BOTH tool contexts (mirrors src/server.ts).
    const artifacts = createRunArtifactsHolder();

    // Run the goal via the run_goal handler with recording explicitly enabled and the holder
    // present. Recording is gated on recordArtifacts (LAYA_RECORD_ARTIFACTS), NOT on the mere
    // presence of the holder.
    const runHandler = runGoalTool.makeHandler({
      session,
      engine: typePasswordEngine(),
      recordArtifacts: true,
      artifacts,
    });
    await runHandler({ goal: "sign in", url: fixtures.url("login.html"), maxSteps: 4 });

    // The holder now carries the recorded run.
    expect(artifacts.last).toBeDefined();
    expect(artifacts.last!.steps.length).toBeGreaterThan(0);

    // Export both artifacts to the temp directory.
    const exportHandler = exportRun.makeHandler({ session, artifacts });
    const result = await exportHandler({ path: tmp, format: "both" });
    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain("laya-run.json");
    expect(text).toContain("laya-run.html");

    // Both files exist and are NON-EMPTY.
    const jsonRaw = await readFile(join(tmp, "laya-run.json"), "utf8");
    const htmlRaw = await readFile(join(tmp, "laya-run.html"), "utf8");
    expect(jsonRaw.length).toBeGreaterThan(0);
    expect(htmlRaw.length).toBeGreaterThan(0);

    // The JSON parses and contains per-step decision + confidence + timing.
    const parsed = JSON.parse(jsonRaw) as {
      goal: string;
      steps: Array<{
        step: number;
        decision: string;
        operation: string;
        operationConfidence: number;
        targetConfidence: number;
        confidence: { operation: number; target: number };
        timingMs: number;
        durationMs: number;
        detail: string;
        snapshot: string;
      }>;
    };
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(parsed.steps.length).toBeGreaterThan(0);
    for (const step of parsed.steps) {
      expect(typeof step.decision).toBe("string");
      expect(typeof step.operation).toBe("string");
      expect(typeof step.operationConfidence).toBe("number");
      expect(typeof step.targetConfidence).toBe("number");
      expect(typeof step.confidence.operation).toBe("number");
      expect(typeof step.timingMs).toBe("number");
      expect(typeof step.durationMs).toBe("number");
    }

    // The TYPE_TEXT step recorded its (masked) detail, proving decision + timing were kept.
    const typeStep = parsed.steps.find((s) => s.operation === "TYPE_TEXT");
    expect(typeStep).toBeDefined();
    expect(typeStep!.detail).toContain(REDACTION_MASK);

    // The secret is masked in BOTH artifacts (never leaks into the export).
    expect(jsonRaw).not.toContain(SECRET);
    expect(htmlRaw).not.toContain(SECRET);
    expect(htmlRaw).toContain(REDACTION_MASK);
  });

  it("records NO per-step artifacts when recording is not opted in, even with a holder present", async () => {
    // Regression guard for the always-on production bug: the shared holder is wired in exactly
    // as src/server.ts does, but recordArtifacts is NOT set. A normal run must therefore
    // capture no per-step screenshots and leave the holder empty.
    const artifacts = createRunArtifactsHolder();
    const runHandler = runGoalTool.makeHandler({
      session,
      engine: typePasswordEngine(),
      artifacts,
    });
    await runHandler({ goal: "sign in", url: fixtures.url("login.html"), maxSteps: 4 });

    // The holder never received a run: recording was off, so nothing was recorded.
    expect(artifacts.last).toBeUndefined();

    // The export tool consequently reports that no run has been recorded.
    const exportHandler = exportRun.makeHandler({ session, artifacts });
    const result = await exportHandler({ path: tmp, format: "both" });
    const text = textOf(result);
    expect(text.toLowerCase()).toContain("no autopilot run");
    expect(text).toContain("LAYA_RECORD_ARTIFACTS");
  });

  it("records per-step artifacts ONLY when recordArtifacts is explicitly enabled", async () => {
    // Opt-in path: with recordArtifacts true, the same run DOES record per-step artifacts.
    const artifacts = createRunArtifactsHolder();
    const runHandler = runGoalTool.makeHandler({
      session,
      engine: typePasswordEngine(),
      recordArtifacts: true,
      artifacts,
    });
    await runHandler({ goal: "sign in", url: fixtures.url("login.html"), maxSteps: 4 });
    expect(artifacts.last).toBeDefined();
    expect(artifacts.last!.steps.length).toBeGreaterThan(0);
    // Recording captured per-step PNG screenshots (the exact cost a normal run must avoid).
    expect(
      artifacts.last!.steps.some((s) => typeof s.screenshotPng === "string"),
    ).toBe(true);
  });

  it("returns a clear text result (not an error file) when no run has been recorded", async () => {
    const artifacts = createRunArtifactsHolder();
    const exportHandler = exportRun.makeHandler({ session, artifacts });
    const result = await exportHandler({ path: tmp, format: "both" });
    const text = textOf(result);
    expect(text).toContain("laya_run_goal");
    expect(text.toLowerCase()).toContain("no autopilot run");
  });
});
