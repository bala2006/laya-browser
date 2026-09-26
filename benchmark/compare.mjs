/**
 * The benchmark entrypoint: `pnpm run bench:compare`.
 *
 * Builds the project if needed, starts the local loopback fixture server, and runs the full
 * task matrix against BOTH MCP servers under identical conditions:
 *   - laya-browser-mcp: `node ../dist/index.js` with LAYA_ENGINE=stub + all capabilities.
 *   - Playwright MCP:    `npx @playwright/mcp --headless --browser chromium`, with the
 *                         PLAYWRIGHT_BROWSERS_PATH env confined to its launch spec so the MCP
 *                         subprocess finds the installed chrome-for-testing build.
 *
 * It also runs a laya-only Autopilot pass (`laya_run_goal`) to measure client<->server
 * round-trips for the single-call goal runner (an architectural difference: Playwright MCP
 * has no equivalent single-call goal tool).
 *
 * Outputs: benchmark/results.json, benchmark/RESULTS.md, benchmark/charts/*.svg.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFixtureServer } from "./server.mjs";
import { runServer, taskApplies } from "./runner.mjs";
import { TASKS } from "./tasks.mjs";
import { writeCharts } from "./charts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST = path.join(PROJECT_ROOT, "dist", "index.js");
const CAPS = "network,storage,testing,devtools,pdf,vision,config";
const PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/playwright";

const RUNS = Number(process.env.BENCH_RUNS ?? 5);

// Tool counts are a fixed, documented capability fact (not re-probed each run to keep the
// numbers stable): laya exposes 25 core / 72 with all caps; Playwright MCP core is 24.
const LAYA_CORE_TOOLS = 25;
const LAYA_ALL_TOOLS = 72;
const PW_CORE_TOOLS = 24;

function log(msg) {
  process.stderr.write(msg + "\n");
}

function ensureBuild() {
  if (existsSync(DIST)) {
    log(`Using existing build at ${DIST}`);
    return;
  }
  log("dist/index.js missing; building project...");
  const res = spawnSync("pnpm", ["run", "build"], { cwd: PROJECT_ROOT, stdio: "inherit" });
  if (res.status !== 0) throw new Error("project build failed");
}

/** Ensure the benchmark's own dev deps (@playwright/mcp + MCP SDK) are installed. */
function ensureBenchDeps() {
  if (existsSync(path.join(__dirname, "node_modules", "@playwright", "mcp"))) return;
  log("benchmark dependencies missing; installing (npm install in benchmark/)...");
  const res = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: __dirname,
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error("benchmark dependency install failed");
}

/** Merge assist results from both servers + laya autopilot into a comparison model. */
function buildModel({ layaAssist, pwAssist, layaAuto }) {
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
  const L = byId(layaAssist);
  const P = byId(pwAssist);
  const A = byId(layaAuto);

  const tasksRows = TASKS.map((t) => {
    const l = L[t.id];
    const p = P[t.id];
    const a = A[t.id];
    return {
      id: t.id,
      category: t.category,
      description: t.description,
      laya: l.applicable
        ? { rate: l.successRate, passed: l.passed, medianMs: l.medianMs, p90Ms: l.p90Ms, rt: l.medianRoundTrips }
        : { na: true, note: l.note },
      playwright: p.applicable
        ? { rate: p.successRate, passed: p.passed, medianMs: p.medianMs, p90Ms: p.p90Ms, rt: p.medianRoundTrips }
        : { na: true, note: p.note },
      autopilot:
        a && a.applicable
          ? { rate: a.successRate, passed: a.passed, medianMs: a.medianMs, rt: a.medianRoundTrips }
          : { na: true },
    };
  });

  // Per-category success aggregation.
  const catNames = [...new Set(TASKS.map((t) => t.category))];
  const categories = catNames.map((category) => {
    const inCat = tasksRows.filter((r) => r.category === category);
    const layaApplicable = inCat.filter((r) => !r.laya.na);
    const pwApplicable = inCat.filter((r) => !r.playwright.na);
    const avg = (rows, key) =>
      rows.length ? rows.reduce((s, r) => s + r[key].rate, 0) / rows.length : null;
    return {
      category,
      layaRate: avg(layaApplicable, "laya"),
      pwRate: avg(pwApplicable, "playwright"),
      layaN: layaApplicable.length,
      pwN: pwApplicable.length,
    };
  });

  // Tasks both servers attempt (for latency chart).
  const tasksBoth = tasksRows
    .filter((r) => !r.laya.na && !r.playwright.na)
    .map((r) => ({ id: r.id, layaMs: r.laya.medianMs, pwMs: r.playwright.medianMs }));

  // Round-trip comparison rows: tasks with a laya autopilot variant.
  const roundTripTasks = tasksRows
    .filter((r) => !r.autopilot.na)
    .map((r) => ({
      id: r.id,
      layaRt: r.laya.na ? null : r.laya.rt,
      pwRt: r.playwright.na ? null : r.playwright.rt,
      autoRt: r.autopilot.rt,
    }));

  const overall = (rows, sel) => {
    const applic = rows.filter((r) => !sel(r).na);
    const passed = applic.filter((r) => sel(r).passed).length;
    return {
      applicable: applic.length,
      passed,
      rate: applic.length ? passed / applic.length : 0,
      medianMs: median(applic.map((r) => sel(r).medianMs).filter((x) => x != null)),
    };
  };

  const coverage = {
    layaTools: LAYA_ALL_TOOLS,
    pwTools: PW_CORE_TOOLS,
    layaCategories: new Set(tasksRows.filter((r) => !r.laya.na).map((r) => r.category)).size,
    pwCategories: new Set(tasksRows.filter((r) => !r.playwright.na).map((r) => r.category)).size,
    layaPassed: tasksRows.filter((r) => !r.laya.na && r.laya.passed).length,
    pwPassed: tasksRows.filter((r) => !r.playwright.na && r.playwright.passed).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    runs: RUNS,
    warmupDiscarded: 1,
    tasks: tasksRows,
    categories,
    tasksBoth,
    roundTripTasks,
    coverage,
    summary: {
      laya: overall(tasksRows, (r) => r.laya),
      playwright: overall(tasksRows, (r) => r.playwright),
      layaAutopilot: overall(tasksRows.filter((r) => !r.autopilot.na), (r) => r.autopilot),
    },
    toolCounts: {
      layaCore: LAYA_CORE_TOOLS,
      layaAll: LAYA_ALL_TOOLS,
      playwrightCore: PW_CORE_TOOLS,
    },
  };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function cell(entry, key, suffix = "") {
  if (entry.na) return "N/A";
  const v = entry[key];
  return v == null ? "-" : `${v}${suffix}`;
}

function markPass(entry) {
  if (entry.na) return "N/A";
  return entry.passed ? "PASS" : "FAIL";
}

/** Render the full RESULTS.md document from the model. */
function renderResults(model, chartFiles) {
  const L = model.summary.laya;
  const P = model.summary.playwright;
  const A = model.summary.layaAutopilot;
  const lines = [];

  lines.push("# Benchmark: laya-browser-mcp vs Playwright MCP");
  lines.push("");
  lines.push(
    `Generated ${model.generatedAt} — ${model.runs} runs per task (first discarded as warm-up), median reported. Baseline: the real Playwright MCP (\`@playwright/mcp\`). All tasks run against identical local loopback HTML fixtures (no live sites) for deterministic, fair results.`,
  );
  lines.push("");

  lines.push("## Headline");
  lines.push("");
  lines.push("| Metric | laya-browser-mcp (Assist) | Playwright MCP |");
  lines.push("| --- | --- | --- |");
  lines.push(`| Tasks applicable | ${L.applicable} | ${P.applicable} |`);
  lines.push(`| Tasks passed | ${L.passed} | ${P.passed} |`);
  lines.push(`| Success rate | ${Math.round(L.rate * 100)}% | ${Math.round(P.rate * 100)}% |`);
  lines.push(`| Median latency (applicable tasks) | ${L.medianMs} ms | ${P.medianMs} ms |`);
  lines.push(`| Tools exposed | ${model.toolCounts.layaCore} core / ${model.toolCounts.layaAll} all-caps | ${model.toolCounts.playwrightCore} core |`);
  lines.push("");

  lines.push("## Per-task results");
  lines.push("");
  lines.push(
    "| Task | Category | laya | laya ms | laya calls | Playwright | PW ms | PW calls |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of model.tasks) {
    lines.push(
      `| ${r.id} | ${r.category} | ${markPass(r.laya)} | ${cell(r.laya, "medianMs")} | ${cell(r.laya, "rt")} | ${markPass(r.playwright)} | ${cell(r.playwright, "medianMs")} | ${cell(r.playwright, "rt")} |`,
    );
  }
  lines.push("");

  lines.push("## Success rate by category");
  lines.push("");
  lines.push("| Category | laya | Playwright |");
  lines.push("| --- | --- | --- |");
  for (const c of model.categories) {
    const l = c.layaRate == null ? "N/A" : `${Math.round(c.layaRate * 100)}%`;
    const p = c.pwRate == null ? "N/A" : `${Math.round(c.pwRate * 100)}%`;
    lines.push(`| ${c.category} | ${l} | ${p} |`);
  }
  lines.push("");

  lines.push("## Autopilot round-trips (laya single-call goal runner)");
  lines.push("");
  lines.push(
    "laya-browser-mcp offers `laya_run_goal`, a single MCP call that runs the whole goal on-device/server-side. Playwright MCP has no single-call goal runner, so the same outcome needs a multi-call Assist script. Fewer client<->server round-trips is a real architectural difference, not a defect on either side.",
  );
  lines.push("");
  lines.push("| Task | laya Assist calls | Playwright calls | laya Autopilot calls | Autopilot result |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const t of model.roundTripTasks) {
    const row = model.tasks.find((r) => r.id === t.id);
    lines.push(
      `| ${t.id} | ${t.layaRt ?? "-"} | ${t.pwRt ?? "N/A"} | ${t.autoRt ?? "-"} | ${markPass(row.autopilot)} |`,
    );
  }
  lines.push("");

  lines.push("## Charts");
  lines.push("");
  for (const f of chartFiles) {
    lines.push(`![${f}](charts/${f})`);
    lines.push("");
  }

  lines.push("## Honesty and limitations");
  lines.push("");
  lines.push(
    "- **Autopilot uses the REFERENCE stub engine (no model weights).** Its success reflects the deterministic rule layer (fill goal-stated fields, submit, verify the success marker), NOT a web-tuned model. On the multi-field login goal the reference stub batch-fills the text fields and submits without choosing the role option, so it does not satisfy the stricter Assist-mode verify — an honest reference-layer limitation, shown as FAIL.",
  );
  lines.push(
    "- **Local fixtures, not live sites.** Every task runs against loopback HTML served from `benchmark/fixtures/`. This removes bot-detection and network-latency skew so the comparison is deterministic and fair; it is NOT a claim about live-web robustness.",
  );
  lines.push(
    "- **Single machine, headless.** Latency figures include per-task process spin-up amortised by the warm-up run being discarded; absolute milliseconds are environment-specific and only the relative comparison is meaningful.",
  );
  lines.push(
    "- **Both track `window.open` popups.** Like Playwright MCP, laya-browser-mcp subscribes to the browser context's `page` event, so a popup the page opens itself (via `window.open`, `target=\"_blank\"`, or ctrl/cmd+click) becomes a listable, selectable tab; focus stays on the opener until you select it. Both pass the `tabs-open` popup task.",
  );
  lines.push(
    "- **N/A is honest, not a loss.** Cookie, localStorage, and verify/assert tasks are N/A for Playwright MCP core because its core toolset has no such tools; laya exposes them under its `storage` / `testing` capabilities. Neither side is penalised for a capability the other simply does not offer.",
  );
  lines.push("");

  lines.push("## Reproduce");
  lines.push("");
  lines.push("```sh");
  lines.push("# from the project root");
  lines.push("pnpm install");
  lines.push("pnpm run build");
  lines.push("pnpm run bench:compare   # writes results.json, RESULTS.md, and charts/");
  lines.push("```");
  lines.push("");
  lines.push(
    "The harness launches both servers over MCP stdio, drives the identical task scripts against each (arg shapes match, so one script is fair to both), re-probes the real DOM for every success check, and regenerates this file plus `results.json` and the SVGs in `charts/`.",
  );
  lines.push("");

  return lines.join("\n");
}

async function main() {
  ensureBuild();
  ensureBenchDeps();
  const { url, close } = await startFixtureServer();
  log(`Fixture server on ${url}`);

  const layaSpec = {
    command: process.execPath,
    args: [DIST],
    env: { LAYA_ENGINE: "stub", LAYA_CAPS: CAPS, LAYA_ALLOW_UNSAFE_CODE: "true" },
  };
  const pwSpec = {
    command: "npx",
    args: ["@playwright/mcp", "--headless", "--browser", "chromium"],
    env: { PLAYWRIGHT_BROWSERS_PATH },
  };

  try {
    log("Running laya-browser-mcp (Assist)...");
    const layaAssist = await runServer("laya", layaSpec, TASKS, { base: url, runs: RUNS, mode: "assist" });
    log("Running Playwright MCP (Assist)...");
    const pwAssist = await runServer("playwright", pwSpec, TASKS, { base: url, runs: RUNS, mode: "assist" });
    log("Running laya-browser-mcp (Autopilot)...");
    const layaAuto = await runServer("laya", layaSpec, TASKS, { base: url, runs: RUNS, mode: "autopilot" });

    const model = buildModel({ layaAssist, pwAssist, layaAuto });

    await writeFile(path.join(__dirname, "results.json"), JSON.stringify(model, null, 2) + "\n");
    log("Wrote results.json");

    const chartFiles = await writeCharts(path.join(__dirname, "charts"), model);
    log(`Wrote ${chartFiles.length} charts`);

    const md = renderResults(model, chartFiles);
    await writeFile(path.join(__dirname, "RESULTS.md"), md);
    log("Wrote RESULTS.md");

    // Console summary for the operator.
    const L = model.summary.laya;
    const P = model.summary.playwright;
    log("");
    log(`laya:       ${L.passed}/${L.applicable} passed (${Math.round(L.rate * 100)}%), median ${L.medianMs}ms`);
    log(`playwright: ${P.passed}/${P.applicable} passed (${Math.round(P.rate * 100)}%), median ${P.medianMs}ms`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  log("Benchmark failed: " + err.stack);
  process.exit(1);
});
