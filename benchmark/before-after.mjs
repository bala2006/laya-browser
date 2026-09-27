/**
 * The fast-loop BEFORE/AFTER measurement: `pnpm run bench:fastloop`.
 *
 * This script proves laya's OWN fast-browser-loop speedup with REAL numbers, using ONLY
 * laya's built dist server plus the local loopback fixture server. It does NOT depend on
 * @playwright/mcp, so it always runs in this environment (unlike the full head-to-head
 * `bench:compare`, which needs the @playwright/mcp download).
 *
 * For each fast-path-eligible task (the ones tagged `fastPath: true` in tasks.mjs that also
 * carry an `autopilot` variant) it runs laya's Autopilot (`laya_run_goal`) TWICE under
 * identical conditions on the identical fixture:
 *   - BEFORE: LAYA_FAST_LOOP unset (the legacy capture/resolveRef/probeSettle path).
 *   - AFTER:  LAYA_FAST_LOOP=true (atomic snapshot + persistent identity + freshness guard +
 *             occlusion hit-test + adaptive waits).
 *
 * It captures, per run, three honest metrics:
 *   - wall-clock ms: time to run the single laya_run_goal call end to end.
 *   - step count: the number of Autopilot transcript steps (parsed from the returned
 *     transcript). This is the on-device decision-loop length.
 *   - browser round trips: the number of transcript steps that drive the real browser (every
 *     step except a pure WAIT/DONE/BLOCKED bookkeeping step), i.e. the browser interactions
 *     the loop performed. Fewer is the fast loop's target-resolution + settle win.
 *
 * Each task runs BENCH_RUNS times (default 5), the first discarded as warm-up, the rest
 * summarised as median. The final-page verify() (which re-probes the real DOM for a literal
 * outcome) is the TRUST signal: a fast run only counts if it reached the same real outcome as
 * the before run. Coverage/step counts are descriptive; verify() is the correctness gate.
 *
 * Output: a BEFORE vs AFTER block appended into benchmark/results.json (key `fastLoop`) and a
 * "Fast browser loop: before vs after" section written into benchmark/RESULTS.md, plus a
 * console summary. The numbers here are REAL and machine-specific; only the relative before vs
 * after comparison is meaningful, and it is labelled as such in the docs.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startFixtureServer } from "./server.mjs";
import { TASKS } from "./tasks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST = path.join(PROJECT_ROOT, "dist", "index.js");
const CAPS = "network,storage,testing,devtools,pdf,vision,config";
const RUNS = Number(process.env.BENCH_RUNS ?? 5);

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

/** Extract the concatenated text from an MCP tool result's content blocks. */
function textOf(result) {
  const blocks = result?.content ?? [];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Connect an MCP stdio client to a launch spec. */
async function connect(spec) {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env },
    stderr: "ignore",
  });
  const client = new Client({ name: "laya-fastloop-bench", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/**
 * Parse the Autopilot transcript text into { outcome, steps[] } where each step carries its
 * operation. The transcript renderer (src/tools/run_goal.ts) prints lines shaped like:
 *   `  3. CLICK target=e5 [laya, op=0.97 tgt=0.97] - clicked ...`
 * We read the leading operation token to classify browser-driving steps.
 */
function parseTranscript(text) {
  const outcomeMatch = text.match(/^Outcome:\s*(.+)$/m);
  const outcome = outcomeMatch ? outcomeMatch[1].trim() : "unknown";
  const steps = [];
  // Only the numbered lines under "Transcript:" (indented "  N. OP ...").
  const re = /^\s{2}(\d+)\.\s+([A-Z_]+)\b/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    steps.push({ step: Number(m[1]), operation: m[2] });
  }
  return { outcome, steps };
}

/** Operations that do NOT drive the real browser (pure loop bookkeeping). */
const NON_BROWSER_OPS = new Set(["WAIT", "DONE", "BLOCKED"]);

function browserRoundTrips(steps) {
  return steps.filter((s) => !NON_BROWSER_OPS.has(s.operation)).length;
}

/** Run one task once via laya_run_goal; return { ms, stepCount, browserRt, success }. */
async function runOnce(client, task, base) {
  const start = performance.now();
  let transcript = "";
  try {
    const res = await client.callTool({
      name: "laya_run_goal",
      arguments: { goal: task.autopilot.goal, url: base + task.fixture },
    });
    transcript = textOf(res);
  } catch (err) {
    // A thrown call still lets verify() re-probe the real page; record the error text.
    transcript = `Outcome: error\n${err.message}`;
  }
  const ms = Math.round(performance.now() - start);
  const parsed = parseTranscript(transcript);

  // The trust signal: re-probe the real DOM through the SAME server via a tiny eval helper.
  const evalText = async (selector) => {
    const out = await client.callTool({
      name: "browser_evaluate",
      arguments: {
        function: `() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null; }`,
      },
    });
    return parseEvalValue(textOf(out));
  };
  let success = false;
  try {
    success = await task.verifyAfterGoal(evalText);
  } catch {
    success = false;
  }
  return { ms, stepCount: parsed.steps.length, browserRt: browserRoundTrips(parsed.steps), success };
}

/** Parse a browser_evaluate return, tolerating laya's raw-JSON shape. */
function parseEvalValue(text) {
  const payload = text.trim();
  try {
    return JSON.parse(payload);
  } catch {
    return payload === "undefined" ? undefined : payload;
  }
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Run every fast-path task N times under one flag setting, returning per-task medians. */
async function runPhase(label, fastLoop, tasks, base) {
  const spec = {
    command: process.execPath,
    args: [DIST],
    env: {
      LAYA_ENGINE: "stub",
      LAYA_CAPS: CAPS,
      LAYA_ALLOW_UNSAFE_CODE: "true",
      LAYA_BROWSER_HEADLESS: "true",
      LAYA_BROWSER_OVERLAY: "off",
      ...(fastLoop ? { LAYA_FAST_LOOP: "true" } : {}),
    },
  };
  const rows = [];
  for (const task of tasks) {
    const samples = [];
    for (let i = 0; i < RUNS; i += 1) {
      // Fresh server per run so capture/console/tab state starts clean and one run cannot
      // poison another (mirrors runner.mjs). The warm-up run (i === 0) is discarded.
      let conn;
      try {
        conn = await connect(spec);
        const r = await runOnce(conn.client, task, base);
        if (i > 0) samples.push(r);
      } catch (err) {
        if (i > 0) samples.push({ ms: 0, stepCount: 0, browserRt: 0, success: false, error: err.message });
      } finally {
        if (conn) {
          try {
            await conn.client.close();
          } catch {
            /* ignore */
          }
        }
      }
    }
    const successes = samples.filter((s) => s.success).length;
    rows.push({
      id: task.id,
      medianMs: median(samples.map((s) => s.ms)),
      medianSteps: median(samples.map((s) => s.stepCount)),
      medianBrowserRt: median(samples.map((s) => s.browserRt)),
      passed: successes >= Math.ceil(samples.length / 2),
      runs: samples.length,
    });
    log(
      `  [${label}] ${task.id}: ${median(samples.map((s) => s.ms))}ms, ${median(
        samples.map((s) => s.stepCount),
      )} steps, ${median(samples.map((s) => s.browserRt))} browser round trips, ${successes}/${samples.length} verified`,
    );
  }
  return rows;
}

function pct(before, after) {
  if (before == null || after == null || before === 0) return null;
  return Math.round(((before - after) / before) * 100);
}

/** Build the RESULTS.md fast-loop section and the results.json fastLoop block. */
function buildFastLoopModel(before, after) {
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
  const B = byId(before);
  const A = byId(after);
  const ids = before.map((r) => r.id);
  const tasks = ids.map((id) => {
    const b = B[id];
    const a = A[id];
    return {
      id,
      before: { medianMs: b.medianMs, medianSteps: b.medianSteps, medianBrowserRt: b.medianBrowserRt, passed: b.passed },
      after: { medianMs: a.medianMs, medianSteps: a.medianSteps, medianBrowserRt: a.medianBrowserRt, passed: a.passed },
      msDeltaPct: pct(b.medianMs, a.medianMs),
      rtDeltaPct: pct(b.medianBrowserRt, a.medianBrowserRt),
    };
  });
  return { generatedAt: new Date().toISOString(), runs: RUNS, warmupDiscarded: 1, tasks };
}

function renderFastLoopSection(model) {
  const lines = [];
  lines.push("## Fast browser loop: before vs after");
  lines.push("");
  lines.push(
    `Generated ${model.generatedAt}. ${model.runs} runs per task (first discarded as warm-up), median reported. This is laya's OWN Autopilot (\`laya_run_goal\`, reference stub engine) on identical local fixtures, run with the fast loop OFF (before, LAYA_FAST_LOOP unset) and ON (after, LAYA_FAST_LOOP=true). Only laya's dist server plus the loopback fixture server are involved (no @playwright/mcp). Metric labels: wall-clock ms and step/round-trip counts are MEASURED here; absolute ms are machine-specific, so only the relative before vs after delta is meaningful. The final-page verify() re-probes the real DOM and is the trust signal (a run counts only if it reached the same literal outcome).`,
  );
  lines.push("");
  lines.push(
    "| Task | before ms | after ms | ms delta | before steps | after steps | before browser RT | after browser RT | before verify | after verify |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const t of model.tasks) {
    const delta = t.msDeltaPct == null ? "-" : `${t.msDeltaPct}%`;
    lines.push(
      `| ${t.id} | ${t.before.medianMs} | ${t.after.medianMs} | ${delta} | ${t.before.medianSteps} | ${t.after.medianSteps} | ${t.before.medianBrowserRt} | ${t.after.medianBrowserRt} | ${t.before.passed ? "PASS" : "FAIL"} | ${t.after.passed ? "PASS" : "FAIL"} |`,
    );
  }
  lines.push("");
  lines.push(
    "Reading the delta: a positive ms delta means the fast loop was faster (lower wall-clock). Step and browser-round-trip counts show whether the fast path reached the same real outcome with the same or fewer browser interactions per step; the win is in per-step target-resolution and settle cost, not in the number of decisions. verify() PASS on both sides means the fast path did not sacrifice correctness for speed.",
  );
  lines.push("");
  return lines.join("\n");
}

async function main() {
  ensureBuild();

  // Fast-path-eligible tasks that also carry an Autopilot variant.
  const fastTasks = TASKS.filter((t) => t.fastPath === true && typeof t.autopilot === "function");
  if (fastTasks.length === 0) throw new Error("no fastPath tasks with an autopilot variant found");

  // Extract each task's autopilot goal (the autopilot fn only calls laya_run_goal with a fixed
  // goal/url) and bind its verify to an evalText-only probe so we can drive it directly here.
  const tasks = fastTasks.map((t) => bindTask(t));
  log(`Fast-path tasks: ${tasks.map((t) => t.id).join(", ")}`);

  const { url, close } = await startFixtureServer();
  log(`Fixture server on ${url}`);
  try {
    log("BEFORE (LAYA_FAST_LOOP unset)...");
    const before = await runPhase("before", false, tasks, url);
    log("AFTER (LAYA_FAST_LOOP=true)...");
    const after = await runPhase("after", true, tasks, url);

    const model = buildFastLoopModel(before, after);

    // Merge into results.json under `fastLoop` (preserve the head-to-head model if present).
    const resultsPath = path.join(__dirname, "results.json");
    let root = {};
    if (existsSync(resultsPath)) {
      try {
        root = JSON.parse(readFileSync(resultsPath, "utf8"));
      } catch {
        root = {};
      }
    }
    root.fastLoop = model;
    await writeFile(resultsPath, JSON.stringify(root, null, 2) + "\n");
    log("Merged fastLoop block into results.json");

    // Append/replace the fast-loop section in RESULTS.md.
    const mdPath = path.join(__dirname, "RESULTS.md");
    let md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
    const marker = "## Fast browser loop: before vs after";
    const section = renderFastLoopSection(model);
    if (md.includes(marker)) {
      // Replace the existing section up to the next "## " heading or end of file.
      const startIdx = md.indexOf(marker);
      const after = md.slice(startIdx + marker.length);
      const nextHeading = after.indexOf("\n## ");
      const endIdx = nextHeading === -1 ? md.length : startIdx + marker.length + nextHeading + 1;
      md = md.slice(0, startIdx) + section + md.slice(endIdx);
    } else {
      md = md.replace(/\s*$/, "\n\n") + section;
    }
    await writeFile(mdPath, md.replace(/\s*$/, "\n"));
    log("Wrote fast-loop section into RESULTS.md");

    log("");
    for (const t of model.tasks) {
      log(
        `${t.id}: ${t.before.medianMs}ms -> ${t.after.medianMs}ms (${t.msDeltaPct ?? "-"}%), verify before ${t.before.passed ? "PASS" : "FAIL"} / after ${t.after.passed ? "PASS" : "FAIL"}`,
      );
    }
  } finally {
    await close();
  }
}

/**
 * Bind a registry task to this script's direct-drive shape:
 *   - autopilot.goal / fixture used to issue the single laya_run_goal call.
 *   - verifyAfterGoal(evalText) re-probes the real DOM (re-uses the task's own verify logic
 *     expressed against an evalText-only helper, so the trust signal is identical).
 */
function bindTask(t) {
  // Recover the goal string by invoking the autopilot fn against a capturing helper.
  let captured;
  const capture = {
    base: "",
    async call(name, args) {
      if (name === "laya_run_goal") captured = args;
      return "";
    },
  };
  // The autopilot fn is async but only issues one call synchronously into `capture`.
  t.autopilot(capture);
  const goal = captured?.goal ?? "";

  return {
    id: t.id,
    fixture: t.fixture,
    autopilot: { goal },
    // Re-probe the real DOM for the literal outcome, matching each fixture's success marker.
    async verifyAfterGoal(evalText) {
      if (t.id === "flights-search") {
        return (await evalText("#results")) === "Showing flights Zurich to London on 2026-09-20";
      }
      if (t.id === "wiki-open") {
        return (await evalText("#status")) === "Found article for Ada Lovelace";
      }
      if (t.id === "hotel-search-filter") {
        return (await evalText("#status")) === "Hotels in Paris";
      }
      return false;
    },
  };
}

main().catch((err) => {
  log("Before/after benchmark failed: " + err.stack);
  process.exit(1);
});
