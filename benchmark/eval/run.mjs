#!/usr/bin/env node
/**
 * Step-scored, teacher-forced evaluation of the on-device decision model.
 *
 * For every case in ./cases.mjs: load the page, and at each oracle step build the SAME model
 * input the Autopilot loop builds (captureFast -> buildState -> jev history), ask the engine,
 * score its answer against the oracle step, then execute the ORACLE step so the next state is
 * reached from a correct history. No rule layer, no escalation: this measures the model.
 *
 * usage: pnpm run build && node benchmark/eval/run.mjs --model <LAYA_MODEL_DIR> [--out file.json]
 *        [--only id1,id2]
 */
import http from "node:http";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { captureFast } from "../../dist/snapshot.js";
import { buildState } from "../../dist/state-builder.js";
import { LayaEngine } from "../../dist/laya/engine.js";
import { actionRecords } from "../../dist/laya/jev-format.js";
import { DEFAULT_CONFIDENCE_THRESHOLD, DEFAULT_OPERATION_THRESHOLDS } from "../../dist/config.js";
import { CASES } from "./cases.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const modelDir = args.model ?? process.env.LAYA_MODEL_DIR;
if (!modelDir) {
  console.error("usage: node benchmark/eval/run.mjs --model <LAYA_MODEL_DIR> [--out results.json] [--only a,b]");
  process.exit(2);
}
const only = args.only ? new Set(args.only.split(",")) : undefined;
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Serve one case's pages at a loopback origin (query strings ignored for routing). */
function serve(pages) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const html = pages[path];
    res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(html ?? "not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** The loop's projection of a FastSnapshot to the Snapshot the state builder consumes. */
const project = (f) => ({ url: f.url, title: f.title, visibleText: f.visibleText, controls: f.controls, text: f.text, canScroll: f.canScroll, viewportText: f.viewportText });

async function executeOracle(page, step) {
  if (step.sel === "@scroll") await page.mouse.wheel(0, 560);
  else if (step.sel === "@wait") { /* the wait itself is `after` */ }
  else if (step.op === "TYPE_TEXT") await page.locator(step.sel).fill(step.value);
  else if (step.op === "SELECT") await page.locator(step.sel).selectOption({ label: step.value });
  else await page.locator(step.sel).first().click();
  await page.waitForTimeout(step.after ?? 120);
}

function score(step, decision, state) {
  const control = decision.target ? state.controls.find((c) => c.ref === decision.target) : undefined;
  const opOk = decision.operation === step.op || (step.alt ?? []).includes(decision.operation);
  const wantTarget = decision.operation === step.op ? step.target : step.altTarget;
  const targeted = ["CLICK", "TYPE_TEXT", "SELECT"].includes(decision.operation);
  let targetOk = true;
  if (opOk && targeted) {
    targetOk = norm(control?.name) === norm(wantTarget);
    if (targetOk && decision.operation === "SELECT") targetOk = norm(decision.value) === norm(step.value);
  }
  const expectedOffered =
    !step.target || state.controls.some((c) => norm(c.name) === norm(step.target));
  return { opOk, targetOk: opOk && targetOk, chosen: control?.name, expectedOffered };
}

const engine = await LayaEngine.load({ modelDir });
const browser = await chromium.launch({ headless: true });
const records = [];
const episodes = [];

for (const c of CASES) {
  if (only && !only.has(c.id)) continue;
  const server = await serve(c.pages);
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(base + "/");
  const history = [];
  let prevSnap;
  let allOk = true;
  for (let i = 0; i < c.steps.length; i++) {
    const step = c.steps[i];
    const snap = project(await captureFast(page));
    const last = history.at(-1);
    if (last && last.pageChanged === null && prevSnap) {
      last.pageChanged = snap.url !== prevSnap.url || snap.text !== prevSnap.text;
    }
    const state = { ...buildState(c.goal, snap, []), history: history.map((h) => ({ ...h })) };
    const t0 = performance.now();
    const decision = await engine.decide(state);
    const ms = performance.now() - t0;
    const s = score(step, decision, state);
    const rec = {
      case: c.id, step: i + 1, expected: step.op, expectedTarget: step.target ?? null,
      op: decision.operation, target: s.chosen ?? null, value: decision.value ?? null,
      opConf: +decision.operationConfidence.toFixed(4), targetConf: +decision.targetConfidence.toFixed(4),
      opOk: s.opOk, ok: s.targetOk, expectedOffered: s.expectedOffered, ruleOwned: !!step.ruleOwned,
      controls: state.controls.length, ms: Math.round(ms),
    };
    records.push(rec);
    if (!step.ruleOwned) allOk &&= rec.ok;
    if (step.op === "DONE" || step.op === "BLOCKED") break;
    // Teacher forcing: record the ORACLE action in history, then execute it.
    const oracleControl = state.controls.find((x) => norm(x.name) === norm(step.target));
    const oracleDecision =
      step.op === "SCROLL_DOWN" || step.op === "WAIT"
        ? { operation: step.op }
        : { operation: step.op, target: oracleControl?.ref ?? "e0", value: step.value };
    const recs = actionRecords(oracleDecision, oracleControl ? state.controls : [{ ref: "e0", name: step.target, role: "button", tag: "button", editable: false, index: 0 }]);
    history.push(...recs);
    prevSnap = snap;
    await executeOracle(page, step);
  }
  episodes.push({ case: c.id, allOk });
  await context.close();
  server.close();
  process.stderr.write(`${c.id}: ${records.filter((r) => r.case === c.id).map((r) => `${r.ok ? "+" : r.ruleOwned ? "~" : "-"}${r.op}`).join(" ")}\n`);
}

await browser.close();
await engine.close();

// ---- report -------------------------------------------------------------------------------
const scored = records.filter((r) => !r.ruleOwned);
const pct = (n, d) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);
const conf = (r) => Math.min(r.opConf, r.targetConf);
const byOp = {};
for (const r of scored) {
  const b = (byOp[r.expected] ??= { n: 0, op: 0, both: 0 });
  b.n++; b.op += r.opOk ? 1 : 0; b.both += r.ok ? 1 : 0;
}
const bins = [0, 0.3, 0.5, 0.7, 0.85, 1.0001];
const calibration = bins.slice(0, -1).map((lo, i) => {
  const inBin = scored.filter((r) => conf(r) >= lo && conf(r) < bins[i + 1]);
  return { bin: `${lo.toFixed(2)}-${Math.min(1, bins[i + 1]).toFixed(2)}`, n: inBin.length, accuracy: pct(inBin.filter((r) => r.ok).length, inBin.length) };
});
const gate = [0.3, 0.4, 0.5, 0.6, 0.7, 0.85].map((t) => {
  const kept = scored.filter((r) => conf(r) >= t);
  return { threshold: t, coverage: pct(kept.length, scored.length), accuracy: pct(kept.filter((r) => r.ok).length, kept.length) };
});
const perOp = scored.filter((r) => conf(r) >= (DEFAULT_OPERATION_THRESHOLDS[r.op] ?? DEFAULT_CONFIDENCE_THRESHOLD));
const calibratedGate = { local: `${perOp.length}/${scored.length}`, accuracy: pct(perOp.filter((r) => r.ok).length, perOp.length) };
const ms = scored.map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  steps: scored.length,
  stepAccuracy: pct(scored.filter((r) => r.ok).length, scored.length),
  operationAccuracy: pct(scored.filter((r) => r.opOk).length, scored.length),
  episodesAllRight: `${episodes.filter((e) => e.allOk).length}/${episodes.length}`,
  expectedTargetNotOffered: scored.filter((r) => !r.expectedOffered).length,
  medianDecideMs: ms[Math.floor(ms.length / 2)],
  byOperation: Object.fromEntries(Object.entries(byOp).map(([k, v]) => [k, `${v.both}/${v.n} (op ${v.op}/${v.n})`])),
  calibration,
  gate,
  calibratedGate,
};
console.log(JSON.stringify(summary, null, 2));
if (args.out) writeFileSync(args.out, JSON.stringify({ summary, records }, null, 2));
