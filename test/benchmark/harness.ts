/**
 * Offline benchmark harness for laya-browser-mcp Autopilot.
 *
 * Runs {@link runGoal} over a set of local, structured-form HTML fixtures using a chosen
 * decision engine (the {@link StubEngine} by default; the real engine when LAYA_MODEL_DIR is
 * set) and records, per fixture:
 *   - end-to-end SUCCESS via the loop's INDEPENDENT final-page verification (DONE alone is
 *     never treated as success) — the trustworthy signal, and
 *   - EXPECTED-OPS COVERAGE: the fraction of the fixture's expected operations that appear,
 *     in order, in the executed transcript. This is a subsequence-coverage measure: it does
 *     NOT penalize extra or wrong operations, so it is deliberately labelled "coverage"
 *     rather than "accuracy"/"precision" — 100% coverage only means every expected op was
 *     present in order, not that the run took exactly the right steps.
 *
 * It is fully offline: the fixtures are served from a loopback http server and no weights
 * are needed for the stub path. {@link formatSummaryTable} renders a compact ASCII table.
 *
 * The harness is reused by both the vitest assertion test and the `pnpm run bench` CLI so
 * the two never drift.
 */
import { BrowserSession } from "../../src/browser.js";
import { runGoal, type RunResult, type StepRecord } from "../../src/autopilot/loop.js";
import type { DecisionSource, LayaDecisionEngine, Operation } from "../../src/types.js";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server.js";

/** One benchmark case: a fixture + goal + the operation sequence a correct run should take. */
export interface BenchCase {
  /** Human-readable name. */
  name: string;
  /** Fixture file under test/fixtures/. */
  fixture: string;
  /** The natural-language goal (with an explicit success marker). */
  goal: string;
  /** The operations a correct run is expected to execute, in order. */
  expectedOps: Operation[];
}

/** The clean structured-form cases the stub should handle end to end. */
export const BENCH_CASES: BenchCase[] = [
  {
    name: "search",
    fixture: "search-form.html",
    goal: 'search for "laptops" and expect "Showing results for laptops"',
    expectedOps: ["TYPE_TEXT", "CLICK"],
  },
  {
    name: "filters",
    fixture: "filters.html",
    goal: 'keyword is laptop and expect "Filtered laptop"',
    expectedOps: ["TYPE_TEXT", "CLICK"],
  },
  {
    name: "login",
    fixture: "login.html",
    goal: 'email is "user@example.com" and expect "Signed in as user@example.com"',
    expectedOps: ["TYPE_TEXT", "CLICK"],
  },
  {
    name: "login-multi",
    fixture: "login.html",
    // A TWO-field goal: with the Part 2 batch rule this resolves in one FILL_FORM + one
    // CLICK instead of TYPE_TEXT + TYPE_TEXT + CLICK. See test/autopilot-part2.test.ts for
    // the step-count assertion.
    goal:
      'email is "user@example.com" and password is "hunter2" and expect "Signed in as user@example.com"',
    expectedOps: ["FILL_FORM", "CLICK"],
  },
];

/** The per-case result of a benchmark run. */
export interface BenchResult {
  name: string;
  goal: string;
  outcome: RunResult["outcome"];
  /** End-to-end success = independent final-page verification passed. */
  success: boolean;
  /**
   * Expected-ops coverage: the fraction of expected operations that appeared, in order, in
   * the transcript. This is a subsequence-coverage measure, NOT a precision/accuracy metric:
   * it does not penalize extra or wrong operations.
   */
  opsCoverage: number;
  /** Number of steps executed. */
  steps: number;
  /** The executed operations, for reporting. */
  executedOps: Operation[];
  /**
   * How each step was resolved: counts of steps whose decision came from a deterministic
   * `rule`, the local `laya`/`stub` engine, or an `llm` escalation. This is the faster-
   * automation breakdown: more `rule`/`stub` steps mean fewer remote round-trips.
   */
  sourceCounts: Record<DecisionSource, number>;
  /** Wall-clock milliseconds for the run. */
  wallMs: number;
}

/** Count how each step's decision was resolved (rule / laya / stub / llm). */
function countSources(transcript: StepRecord[]): Record<DecisionSource, number> {
  const counts: Record<DecisionSource, number> = { rule: 0, laya: 0, stub: 0, llm: 0 };
  for (const s of transcript) counts[s.source]++;
  return counts;
}

/**
 * Expected-ops coverage: fraction of the expected operations that appear, in order, in the
 * transcript (a subsequence match). This deliberately does NOT penalize extra or wrong
 * operations — it measures coverage of the expected sequence, not precision. Read the
 * end-to-end success column for the trustworthy signal.
 */
function opsCoverage(transcript: StepRecord[], expected: Operation[]): number {
  if (expected.length === 0) return 1;
  const executed = transcript.map((s) => s.operation);
  let matched = 0;
  let cursor = 0;
  for (const op of expected) {
    const at = executed.indexOf(op, cursor);
    if (at !== -1) {
      matched++;
      cursor = at + 1;
    }
  }
  return matched / expected.length;
}

/** Options for {@link runBenchmark}. */
export interface RunBenchmarkOptions {
  /** Factory producing the engine to benchmark (fresh per case is fine). */
  makeEngine: () => LayaDecisionEngine;
  /** Cases to run. Defaults to {@link BENCH_CASES}. */
  cases?: BenchCase[];
  /** Step budget per case. Defaults to 8. */
  maxSteps?: number;
}

/** Run the benchmark and return one {@link BenchResult} per case. */
export async function runBenchmark(
  options: RunBenchmarkOptions,
): Promise<BenchResult[]> {
  const cases = options.cases ?? BENCH_CASES;
  const maxSteps = options.maxSteps ?? 8;

  const fixtures: FixtureServer = await startFixtureServer();
  const session = new BrowserSession({ headless: true });
  const results: BenchResult[] = [];

  try {
    for (const c of cases) {
      const engine = options.makeEngine();
      const startedAt = Date.now();
      const result = await runGoal({
        goal: c.goal,
        session,
        engine,
        url: fixtures.url(c.fixture),
        maxSteps,
      });
      const wallMs = Date.now() - startedAt;
      await engine.close().catch(() => {});
      results.push({
        name: c.name,
        goal: c.goal,
        outcome: result.outcome,
        success: result.verification.checked && result.verification.verified,
        opsCoverage: opsCoverage(result.transcript, c.expectedOps),
        steps: result.transcript.length,
        executedOps: result.transcript.map((s) => s.operation),
        sourceCounts: countSources(result.transcript),
        wallMs,
      });
    }
  } finally {
    await session.close();
    await fixtures.close();
  }

  return results;
}

/** Render a compact ASCII summary table of benchmark results. */
export function formatSummaryTable(results: BenchResult[], engineName: string): string {
  const lines: string[] = [];
  lines.push(`laya-browser-mcp offline benchmark (engine: ${engineName})`);
  lines.push("");
  const header = ["case", "outcome", "success", "ops-cov", "steps", "rule/laya/stub/llm", "ms"];
  const rows = results.map((r) => [
    r.name,
    r.outcome,
    r.success ? "yes" : "no",
    `${Math.round(r.opsCoverage * 100)}%`,
    String(r.steps),
    `${r.sourceCounts.rule}/${r.sourceCounts.laya}/${r.sourceCounts.stub}/${r.sourceCounts.llm}`,
    String(r.wallMs),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const fmt = (cols: string[]): string =>
    cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  lines.push(fmt(header));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) lines.push(fmt(row));
  lines.push("");
  const passed = results.filter((r) => r.success).length;
  const avgCov =
    results.length === 0
      ? 0
      : results.reduce((s, r) => s + r.opsCoverage, 0) / results.length;
  lines.push(
    `End-to-end success: ${passed}/${results.length}. Mean expected-ops coverage: ${Math.round(
      avgCov * 100,
    )}%.`,
  );
  lines.push(
    "Note: end-to-end success (the INDEPENDENT final-page check, not a DONE decision) is the",
  );
  lines.push(
    "trustworthy signal. 'ops-cov' is expected-ops COVERAGE (a subsequence match); it does",
  );
  lines.push(
    "not penalize extra/wrong operations, so it is not a precision/accuracy figure.",
  );
  lines.push(
    "'rule/laya/stub/llm' is the per-run breakdown of how each step was resolved: rule and",
  );
  lines.push(
    "stub/laya steps are resolved LOCALLY (no remote round-trip); llm steps escalated. More",
  );
  lines.push(
    "local steps and a single FILL_FORM batch (see the login-multi case) mean faster runs.",
  );
  return lines.join("\n");
}
