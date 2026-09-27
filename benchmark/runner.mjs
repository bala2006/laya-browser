/**
 * The benchmark runner.
 *
 * Drives ONE MCP server (given a launch spec: command + args + env) through each applicable
 * task via the MCP SDK stdio client, measuring per task:
 *   - success (bool): the task's own verify() predicate, which re-probes the real DOM.
 *   - wall-clock ms: time to run the task's assist script (or autopilot variant).
 *   - round-trips: number of MCP tool calls the script issued (client<->server round-trips).
 *
 * Each task runs N times (default 5); the first run is discarded as warm-up and the rest are
 * summarised as median + p90. Every tool call and verify is guarded so a thrown error or an
 * MCP error result becomes success:false with the error captured, never a crashed run.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Extract the concatenated text from an MCP tool result's content blocks. */
function textOf(result) {
  const blocks = result?.content ?? [];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** First image content block, if any. */
function imageOf(result) {
  const blocks = result?.content ?? [];
  return blocks.find((b) => b.type === "image");
}

/**
 * Parse the value returned by a `browser_evaluate` call, tolerating BOTH result shapes:
 *   - laya-browser-mcp: the raw JSON value, e.g. `"Search"` or `null`.
 *   - Playwright MCP: a Markdown block, e.g. `### Result\n"Search"\n### Ran Playwright code...`.
 * Returns the parsed JS value (string/number/null/object) or undefined when unreadable.
 */
export function parseEvalValue(text) {
  let payload = text;
  const marker = text.indexOf("### Result");
  if (marker !== -1) {
    const rest = text.slice(marker + "### Result".length);
    const end = rest.indexOf("### ");
    payload = (end === -1 ? rest : rest.slice(0, end)).trim();
  }
  payload = payload.trim();
  try {
    return JSON.parse(payload);
  } catch {
    // A bare unquoted string (rare); return as-is.
    return payload === "undefined" ? undefined : payload;
  }
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(nums, p) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
}

/** Whether a task applies to a given server ("laya" | "playwright"), and any required cap. */
export function taskApplies(task, server) {
  if (task.applies === "both") return true;
  if (typeof task.applies === "object" && task.applies !== null) {
    const v = task.applies[server];
    return v !== false && v !== undefined;
  }
  return false;
}

/** Build the per-call helper `h` handed to a task's assist/verify functions. */
function makeHelper(client, base, counter) {
  const stash = new Map();
  const call = async (name, args) => {
    counter.count += 1;
    const res = await client.callTool({ name, arguments: args ?? {} });
    if (res.isError) {
      const t = textOf(res);
      throw new Error(`tool ${name} errored: ${t.slice(0, 300)}`);
    }
    return textOf(res);
  };
  return {
    base,
    call,
    // Like call but returns the first image content block (for screenshots), still counted.
    callRaw: async (name, args) => {
      counter.count += 1;
      const res = await client.callTool({ name, arguments: args ?? {} });
      if (res.isError) throw new Error(`tool ${name} errored`);
      return imageOf(res) ?? { type: "text", data: textOf(res) };
    },
    snapshot: async () => call("browser_snapshot", {}),
    // Verify helpers re-probe the real page; they count as round-trips too (fair to both).
    evalText: async (selector) => {
      const out = await call("browser_evaluate", {
        function: `() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null; }`,
      });
      return parseEvalValue(out);
    },
    evalValue: async (selector) => {
      const out = await call("browser_evaluate", {
        function: `() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.value : null; }`,
      });
      return parseEvalValue(out);
    },
    evalTitle: async () => {
      const out = await call("browser_evaluate", { function: "() => document.title" });
      return parseEvalValue(out);
    },
    stash: (k, v) => stash.set(k, v),
    unstash: (k) => stash.get(k),
  };
}

/** Connect an MCP stdio client to a launch spec. */
async function connect(spec) {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env },
    stderr: "ignore",
  });
  const client = new Client({ name: "laya-bench", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/** Run a single task once (warm session), returning { success, ms, roundTrips, error }. */
async function runTaskOnce(client, base, task, mode) {
  const counter = { count: 0 };
  const h = makeHelper(client, base, counter);
  const start = performance.now();
  let error;
  try {
    if (mode === "autopilot" && task.autopilot) {
      await task.autopilot(h);
    } else {
      await task.assist(h);
    }
  } catch (err) {
    error = err.message;
  }
  const ms = Math.round(performance.now() - start);
  // Verify against the real page regardless of whether the script threw.
  let success = false;
  try {
    success = await task.verify(h);
  } catch (err) {
    error = error ?? err.message;
    success = false;
  }
  return { success, ms, roundTrips: counter.count, ...(error ? { error } : {}) };
}

/**
 * Run the full task matrix for one server.
 *
 * @param serverName  "laya" | "playwright"
 * @param spec        { command, args, env }
 * @param tasks       task registry
 * @param opts        { base, runs, mode }  mode: "assist" | "autopilot"
 */
export async function runServer(serverName, spec, tasks, opts) {
  const { base, runs = 5, mode = "assist" } = opts;
  const results = [];

  for (const task of tasks) {
    if (!taskApplies(task, serverName)) {
      results.push({
        id: task.id,
        category: task.category,
        applicable: false,
        note: "N/A: server lacks this capability",
      });
      continue;
    }
    if (mode === "autopilot" && !task.autopilot) {
      results.push({ id: task.id, category: task.category, applicable: false, note: "no autopilot variant" });
      continue;
    }

    // Fresh client per task so console/network/tab capture starts clean and one task's
    // failure cannot poison another. Includes process spin-up in the warm-up run only.
    const samples = [];
    let lastError;
    for (let i = 0; i < runs; i += 1) {
      let conn;
      try {
        conn = await connect(spec);
        const r = await runTaskOnce(conn.client, base, task, mode);
        // Discard run 0 as warm-up; keep the rest.
        if (i > 0) samples.push(r);
        else if (r.error) lastError = r.error;
        if (r.error) lastError = r.error;
      } catch (err) {
        if (i > 0) samples.push({ success: false, ms: 0, roundTrips: 0, error: err.message });
        lastError = err.message;
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
    const successRate = samples.length ? successes / samples.length : 0;
    const latencies = samples.map((s) => s.ms);
    const roundTrips = samples.map((s) => s.roundTrips).filter((n) => n > 0);
    results.push({
      id: task.id,
      category: task.category,
      applicable: true,
      mode,
      runs: samples.length,
      successRate,
      passed: successRate >= 0.5,
      medianMs: median(latencies),
      p90Ms: percentile(latencies, 90),
      medianRoundTrips: median(roundTrips),
      ...(lastError ? { lastError } : {}),
    });
  }

  return results;
}
