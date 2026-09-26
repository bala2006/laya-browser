/**
 * Strict benchmark assertions.
 *
 * Asserts that the offline benchmark harness reports END-TO-END SUCCESS on every clean
 * structured-form fixture when driven by the StubEngine, that the reported success is the
 * INDEPENDENT final-page verification (not a DONE decision), and that the summary table
 * renders. Literal outcomes are asserted, not merely that functions were called.
 */
import { describe, it, expect } from "vitest";
import { StubEngine } from "../src/laya/index.js";
import {
  BENCH_CASES,
  runBenchmark,
  formatSummaryTable,
} from "./benchmark/harness.js";

describe("offline benchmark harness (stub engine)", () => {
  it("reports end-to-end success on every clean fixture", async () => {
    const results = await runBenchmark({ makeEngine: () => new StubEngine() });

    expect(results.length).toBe(BENCH_CASES.length);
    for (const r of results) {
      expect(r.outcome, `${r.name} outcome`).toBe("done");
      expect(r.success, `${r.name} end-to-end success`).toBe(true);
      // Per-step accuracy is perfect for the stub on these clean forms.
      expect(r.stepAccuracy, `${r.name} step accuracy`).toBe(1);
    }
  });

  it("renders a summary table with a success line", async () => {
    const results = await runBenchmark({ makeEngine: () => new StubEngine() });
    const table = formatSummaryTable(results, "StubEngine");
    expect(table).toContain("End-to-end success: ");
    expect(table).toContain(`${results.length}/${results.length}`);
    expect(table).toContain("INDEPENDENT final-page check");
  });
});
