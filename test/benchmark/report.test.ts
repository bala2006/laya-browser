/**
 * The `pnpm run bench` entry point.
 *
 * Runs the offline benchmark harness over the local structured-form fixtures with the
 * StubEngine (and the real engine too when LAYA_MODEL_DIR is set) and prints a per-fixture
 * summary table. It is a vitest test file so it runs under the project's single, reliable
 * TS runtime; `pnpm run bench` targets it explicitly.
 *
 * It intentionally does only soft, printed reporting here — the STRICT pass/fail assertions
 * live in test/benchmark.test.ts. This file's job is the human-readable table.
 */
import { describe, it, expect } from "vitest";
import { StubEngine, createEngine } from "../../src/laya/index.js";
import {
  runBenchmark,
  formatSummaryTable,
  type BenchResult,
} from "./harness.js";

describe("benchmark report (pnpm run bench)", () => {
  it("runs the offline benchmark with the stub and prints a summary table", async () => {
    const results = await runBenchmark({ makeEngine: () => new StubEngine() });
    // eslint-disable-next-line no-console
    console.log("\n" + formatSummaryTable(results, "StubEngine") + "\n");
    // A minimal sanity check so the report itself cannot silently produce nothing.
    expect(results.length).toBeGreaterThan(0);
  });

  const RUN_REAL = process.env.LAYA_MODEL_DIR !== undefined;
  it.skipIf(!RUN_REAL)(
    "also benchmarks the real engine when LAYA_MODEL_DIR is set",
    async () => {
      // Build a single real engine and reuse it across cases. runBenchmark calls close()
      // per case, so hand it a thin wrapper whose close() is a no-op; we close the real
      // engine once at the end.
      const engine = await createEngine({ modelDir: process.env.LAYA_MODEL_DIR });
      const reusable = {
        available: engine.available,
        decide: (state) => engine.decide(state),
        close: async () => {},
      };
      const results: BenchResult[] = await runBenchmark({
        makeEngine: () => reusable,
      });
      await engine.close();
      // eslint-disable-next-line no-console
      console.log("\n" + formatSummaryTable(results, "LayaEngine (real)") + "\n");
      expect(results.length).toBeGreaterThan(0);
    },
  );
});
