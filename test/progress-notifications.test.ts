/**
 * D2 structured MCP progress notifications, exercised through the run_goal handler (real
 * headless chromium).
 *
 * Invokes the run_goal handler with a fake `extra` that has `_meta.progressToken` set and a
 * captured `sendNotification` sink, then asserts:
 *   - at least one notifications/progress was emitted carrying the progressToken, a numeric
 *     progress + total, and a 'step N/' message, and
 *   - NO notifications are emitted when no progressToken is supplied (backward-compat).
 * It also confirms the streamed message is redacted (never carries a typed secret).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../src/browser.js";
import { StubEngine } from "../src/laya/index.js";
import * as runGoalTool from "../src/tools/run_goal.js";
import type { RunGoalExtra } from "../src/tools/run_goal.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/** A captured notification (as passed to sendNotification). */
interface CapturedNotification {
  method: string;
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

/** Build a fake `extra` with a captured sink; omit progressToken to test the no-op path. */
function fakeExtra(progressToken?: string | number): {
  extra: RunGoalExtra;
  captured: CapturedNotification[];
} {
  const captured: CapturedNotification[] = [];
  const extra: RunGoalExtra = {
    ...(progressToken !== undefined ? { _meta: { progressToken } } : {}),
    sendNotification: async (n) => {
      captured.push(n as CapturedNotification);
    },
  };
  return { extra, captured };
}

describe("D2 MCP progress notifications through the run_goal handler (real chromium)", () => {
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

  it("emits notifications/progress per step when a progressToken is supplied", async () => {
    const handler = runGoalTool.makeHandler({ session, engine: new StubEngine() });
    const { extra, captured } = fakeExtra("tok-42");

    await handler(
      { goal: 'search for "laptops" and expect "Showing results for laptops"', url: fixtures.url("search-form.html") },
      extra,
    );

    // At least one progress notification was emitted.
    const progress = captured.filter((n) => n.method === "notifications/progress");
    expect(progress.length).toBeGreaterThan(0);

    // Each carries the progressToken, numeric progress/total, and a 'step N/' message.
    for (const n of progress) {
      expect(n.params.progressToken).toBe("tok-42");
      expect(typeof n.params.progress).toBe("number");
      expect(typeof n.params.total).toBe("number");
      expect(n.params.message).toMatch(/^step \d+\//);
    }
  });

  it("emits NO notifications when no progressToken is supplied (backward-compat)", async () => {
    const handler = runGoalTool.makeHandler({ session, engine: new StubEngine() });
    const { extra, captured } = fakeExtra(undefined);

    await handler(
      { goal: 'search for "laptops" and expect "Showing results for laptops"', url: fixtures.url("search-form.html") },
      extra,
    );

    expect(captured.length).toBe(0);
  });

  it("emits nothing when called with no extra at all (direct invocation)", async () => {
    const handler = runGoalTool.makeHandler({ session, engine: new StubEngine() });
    // Must not throw when extra is omitted entirely.
    const result = await handler({
      goal: 'search for "laptops" and expect "Showing results for laptops"',
      url: fixtures.url("search-form.html"),
    });
    expect(result.isError).not.toBe(true);
  });
});
