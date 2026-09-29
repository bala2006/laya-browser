# laya-browser-mcp Plan

`laya-browser-mcp` is a TypeScript / Node 22 MCP server that is a **superset of Playwright
MCP** plus a **local Laya on-device decision engine**. It exposes the familiar
ref-based Playwright toolset (Assist mode) and adds an Autopilot loop (`laya_run_goal`) that
drives structured web tasks with a local Laya "System 1" decision model, deterministic rules,
and MCP-sampling escalation to the client LLM when confidence is low. The on-device decision is
one signal behind the `0.85` escalation gate, not a sub-100ms path: measured on CPU,
`LayaEngine.decide` costs hundreds of ms per step (median ~407 ms web-agent / ~810-870 ms
reference; see the FEAT-004 ledger). It auto-selects the best available onnxruntime execution
provider (CUDA on Linux x64 -> DirectML on Windows x64/arm64 -> CPU; WebGPU is experimental and
override-only, not auto-selected); the GPU speedup is to-be-measured on hardware with
a supported GPU (this project's CI has none).

Honest positioning: this is a **fast local decision layer with LLM fallback**. It is strong
on structured forms and weak on arbitrary real sites (the web-agent checkpoint scores ~97.7%
per-step on clean synthetic forms but only ~1 step in 5 fully right on real Mind2Web sites).
It is **not** a fully autonomous general web agent.

## Phased plan

- **Phase 0: Scaffold + core types + spike (FEAT-001, this phase).**
  pnpm + `tsc` (ESM NodeNext, strict) + vitest toolchain; verified deps installed;
  green baseline (typecheck + build + one meaningful test); the **pure** core type module
  `src/types.ts` that every later phase depends on; the time-boxed ONNX-export spike; this plan.

- **Phase 1: Snapshot + ref boundary + browser lifecycle.**
  `src/snapshot.ts`: an in-page DOM walk that stamps stable `data-laya-ref="eN"` attributes on
  interactive/landmark elements and returns (a) a compact human-readable snapshot with
  `[ref=eN]` markers and (b) a `ref -> metadata` map. `src/browser.ts`: Playwright lifecycle
  and the ref-resolution boundary (`page.locator('[data-laya-ref="eN"]')`, falling back to
  treating `target` as a raw selector). **We own the ref boundary ourselves**: stable
  `playwright-core@1.63.0` does NOT expose a public `_snapshotForAI`/`snapshotForAI` (only
  alpha/mcp-bundled builds do), so no Playwright private API is assumed anywhere.

- **Phase 2: Assist-mode MCP tools.**
  `src/tools/*.ts`: navigate, snapshot, click, type, select, press_key, wait_for, close, using
  the Playwright MCP convention (`element` human-readable description + `target` exact ref or
  selector), zod input schemas. `src/server.ts` / `src/index.ts`: the stdio MCP server. Works
  standalone with **no weights**.

- **Phase 3: State builder + Laya engine + stub.**
  `src/state-builder.ts`: snapshot -> compact typed `PageState` for Laya (numbered controls with
  current values, condensed visible text, recent actions), budgeted to the checkpoint's
  `max_len`. `src/laya/engine.ts`: `LayaDecisionEngine` wrapping `@receptron/laya`
  (`Laya.load` + `systemOne` narrow choice questions -> `Decision`). `src/laya/stub.ts`: a
  deterministic fake engine implementing the same interface for offline tests.

- **Phase 4: Autopilot loop.**
  `src/autopilot/loop.ts`: snapshot -> state -> decision -> execute -> repeat, until DONE/BLOCKED.
  Narrow Laya decisions + deterministic rules (fill goal-stated values; after typing/opening a
  control choose from the options that appeared; submit then open the named item) + **one** text
  plan per task. Low confidence or BLOCKED escalates to the client LLM via **MCP sampling**.
  Degrades gracefully when weights are absent. A DONE decision is not proof of success: the
  loop verifies the final page independently.

- **Phase 5: Escalation + rules + hardening + benchmark + docs (DONE).**
  `src/autopilot/policy.ts` (deterministic-rule layer around the narrow Laya decision:
  fill goal-stated values -> choose from options that appeared -> submit),
  `src/autopilot/escalation.ts` (MCP-sampling escalation to the client LLM via
  `server.server.createMessage`, parsed back into a `Decision` with `source='llm'`, graceful
  `BLOCKED` when the client lacks sampling), the decision pipeline wired into
  `src/autopilot/loop.ts` (rule seed -> Laya narrow -> confidence check -> escalate),
  `src/config.ts` (single parse point for env + args + options), `src/safety.ts` (domain
  allow-list + destructive-form guard, applied in the tools and the loop), an offline
  benchmark harness (`test/benchmark/`, `pnpm run bench`) over local fixtures, and the
  escalation/safety/benchmark vitest tests. README with honest positioning + all tool
  schemas; a MIT LICENSE file. A real-weights test/bench gated behind `LAYA_MODEL_DIR`.

- **Phase 6: Full Playwright MCP parity + cross-browser + faster Autopilot (Part 2, DONE).**
  See the "Phase 6 addendum" below for the tool taxonomy, capability-gating design,
  cross-browser design, the broadened Autopilot operation model, the per-group sequencing
  outcome, and the refreshed ledger.

- **Phase 7: Fast browser loop + honest before/after measurement (DONE; the fast loop is now
  always-on after Phase 8).**
  A jev-ultrafast-inspired Autopilot perception/act path originally behind `LAYA_FAST_LOOP`,
  plus a jev-inspired but fully local benchmark and an honest laya-only before/after run. See
  the "Phase 7 addendum" below for the levers, the measured numbers, the jev-runnability
  finding, and the Phase 0 spike note on per-operation target heads. Phase 8 collapsed the fast
  loop into the single always-on browser path and retired the `LAYA_FAST_LOOP` toggle.

- **Phase 8: dynamic EP selection, dead-end fix, speed levers, and de-nuance (DONE).**
  Probe-verified execution-provider auto-selection (FEAT-002), the low-confidence-BLOCKED
  dead-end fix (FEAT-003), CPU-measured speed levers plus a documented-and-skipped int8 path
  (FEAT-004), and the collapse to one always-on loop with a pruned env-flag surface (FEAT-005).
  See the "Phase 8 addendum" below and the updated ledger.

## Phase 6 addendum: full tool parity, capability gating, cross-browser, faster Autopilot

### Tool taxonomy (71 tools, as registered)

The Assist toolset is a superset of Playwright MCP, grouped by capability. Counts are the
tools actually registered (cross-checked against the `REGISTRY` / `assistToolNames` in
`src/tools/index.ts`):

- **CORE (24, always on):** navigate, navigate_back, resize, snapshot, click, type, hover,
  find, drag, drop, fill_form, evaluate, select_option, press_key, wait_for, close, tabs,
  handle_dialog, file_upload, take_screenshot, console_messages, network_requests,
  network_request, run_code_unsafe.
- **STORAGE (17):** cookie list/get/set/delete/clear, localStorage list/get/set/delete/clear,
  sessionStorage list/get/set/delete/clear, storage_state save, set_storage_state restore.
- **NETWORK (4):** route, route_list, unroute, network_state_set.
- **TESTING (5):** generate_locator, verify_element_visible, verify_text_visible,
  verify_list_visible, verify_value.
- **PDF (1):** pdf_save (Chromium-only).
- **VISION (6):** mouse move_xy, click_xy, drag_xy, down, up, wheel.
- **CONFIG (1):** get_config.
- **DEVTOOLS (13):** start/stop_tracing and highlight/hide_highlight (real), plus
  start/stop_video, video_chapter, video_show/hide_actions, start/stop_recording, annotate,
  resume (honest no-ops).

### Capability-gating design

Registration is table-driven. `REGISTRY: RegisteredTool[]` in `src/tools/index.ts` is a list of
`{ module, capability? }` entries; the effective `{ name, capability, factory }` is
`{ module.definition.name, entry.capability, module.makeHandler }`. An entry with no
`capability` is CORE and always registered; a tagged entry is registered only when its
capability is in the enabled set. The enabled set comes from `config.capabilities`, parsed once
in `src/config.ts` from `LAYA_CAPS` (comma/space list, unknown names dropped). The **default is
core-only** (empty `LAYA_CAPS`), mirroring Playwright MCP, which exposes only its core toolset
unless capabilities are opted into. `assistToolNames(caps)` returns exactly the names that
register under a given set and is what the tests assert against, so docs, tests, and runtime all
agree on one source of truth. `browser_run_code_unsafe` is intentionally CORE (always listed)
but refuses at call time unless `LAYA_ALLOW_UNSAFE_CODE=true`, so gating a dangerous tool is a
runtime opt-in, not a hidden capability.

### Cross-browser design

Engine selection is confined to `src/browser.ts`. `BrowserSession` gained an
`engine: 'chromium' | 'firefox' | 'webkit'` option (default `chromium`) and a `BROWSER_TYPES`
map over `{ chromium, firefox, webkit }` from `playwright`. `launch()` picks the browser type by
engine and passes `channel` **only** for chromium (Firefox/WebKit have no channel). Everything
else (viewport, timeouts, lazy launch, multi-tab, console/network/dialog listeners, routing,
storage, the ref boundary) is identical across engines. `src/server.ts` threads
`config.browserEngine` (from `LAYA_BROWSER`) into the session options. Firefox/WebKit are not
preinstalled and download via `pnpm exec playwright install firefox webkit`.

### Broadened Autopilot operation model

The `Operation`/`Decision` union (`src/types.ts`, pure) is broadened as a **discriminated union
so illegal (operation, payload) states are unrepresentable**. Added: `HOVER` (targeted),
`NAVIGATE_BACK` (targetless), `PRESS_KEY` (carries `key`), `FILL_FORM` (carries `fields[]`, no
single `target`), `SCREENSHOT` (terminal), `VERIFY` (terminal, carries a marker). `execute()` in
`src/autopilot/loop.ts` stays the only IO function and handles each new operation; the batch
field-fill logic is factored into `src/tools/fill.ts` and reused by both `browser_fill_form` and
the `FILL_FORM` batch. The narrow Laya `choice` question keeps a compact operation set (it adds
only `HOVER`/`NAVIGATE_BACK`); batch/payload operations are emitted by the deterministic layer,
not the narrow choice, so the rendered state + option list stay within the `head_max_len`
budget (`RECOMMENDED_MAX_OPTIONS` unchanged at 20).

### Per-group sequencing outcome (the "faster" result)

The deterministic layer prefers **one `FILL_FORM` batch** when two or more goal-mapped editable
fields are unfilled, then submits, instead of N sequential `TYPE_TEXT` steps. Measured offline
(StubEngine + real headless Chromium, `pnpm run bench`) on the two-field `login-multi` goal: the
goal completes in **3 steps** (`FILL_FORM` + `CLICK` + `DONE`) versus **4** for the per-field
path, a 25% step reduction, with **all steps resolved by the rule layer**
(rule/laya/stub/llm = 3/0/0/0, zero escalations) in ~80 to 90 ms wall-clock per case. Single-field
goals keep the `TYPE_TEXT` path.

## Final architecture (as built)

```
MCP client (stdio)
  |
  v
src/index.ts (bin) --loadConfig(env)--> src/config.ts  (parse ONCE, typed config inward)
  |
  v
src/server.ts (McpServer)
  |-- registerAssistTools --> src/tools/*  (navigate/snapshot/click/type/select/press_key/wait_for/close)
  |                              |-- src/browser.ts (Playwright lifecycle + resolveRef boundary)
  |                              |-- src/snapshot.ts (in-page DOM walk -> [ref=eN] + Control[])
  |                              '-- src/safety.ts   (browser_navigate: domain allow-list)
  '-- laya_run_goal --> src/tools/run_goal.ts --> src/autopilot/loop.ts (runGoal)
                                                     |-- src/state-builder.ts (Snapshot -> PageState)
                                                     |-- 1. src/autopilot/policy.ts   (deterministic rule seed)
                                                     |-- 2. src/laya/{engine,stub,index}.ts (narrow Laya decision)
                                                     |-- 3. src/autopilot/escalation.ts (MCP sampling on low conf/BLOCKED)
                                                     |-- src/safety.ts (allow-list + destructive-form guard)
                                                     '-- verifyFinalPage (INDEPENDENT; DONE != success)
```

Boundary discipline: `src/types.ts` is pure; config is parsed once in `src/config.ts`;
Playwright is confined to `src/browser.ts`/`src/snapshot.ts`; ONNX/`@receptron/laya` is
confined to `src/laya/engine.ts`; escalation depends only on an injected `SampleFn`, so it is
unit-testable without a live MCP client.

## Phase 7 addendum: fast browser loop + honest before/after measurement

### The fast loop levers (all behind `LAYA_FAST_LOOP`, default OFF)

Adapted in TypeScript/Playwright from the jev-ultrafast reference (a read-only Python project at
`../jev-ultrafast`). All four levers are confined to `src/snapshot.ts` and `src/browser.ts` and
gated behind the flag, so with the flag unset the loop is byte-identical to `main`:

1. **Atomic snapshot (`captureFast`).** One `page.evaluate` walks the DOM, stamps
   `data-laya-ref="eN"`, and computes each control's freshness guard, viewport rect, a page-level
   marker, and a page key in the same pass. Fewer evaluate calls per step than the legacy
   walk-then-re-query path.
2. **Persistent node identity.** A per-page `WeakMap` gives each interactive element a stable
   integer `nodeId` that survives across snapshots (pruned when detached). The act path resolves
   the node from that map instead of re-running `page.locator('[data-laya-ref=eN]')` at act time,
   removing the cross-snapshot re-query round trip.
3. **Freshness guard plus occlusion hit-test.** Before a targeted click/select the loop re-checks
   the target's semantic guard and the page key in one evaluate, then hit-tests `elementFromPoint`
   at the control center, refusing a covered/off-viewport control (`covered`/`gone`) so the
   existing self-heal re-captures. A correctness guard, not a speed trick.
4. **Adaptive waits.** Instead of a fixed settle, the fast path waits only until the affected
   control settles (for example a combobox list appears), capped by `LAYA_FAST_WAIT_CAP_MS`
   (default 200 ms, mirroring jev's 200 ms autocomplete cap).

### Honest before/after measurement (what ran this session)

The honest deliverable is laya's OWN before/after fast-path numbers on identical local fixtures,
not a jev head-to-head (jev cannot run here; see the ledger). Three jev-inspired but fully local,
deterministic fixtures were added under `benchmark/fixtures/` (a Google-Flights-shaped
multi-field search `flights.html`, a Wikipedia-open search flow `wiki.html` + `wiki-article.html`,
and a hotel search/filter flow `hotels.html`), each with a registered task in `benchmark/tasks.mjs`
whose `verify()` re-probes the real DOM for a literal outcome. A dedicated script
`benchmark/before-after.mjs` (`pnpm run bench:fastloop`) originally ran laya's Autopilot
(`laya_run_goal`, reference stub engine) over the fast-path-eligible tasks TWICE (flag off, then
flag on) and wrote a BEFORE vs AFTER block into `benchmark/RESULTS.md` and `benchmark/results.json`.
NOTE (Phase 2 reorg): the fast loop is now the single, always-on browser path, so the
`LAYA_FAST_LOOP` toggle and that before/after harness were retired; the last recorded numbers are
kept in `benchmark/RESULTS.md` as a historical record, and `pnpm run bench:compare` remains for
end-to-end laya-vs-Playwright-MCP timings.

Commands run this session and their REAL results are recorded in the ledger below.

### Phase 0 spike note: can `@receptron/laya` express per-operation target heads (jev's fan-out)?

**VERIFIED from `src/laya/engine.ts` (no external run needed): NO, not as coded.** `LayaEngine.decide`
asks the operation and the target as TWO narrow `choice` questions in a SINGLE `systemOne` pass, and
the `target` question offers ONE shared control list (`targetCriteria`, capped upstream by
`buildState`). There is no per-operation target head: the chosen operation and the chosen target are
read from the same single inference over the same shared candidate list. jev's design instead
speculatively fans out several operations against several target heads in parallel (its `model.py`
documents "Dynamic operation/target heads" and its README credits a "TypeSafe speculative fan-out"
pattern). Expressing that in laya would require a different question shape (separate per-operation
target heads) than the trained single-shared-list `systemOne` call this checkpoint uses. **This is
INDEPENDENT of the four fast-loop levers above** (they are perception/act mechanics; the fan-out is a
decision-shape change), and it is recorded here as the honest scope boundary for a future phase.

## Phase 8 addendum: dynamic EP selection, dead-end fix, speed levers, de-nuance

### FEAT-002: dynamic execution-provider auto-selection (probe-verified)

A mostly-pure resolver `src/laya/execution-provider.ts` (no `ort`/`playwright` imports) drives
EP selection. `candidateExecutionProviders(platform, arch, override?)` is a PURE function that
returns an ordered `EpCandidate[]` of `{ name, providers }`, where `name` is the human label
for the log line (`cuda` | `directml` | `webgpu` | `cpu`) and `providers` is the onnxruntime
list passed to `Laya.load` (each GPU candidate includes a CPU fallback entry, e.g. cuda ->
`['cuda','cpu']`). When an override (`LAYA_EXECUTION_PROVIDERS`) is supplied it returns exactly
ONE candidate wrapping that list verbatim, so auto-selection is skipped. Otherwise it gates by
the `onnxruntime-node@1.30.0` prebuilt matrix: CUDA first on Linux x64, DirectML first on
win32 x64/arm64, and the list ALWAYS ends with a plain CPU candidate, so resolution can never
fail. WebGPU is experimental and is NOT emitted by auto-selection; it is reachable only via an
explicit `LAYA_EXECUTION_PROVIDERS` override (the `webgpu` label above exists for that path).

Selection is probe-verified: because `Laya.load` throws when a listed EP cannot initialize the
model, attempting the load with a candidate's providers IS the probe. `resolveEngine(candidates,
load, log?)` tries candidates in order, keeps the FIRST whose load resolves, catches each
failure and falls through to the next, and rethrows the last error only when every candidate
fails (so `createEngine` still degrades to `UnavailableEngine`, never crashing the server). The
model loads exactly ONCE (the probe is the load). `src/index.ts` writes ONE stderr startup line
naming the engaged EP: `[laya-browser-mcp] Autopilot engine loaded (execution provider: <name>).`
(never on stdout). This is the ONE fast/decision path; there is no second selection mechanism.

### FEAT-003: break the low-confidence-BLOCKED dead-end

Previously a LOW-CONFIDENCE `BLOCKED` decision plus an UNREACHABLE client LLM (a client with no
MCP sampling, e.g. opencode) trapped the run: `escalate()` dropped the fallback via the
`options.fallback.operation !== 'BLOCKED'` filter, so there was no forward path. The fix adds a
pure resolver `bestSafeProgress(state)` in `src/autopilot/policy.ts` with the resolution order
(a) the policy layer's next action via `policySeed` when it is non-BLOCKED (a policy submit
`CLICK` is offered only when it PASSES `checkDestructiveSubmit`, so best-safe-progress NEVER
proposes a destructive click); (b) a bounded, targetless `SCROLL_DOWN` nudge when the page still
has controls or visible text; (c) `undefined` for a genuinely dead page (the caller keeps the
graceful BLOCKED). The loop injects `bestSafeProgress` into `escalate()` ONLY for the
low-confidence-BLOCKED case. Preserved hard stops: a CONFIDENT `BLOCKED` (operationConfidence >=
gate) still stops, the loop detector still stops a genuinely dead page, and the destructive-form
guard remains the final authority. The R2 no-weights BLOCKED placeholder still degrades
gracefully.

### FEAT-004: CPU speed levers + int8 documented-and-skipped

Two speed properties were VERIFIED in the existing code (no change needed): (1) the ONNX session
is created ONCE by `Laya.load` (stored as `this.session`) and reused across every
`LayaEngine.decide` call (the EP probe is the single load), so there is no per-decision reload;
(2) the state token budget (`stateTextLimit`, default `1200`, bounds `200..8000`) is applied on
the DECIDE hot path: `buildState` clamps `visibleText` and caps controls, and `renderState`
(consumed by `engine.decide`) serializes exactly that clamped state, not only the escalation
prompt. Measured on CPU this session (Node 22.23.2, 8 CPUs): `LayaEngine.decide` median
**407 ms** (min 396, max 419) for the web-agent bundle, extending the existing ~440-490 ms
web-agent / ~810-870 ms reference figures.

`scripts/prepare-model.sh` gained an `int8 [OUT_DIR]` mode that builds the fp32 web-agent bundle
then runs onnxruntime dynamic quantization (`quantize_dynamic`, `QuantType.QInt8`) into a
sibling drop-in `LAYA_MODEL_DIR`. int8 is **documented-and-skipped**: quantization of this
ModernBERT-shaped graph is infeasible with onnxruntime 1.30.0 / onnx 1.23.0 here. `quantize_dynamic`
aborts in its internal strict shape inference with
`onnx...InferenceError: [ShapeInferenceError] Inferred shape and existing shape differ in
dimension 0: (772) vs (256)`. This is NOT a missing-preprocessing issue (`quant_pre_process(...,
skip_symbolic_shape=True)` succeeds on the same model, but `quantize_dynamic` re-runs strict
shape inference and fails identically). The scaffolding is kept intact so it works once a
compatible export or a tolerant onnxruntime version exists. No int8 number was fabricated.

### FEAT-005: collapse to one loop + prune the flag surface

The fast loop (merged in PR #8) is now the SINGLE always-on browser path: the `LAYA_FAST_LOOP`
toggle and the legacy pre-fast-loop capture/prefetch/settle branch in `src/autopilot/loop.ts`
were removed (the fast body runs unconditionally, keeping the F4 speculative-decision reuse and
the FEAT-002 freshness/occlusion guard as the single act path). The decision pipeline was
consolidated into one well-named helper `resolveStepDecision` (rule seed -> local-model decide
-> confidence check -> escalate-if-a-channel-exists -> best-safe-progress); rules stay first and
`RULE_CONFIDENCE 0.97` is unchanged, `src/types.ts` stays pure, config is still parsed once.

Env-knob count went **44 -> 41**. Keep/inline/delete ledger:

- **DELETE `LAYA_FAST_LOOP`** (`fastLoop`): the fast loop is the single always-on path; removed
  the field/override/parse/default const, the `RunGoalOptions`/`RunGoalContext` option, the
  `server.ts` + `run_goal.ts` threading, and the whole `if (fastLoop) {...} else { legacy }`
  branch.
- **INLINE `LAYA_FAST_WAIT_CAP_MS`**: it was only an internal adaptive-wait/settle-probe timing
  cap with no operator-tuning need; inlined to a module constant `FAST_WAIT_CAP_MS = 200` and
  removed the config field/override/parse/default/clamp-test.
- **DELETE `LAYA_CONFIRM_DESTRUCTIVE`** (`confirmDestructive`): dead flag. It was parsed and
  threaded but the loop no longer consulted it: the destructive-submit ask now follows the
  confirmation callback alone. Removed the field/override/parse/threading, the doc/README rows,
  and the parse-only test. Behavior is unchanged (confirm-callback presence alone gates the ask).
- **KEEP (37 others)**: each remaining knob is threaded to real behavior and covered by a
  meaningful test, so none were deleted just to hit a number.

The `bench:fastloop` package.json script and `benchmark/before-after.mjs` (the A/B harness that
toggled `LAYA_FAST_LOOP`) were retired; the last recorded before/after numbers are kept in
`benchmark/RESULTS.md` as a historical record and `bench:compare` remains. Net deletion bias:
16 files changed, 310 insertions, 948 deletions (net 638 lines deleted). Suite green: 318 passed
/ 3 skipped (baseline 322 / 3; the 4 fewer tests were 3 removed flag-parse assertions + 1 removed
confirmDestructive parse test, all meaningful coverage preserved).

### Model-first stays a documented Phase 3 follow-up (NOT implemented)

Rules stay FIRST today (option b): the deterministic rule seed at `RULE_CONFIDENCE 0.97` runs
before the local model and clears the `0.85` gate on structured pages, so the FEAT-003 real-
weights probes show the model is a low-confidence signal behind the gate (see the VERIFIED
FEAT-003 block: on the benchmark fixtures the per-step source breakdown is
`rule/laya/stub/llm = 3/0/0/0` for BOTH real models). Going model-first is a LATER, benchmarked
step, gated on the local model being both FAST and CONFIDENT enough to beat the rules on
structured pages. It is recorded here as a scope boundary and is deliberately NOT implemented in
this phase.

## Verified / inferred / guessed ledger

- **VERIFIED (ran it):**
  - `@receptron/laya@0.1.2` API (`Laya.load` + `systemOne` narrow `choice` questions),
    `head_max_len` 192 throw behavior, and the web-agent ONNX export + tokenizer-rename step
    (logit parity `max |dlogits| = 2.48e-05`).
  - Stable `playwright-core@1.63.0` has no public `_snapshotForAI`/`snapshotForAI`; we own the
    ref boundary via our own DOM walk.
  - `@modelcontextprotocol/sdk@1.30.1` sampling: `McpServer.server.createMessage(params)`
    (result `content` is a single block with `.type`/`.text`) and
    `McpServer.server.getClientCapabilities()?.sampling` for capability detection, confirmed
    against the installed SDK type declarations.
  - The full offline test suite + `pnpm run bench` are green with the stub (3/3 fixtures
    end-to-end success via the independent final-page check, 100% expected-ops COVERAGE, which
    is a subsequence match that does not penalize extra/wrong ops, so it is not a precision
    figure; headless Chromium, no weights). Latest run: 134 passed, 3 skipped.
  - **Full tool parity + capability gating.** All 71 tools register under the expected
    capabilities and `assistToolNames` matches the tables in the README (cross-checked in
    tests and at doc time).
  - **Cross-browser: Firefox VERIFIED, WebKit gated.** Firefox really launches here and drives
    the sign-in fixture to its literal signed-in outcome (a real launch, not skipped). WebKit
    is INFERRED/gated: the binary downloads, but launch fails in this sandbox for missing
    system shared libraries, so the WebKit smoke test probes real launchability once and
    `describe.skipIf`s itself rather than faking a pass. It runs automatically where WebKit can
    launch.
  - **Part 2 batch fill measured offline (with the stub).** The two-field `login-multi` goal
    completes via a single `FILL_FORM` batch in 3 steps versus 4 for the per-field path (25%
    fewer), all resolved by the rule layer (rule/laya/stub/llm = 3/0/0/0, zero escalations),
    ~80 to 90 ms per offline case. Measured with the StubEngine + real Chromium, not real
    weights.
  - **Phase 7 fast-loop before/after (ran this session, REAL numbers).** Ran `pnpm run build`
    (tsc, exit 0), then `BENCH_RUNS=7 node benchmark/before-after.mjs` on identical local
    fixtures with the StubEngine + headless Chromium. Medians (before = `LAYA_FAST_LOOP` unset,
    after = `LAYA_FAST_LOOP=true`), first run discarded as warm-up:
    - `flights-search`: 468 ms -> 513 ms (-10%), 3/3 steps, 2/2 browser round trips, verify
      PASS/PASS.
    - `wiki-open`: 450 ms -> 475 ms (-6%), 3/3 steps, 2/2 browser round trips, verify PASS/PASS.
    - `hotel-search-filter`: 453 ms -> 470 ms (-4%), 3/3 steps, 2/2 browser round trips, verify
      PASS/PASS.
    Honest reading: on these instant-loading local fixtures the fast loop is a few percent SLOWER
    in wall-clock (no network latency to amortize, pages settle instantly, and the extra per-step
    guard/occlusion/adaptive-wait evaluate adds a small fixed cost); it did NOT regress correctness
    (verify PASS both sides) and did NOT add steps or browser round trips. The per-step
    target-resolution saving is VERIFIED separately by `test/fast-loop.test.ts` (flag-on reaches
    the same verified outcome with STRICTLY FEWER target-resolution round trips than flag-off).
  - **Phase 7 head-to-head refresh (ran this session).** Ran `BENCH_RUNS=5 pnpm run bench:compare`
    (OPEN_INTERNET; installed benchmark deps, launched real `@playwright/mcp`). All tasks pass on
    both sides (laya 19/19, playwright 16/16); the three new tasks pass in Assist AND Autopilot,
    with the multi-field autopilot goals completing in 2 to 3 Autopilot round trips versus 6 to 8
    Assist calls. `pnpm run bench` (offline vitest report) stays green (domwalk + aria, 2 passed,
    1 skipped). Full suite: 41 files, 291 passed, 3 skipped.
  - **jev-ultrafast is NOT runnable here (VERIFIED blocker).** `../jev-ultrafast/README.md` +
    `pyproject.toml` require `TYPESAFE_API_KEY` plus a text-model key (`TEXT_MODEL_API_KEY`, an
    OpenRouter/OpenAI-compatible key), the `browser-harness==0.1.13` package connected to a real
    Chrome with remote debugging, and paid API calls for any live run. `env | grep` for those keys
    returns none set, and no such model endpoint is reachable, so any jev number would be
    fabricated. NO jev number is published; the README gives only a qualitative comparison reasoned
    from laya's measured per-step costs. (jev's own README reports its OWN before/after on one
    Google Flights task as 9.450 s -> 7.092 s median and 1,092 -> 101 median browser protocol
    calls; that is jev's figure, cited as theirs, not reproduced by us.)
  - **Phase 0 spike (per-operation target heads).** VERIFIED from `src/laya/engine.ts`: `decide`
    asks operation + target as two `choice` questions in ONE `systemOne` pass over ONE shared
    control list, so it cannot express jev's separate per-operation target-head fan-out as coded;
    this is independent of the fast-loop levers (see the Phase 7 addendum).
  - **FEAT-002 EP auto-selection ordering + fall-through (VERIFIED BY UNIT TEST, fake factory,
    no GPU).** `test/execution-provider.test.ts` (10 tests) asserts `candidateExecutionProviders`
    returns CPU-last on every platform, the expected GPU-first order per platform/arch (CUDA on
    Linux x64, DirectML on win32 x64/arm64), does not offer a GPU the platform cannot host,
    returns exactly the override candidate when `LAYA_EXECUTION_PROVIDERS` is set, and that
    `resolveEngine` keeps the first candidate whose fake load resolves, LOADS THE MODEL EXACTLY
    ONCE on the happy path (spy call count 1), FALLS THROUGH to the next candidate when the first
    fake load rejects (chosen name reflects the fallback), REJECTS only when all fake loads
    reject, and emits the single startup line naming the engaged provider. The probe reuses the
    real load, so a broken listed EP falls through instead of crashing; resolution always ends at
    CPU. Verified with a fake session factory: no GPU is used or required for these tests.
  - **FEAT-004 CPU decision-ms + session-once + hot-path token budget (VERIFIED ON CPU, this
    session, Node 22.23.2, 8 CPUs).** Reproduce: `scripts/prepare-model.sh web-agent` (or the
    `int8` mode, which builds the same fp32 bundle first), then a timing probe of
    `LayaEngine.decide` (3 warmup + 15 timed) over a realistic clamped search-page `PageState`.
    Result: median **407 ms** (min 396, max 419), deterministic output across runs, extending the
    existing ~440-490 ms web-agent / ~810-870 ms reference figures. Session-once is VERIFIED from
    `node_modules/@receptron/laya/dist/laya.js` (`ort.InferenceSession.create` called once,
    stored on `this.session`, reused by every `systemOne`) and `src/laya/engine.ts` (one `Laya`
    instance per `LayaEngine`, never reloaded). The `stateTextLimit` budget is VERIFIED applied on
    the decide hot path (config -> server -> run_goal -> `buildState` at the loop's decide call ->
    `renderState` -> `laya.systemOne`), asserted by `test/tier1-token-latency.test.ts` and
    `test/config.test.ts`. The gated real-weights `test/autopilot.test.ts` passes on the fp32
    bundle (real independent final-page verification, not just a DONE decision).
  - **FEAT-003 dead-end fix (VERIFIED, unit + loop with real chromium).** A LOW-CONFIDENCE
    `BLOCKED` with no MCP sampler now resolves to a NON-BLOCKED best-safe-progress step (policy
    next action, else a bounded `SCROLL_DOWN`) instead of trapping the run; a CONFIDENT `BLOCKED`,
    the loop detector, and the destructive-form guard still hard-stop; a genuinely dead page still
    degrades to `BLOCKED` without looping forever; best-safe-progress never emits a destructive
    `CLICK` (it reuses `checkDestructiveSubmit`). Asserted by `test/dead-end.test.ts` (11 tests:
    resolver units + `escalate()` units + loop tests on `search-form.html`/`dead-button.html`);
    the existing T4 escalation and T1-T5 autonomy tests stay green with no assertion changes.
  - **FEAT-005 single-loop collapse + flag prune (VERIFIED, ran it).** `git grep
    'LAYA_FAST_LOOP|fastLoop' -- src/*` returns nothing live: the fast loop is the single
    always-on browser path and the legacy branch is gone. Env-knob count 44 -> 41 (DELETE
    `LAYA_FAST_LOOP`, INLINE `LAYA_FAST_WAIT_CAP_MS` to the 200 ms `FAST_WAIT_CAP_MS` constant,
    DELETE dead `LAYA_CONFIRM_DESTRUCTIVE`; 37 knobs kept, each threaded + tested). The decision
    pipeline is one helper `resolveStepDecision`; rules-first and `RULE_CONFIDENCE 0.97` unchanged;
    `src/types.ts` pure; config parsed once. Net 638 lines deleted (16 files, 310+/948-);
    `benchmark/before-after.mjs` + the `bench:fastloop` script retired. Suite green: typecheck
    clean, build exit 0, `pnpm test` = 318 passed / 3 skipped. See the Phase 8 addendum ledger.
- **INFERRED (from docs/patterns, not run here):**
  - **FEAT-002 GPU speedup (INFERRED / UNVERIFIED-HERE, to-be-measured on the user's RTX 4050).**
    This project's CI has NO NVIDIA GPU, so the CUDA / DirectML / WebGPU execution providers
    cannot be exercised here and no GPU decision-ms number is published. The resolver, probe,
    fall-through, and CPU path are all VERIFIED by unit test with a fake factory (see the VERIFIED
    block), and the actual GPU speedup is expected but must be measured on supported hardware.
    Reproduce on an RTX 4050: `scripts/prepare-model.sh web-agent`, then
    `LAYA_MODEL_DIR=.cache/laya-work/webagent-onnx pnpm start`, and confirm the engaged EP from
    the single stderr line `[laya-browser-mcp] Autopilot engine loaded (execution provider: cuda).`;
    compare the per-step `inferenceMs` against the ~407 ms CPU web-agent baseline. We do not
    extrapolate a GPU number we did not measure.
  - **FEAT-004 int8 speedup (NOT MEASURED, int8 documented-and-skipped).** int8 dynamic
    quantization of the ModernBERT-shaped web-agent graph is infeasible with onnxruntime 1.30.0 /
    onnx 1.23.0 here (`quantize_dynamic` aborts with `[ShapeInferenceError] Inferred shape and
    existing shape differ in dimension 0: (772) vs (256)`); the `scripts/prepare-model.sh int8`
    scaffolding is kept for when a compatible export or tolerant onnxruntime version exists. No
    int8 number was fabricated (see the Phase 8 addendum FEAT-004 note).
  - Real per-step accuracy (~97.7% clean forms, ~1 step in 5 on real Mind2Web), from the
    checkpoint's reported figures; not reproduced offline. FEAT-003's direct `decide` probes are
    consistent with the "not reliable step-by-step on its own" side of this (see the VERIFIED
    FEAT-003 block), but were not a full accuracy benchmark.
  - The ~2 GB RAM footprint. (Bundle SIZE is now VERIFIED: reference ~1.69 GB of external weights;
    web-agent `laya.onnx` 1291 MB inline (see the FEAT-003 VERIFIED block).)
- **GUESSED (reasonable defaults, tunable):**
  - Default `maxSteps` `15`, the destructive-keyword set, and the goal-grammar surface. All are
    configurable / centralized so they can change without touching the decision core.
  - The confidence threshold is **no longer GUESSED**: `0.85` is now the **decided, VERIFIED
    default** (raised from the original GUESSED `0.6`). It is enforced with OR semantics and
    asserted in `test/config.test.ts`; see the T1-T5 VERIFIED block below. It stays tunable via
    `LAYA_CONFIDENCE_THRESHOLD`.

- **VERIFIED (ran it), T1-T5 local-first autonomy:**
  - **T2 gate = 0.85.** `loadConfig().confidenceThreshold` defaults to `0.85`;
    `LAYA_CONFIDENCE_THRESHOLD` still overrides; the loop keeps the OR semantics (escalate when
    `operationConfidence < 0.85 OR targetConfidence < 0.85`). Asserted in `test/config.test.ts`.
  - **T4 escalation never kills autonomy.** `escalate()` now threads the pre-escalation Laya
    decision as `EscalationOptions.fallback`; when the LLM is UNREACHABLE (no sampler, or the
    sampler throws) and the fallback is non-BLOCKED, it returns that fallback with
    `escalated:false` and a warning note so the run continues. A run stops for BLOCKED only when
    Laya itself chose BLOCKED (or the loop detector / destructive guard fires). The R2
    no-weights BLOCKED placeholder still degrades gracefully. Asserted in `test/escalation.test.ts`
    (unit) and `test/autopilot-autonomy-t1-t5.test.ts` (loop, real chromium).
  - **T1 regression + T3 per-step scope.** A rule-decided step carries confidence `0.97`
    (`RULE_CONFIDENCE`) and consults no sampler; escalation is scoped to exactly one step (the
    step after an escalation returns to rules/Laya, source not `llm`) and one escalation never
    ends the run. Asserted in `test/autopilot-autonomy-t1-t5.test.ts`.
  - **T5 auditability.** Each `StepRecord` carries a finite `inferenceMs` (decision wall-time),
    and `RunResult.autonomy` carries `{ total, rule, laya, stub, llm, fullyAutonomous,
    autonomousPct }` (fullyAutonomous = rule+laya+stub). `renderRunResult` surfaces a compact
    `Autonomy: X/Y steps local (Z%); inference: median NN ms` line plus per-step `inf=NNms`.
    Full offline suite green with the stub, no weights: 272 passed, 3 skipped; `pnpm run bench`
    green (domwalk + aria, 4/4 fixtures, 100% ops coverage).

- **VERIFIED (ran it), FEAT-003 real weights on device (this session, CPU, Node 22, no fakes):**
  Both real bundles were downloaded/exported, loaded through `@receptron/laya`'s
  `Laya.load({ modelDir })` in Node, and run REAL inference. Reproduce with
  `scripts/prepare-model.sh reference|web-agent`, then `LAYA_MODEL_DIR=<dir> pnpm test` +
  `LAYA_MODEL_DIR=<dir> pnpm run bench`.
  - **Path A, reference `convaiinnovations/laya`.** `@receptron/laya` downloaded the ready-made
    ONNX bundle (repo `receptron/laya-onnx`): `laya.onnx` 3.8 MB graph + `laya.onnx.data`
    1.69 GB external weights + `laya_config.json` (`max_len 512`, `head_max_len 192`) + tokenizer.
    Loaded directly (no rename). `Laya.load` ~12.8 s cold (download) / ~1.5 s warm; one
    `systemOne` narrow-choice call ~280 ms; the product's `LayaEngine.decide` (TWO narrow choice
    questions per step) ~810-870 ms median.
  - **Path B, web-agent `abedinia/laya-web-agent`.** `snapshot_download` the checkpoint
    (`model.safetensors` 1.29 GB) + pulled `rl_common.py`/`rl_agent_api.py`/`email_utils.py` from
    `convaiinnovations/laya`; ran the reference `export_onnx.py` UNMODIFIED (parity
    `max |dlogits| = 4.20e-05`, `max |dact| = 0.0`; `laya.onnx` 1291 MB, weights inline). Applied
    the one-line tokenizer rename (`<bos>=2/<eos>=1/<mask>=4/<pad>=0` -> `[CLS]/[SEP]/[MASK]/[PAD]`,
    SAME IDs). `Laya.load({ modelDir })` then loaded and ran. `LayaEngine.decide` ~440-490 ms
    median (roughly 2x faster than the reference per decision).
  - **Gated tests pass for BOTH bundles.** `LAYA_MODEL_DIR=<dir> pnpm test` runs
    `test/autopilot.test.ts` (line ~338) + `test/benchmark/report.test.ts` (line ~43): the real
    autopilot test drives the search form to a real INDEPENDENT final-page verification (success,
    not just a DONE decision), and the real-engine benchmark reports 4/4 end-to-end success,
    100% ops coverage.
  - **HONEST finding: the deterministic rule layer does the structured work; the model is not
    consulted on these fixtures.** On all four benchmark fixtures the per-step source breakdown is
    `rule/laya/stub/llm = 3/0/0/0` for BOTH real models: the rule seed's confidence `0.97` clears
    the `0.85` gate, so Laya never decides a step. Fully-autonomous = 100% (all local, zero LLM
    round-trips), but that autonomy comes from the rules, not the weights. Direct
    `LayaEngine.decide` probes on ambiguous single steps confirm neither checkpoint reliably picks
    the correct web operation from our `renderState` input: reference gives TYPE_TEXT on an
    empty-search state (correct, but conf 0.36, below the gate -> would escalate) yet TYPE_TEXT on
    an already-filled form (should CLICK) and on a results page (should DONE); the web-agent skews
    to DONE (correct on the results page conf 0.94, but DONE on the empty and filled forms too).
    So the honest positioning stands: the rules do the reliable structured work, the local model
    is a low-confidence signal behind the `0.85` gate that escalates to the client LLM when unsure,
    and the independent final-page check (never a DONE decision) is the trust signal.
  - **Model choice: the reference `convaiinnovations/laya` is the DEFAULT (zero-friction: a
    prebuilt ONNX bundle, no Python/export, no tokenizer rename).** The web-agent is the
    purpose-built web checkpoint and is ~2x faster per decide, but on the current structured
    fixtures neither model changes the measured end-to-end outcome (the rules win), so there is no
    evidence to prefer the heavier export path for structured tasks. Recommendation: ship the
    reference bundle as the drop-in default; keep the documented web-agent export
    (`scripts/prepare-model.sh web-agent`) for ambiguous/real-site steps where the model, not the
    rules, has to decide. Both paths are one command via `scripts/prepare-model.sh`.
  - **Offline suite still green with the stub, no weights (WITHOUT `LAYA_MODEL_DIR`):** typecheck +
    build pass; `pnpm test` = 272 passed / 3 skipped (WebKit self-skip + the two `LAYA_MODEL_DIR`
    gated blocks). Scratch dir, venv, and all weights were deleted after capturing the numbers;
    `git status --porcelain --ignored` is clean of `*.onnx`/`*.onnx.data`/`model/`/`.venv`.

- **VERIFIED (ran it), FEAT-004 broadened benchmark (this session, stub engine, headless
  Chromium + real `@playwright/mcp`, no weights):** the `benchmark/` compare suite was widened
  from 16 to **23 tasks** covering real-world-shaped flows: a multi-field signup form with
  client-side validation (`signup-validated-form`), search-then-select from a filtered list
  (`search-then-select`), a two-page wizard navigation (`wizard-two-step`), table row selection
  (`table-row-select`), cookie/consent-banner dismissal (`consent-dismiss`), blocking-modal
  dismissal (`modal-dismiss`), and a login-then-follow-up flow (`login-then-action`). Each task
  adds a tiny deterministic local fixture under `benchmark/fixtures/` (served on loopback by
  `benchmark/server.mjs`), an `assist(h)` script using the SAME arg shapes for both servers, and
  a `verify(h)` that RE-PROBES the real DOM for a literal outcome. `consent-dismiss` and
  `modal-dismiss` also exercise the `LAYA_AUTO_DISMISS` path through an `autopilot(h)` variant
  (the laya spec runs with `LAYA_AUTO_DISMISS=true`; it affects only the `laya_run_goal` loop,
  so the Assist comparison stays fair).
  - **Measured (one recorded run; `pnpm run bench:compare` regenerates `RESULTS.md` +
    `results.json` + `charts/`):** Assist mode is **23/23 (100%)** for laya (median 312 ms) and
    **20/20 (100%)** for Playwright MCP (median 965 ms); the 3-task gap is the storage/verify
    tools Playwright MCP core does not expose (N/A, not a loss). The independent final-page
    verify is the trust signal for every row.
  - **HONEST: Autopilot round-trips are COVERAGE, not precision.** With the reference stub the
    single-call `laya_run_goal` PASSes `search-type-submit` (2 calls vs 4 Assist) but FAILs
    `login-fill-form`, `search-then-select`, `consent-dismiss`, and `modal-dismiss`: the stub
    batch-fills goal-stated fields and submits, but it does not choose an unstated dropdown
    option, disambiguate one result from a list, or pick a web-tuned target under a dismissed
    overlay. These FAILs are reference-layer limitations, shown honestly, not defects of the
    loop; a real model bundle is what closes the Autopilot gap.
  - **Offline `pnpm run bench` stays green.** The separate offline vitest report harness
    (`test/benchmark/`) uses its own `BENCH_CASES` over `test/fixtures/` and is unaffected by the
    `benchmark/` compare tasks; it remains 4/4 end-to-end success, 100% ops COVERAGE (domwalk +
    aria). Full offline suite still green: `pnpm run typecheck` + `pnpm run build` pass,
    `pnpm test` = 272 passed / 3 skipped.
- **INFERRED (not run in FEAT-004): a public live-web dataset would measure generalization, not
  this suite.** The `benchmark/` suite is deliberately local fixtures for determinism and
  fairness, so it is a coverage/latency comparison, NOT a live-web robustness claim. A public
  dataset such as Mind2Web ([Deng et al., NeurIPS 2023](https://arxiv.org/abs/2306.06070), CC BY
  4.0) is the right instrument for the "~1 step in 5 on real pages" side of the honest
  positioning; it was NOT fetched or committed in this session, and its test set must not be
  redistributed. The live-web accuracy figures quoted in this repo remain **INFERRED** from the
  checkpoint's reported numbers (see the INFERRED bullet above), not reproduced here.

## Core data shapes (designed first in `src/types.ts`)

The type module is **pure**: it imports neither `playwright` nor any ONNX / `@receptron/laya`
runtime, so it type-checks and unit-tests in isolation and keeps the ref/snapshot boundary
decoupled from the decision layer.

- **`Ref`**: a branded `string` (`e5`), so a raw string cannot be passed where a resolved ref
  is expected. Refs are assigned by our own in-page DOM walk, not by any Playwright private API.
- **`Control`**: one interactive/landmark element: `{ ref, index (1-based), role, name, tag,
  type?, value?, options?, editable, checked?, disabled? }`. `index` is the position in the
  numbered control list the model sees; `ref` resolves the element back on the page.
- **`PageState`**: the compact snapshot handed to Laya: `{ goal, url, title, visibleText,
  controls, recentActions }`. Mirrors the web-agent `jev_ultrafast` input format (goal + title +
  visible text + numbered controls with current values + recent actions), kept within `max_len`.
- **`Operation`**: the base set `'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SCROLL_DOWN' | 'WAIT' |
  'DONE' | 'BLOCKED'` mirrors `abedinia/laya-web-agent` exactly. Part 2 broadens it with
  `'HOVER' | 'NAVIGATE_BACK' | 'PRESS_KEY' | 'FILL_FORM' | 'SCREENSHOT' | 'VERIFY'` so Autopilot
  can drive the richer toolset faster (see the Phase 6 addendum).
- **`Decision`**: modelled as a **discriminated union so illegal states are unrepresentable**:
  a `CLICK`/`TYPE_TEXT`/`SELECT`/`HOVER` decision must carry a `target: Ref`; `DONE`/`BLOCKED`/
  `SCROLL_DOWN`/`WAIT`/`NAVIGATE_BACK`/`SCREENSHOT` carry no target; `PRESS_KEY` carries a
  `key`; `FILL_FORM` carries a `fields[]` list and no single `target`; `VERIFY` carries a
  marker. Carries `operationConfidence`, `targetConfidence` (both in `[0,1]`, used to decide
  escalation), an optional `value` (text to type / option to choose), and a `source` of
  `'laya' | 'rule' | 'llm' | 'stub'` for observability.
- **`LayaDecisionEngine`**: `{ decide(state): Promise<Decision>; readonly available: boolean;
  close(): Promise<void> }`. The real engine and the stub are interchangeable behind this
  interface (Boundary Discipline). `available: false` is how Autopilot knows to degrade
  gracefully (deterministic rules + LLM escalation) instead of failing.

## Spike: exporting `abedinia/laya-web-agent` to a Laya-loadable ONNX bundle

**Result: VERIFIED (end to end), with one small, documented tokenizer fix.**

Goal: determine whether the browser-agent checkpoint `abedinia/laya-web-agent` (advertised as
mmBERT-base, `max_len` 2048 / `head_max_len` 512, `jev_ultrafast` I/O) can be exported to an
ONNX bundle usable by `@receptron/laya`'s `modelDir` option, so Autopilot can run the actual
web-agent weights with **no Python at runtime**. `@receptron/laya`'s `export/export_onnx.py`
was written for the reference ModernBERT checkpoint `convaiinnovations/laya`, so applicability
to the web-agent was unverified going in.

What was done (Python 3.12 via `uv`; `torch` 2.14, `transformers` 5.17, `onnx`, `onnxscript`,
`onnxruntime`, `safetensors`, `huggingface_hub`):

1. `snapshot_download("abedinia/laya-web-agent")`. Its `encoder/config.json` reports
   `model_type: "modernbert"` / `architectures: ["ModernBertForMaskedLM"]` (the web-agent was
   trained *from* mmBERT-base per `rl_agent_config.json`, but the shipped encoder is
   ModernBERT-shaped, hidden 768, 22 layers, vocab 256000). The file layout matches the
   reference checkpoint exactly (`encoder/`, `model.safetensors`, `rl_agent_config.json`,
   `tokenizer/`). The web-agent repo does **not** ship `rl_common.py` / `rl_agent_api.py` /
   `email_utils.py`, so those model-building modules were pulled from `convaiinnovations/laya`.
2. Ran the reference `export_onnx.py` unmodified against the web-agent files.
   **It exported successfully.** Parity vs. the PyTorch reference: `max |dlogits| = 2.48e-05`,
   `max |dact| = 0.0`. Output bundle: `laya.onnx` (1291 MB, weights inline:
   `external_data=False`, so no separate `laya.onnx.data` is needed for the `modelDir` path),
   `laya_config.json` (`max_len` 2048, `head_max_len` 512), and `tokenizer/`.
3. Loaded the bundle in **Node** via `Laya.load({ modelDir })`. This initially **failed** with
   `special token [CLS] missing from tokenizer`: `@receptron/laya@0.1.2` hardcodes the ModernBERT
   special-token names `[CLS] [SEP] [MASK] [PAD]`, but the web-agent tokenizer names them
   `<bos>(=2) <eos>(=1) <mask>(=4) <pad>(=0)`.
4. Renamed those four special-token contents in `tokenizer/tokenizer.json` to the `[CLS]`-style
   names (**same token IDs**). `Laya.load({ modelDir })` then **loaded and ran**: a narrow
   `choice` question over the exact web-agent operation set returned a calibrated distribution
   (e.g. `{ CLICK: 0.53, SELECT: 0.33, DONE: 0.07, ... }`, `input_tokens: 105`) and
   `laya.close()` cleaned up.

**Conclusion (VERIFIED):** the web-agent checkpoint can be exported and run on-device through
`@receptron/laya` with **no Python at runtime**, provided the export pipeline also **remaps the
tokenizer special-token names** (`<bos>/<eos>/<mask>/<pad>` -> `[CLS]/[SEP]/[MASK]/[PAD]`, IDs
unchanged) before writing the bundle. This will be captured as a small export/prepare step in a
later phase (it is a one-line rename, not a code change to `@receptron/laya`). The ONNX graph
itself needs no modification.

**Documented fallback (not needed, kept for completeness):** if a future checkpoint's graph does
not export cleanly, a thin local Python sidecar using the `laya` pip package can serve decisions
over a local socket. This loses the no-Python-at-runtime property and is a last resort.

**Independent of weights either way:** the product and its whole test suite run without any
weights: Assist mode is fully standalone, Autopilot degrades gracefully (deterministic rules +
LLM escalation), and tests use a stubbed `LayaDecisionEngine`. The reference receptron checkpoint
also loads directly via `modelDir` / the default download for anyone who wants real decisions
without the export step.

## Known risks

- **Real-site reliability.** The web-agent is strong on structured synthetic forms (~97.7%
  per-step) but only ~1 step in 5 fully correct on real Mind2Web sites. Autopilot must lean on
  deterministic rules + LLM escalation and must verify the final page rather than trusting a
  DONE decision. Positioning stays honest.
- **ONNX export / tokenizer coupling.** Export works today, but `@receptron/laya@0.1.2` couples
  to ModernBERT special-token names; the required tokenizer rename must be part of our
  export/prepare step, and a future SDK or checkpoint change could reopen this. The fallback
  sidecar is documented above.
- **Weights size.** The bundle is ~1.3–1.7 GB and needs ~2 GB RAM loaded. It is never committed
  (`.gitignore` excludes `*.onnx` / `*.onnx.data` / `model/`); it is downloaded/exported at
  runtime and cached under `~/.cache/receptron-laya` (`LAYA_CACHE`) or pointed at via
  `modelDir` / `LAYA_MODEL_DIR`. `scripts/prepare-model.sh reference|web-agent` builds a bundle
  reproducibly in a scratch dir; it never commits weights.
- **`head_max_len` limits.** Options for a `choice` must fit `head_max_len` tokens (throws
  otherwise) and ~<20 options per choice is recommended; the state builder must keep the numbered
  control list compact.
- **No Playwright private snapshot API.** Stable `playwright-core@1.63.0` has no public
  `_snapshotForAI`/`snapshotForAI`; we own the ref boundary via our own DOM walk, so an upstream
  Playwright change cannot silently break refs.
- **Client sampling support is optional.** Autopilot's low-confidence escalation needs the
  client to advertise the `sampling` capability. When absent, escalation degrades to a clear
  `BLOCKED` rather than failing, but the loop is then only as good as the deterministic rules +
  local model on that step.
- **Goal-grammar coverage.** The deterministic goal parser handles the explicit structured
  grammar (assignments + `expect`/`see`/`until` markers). Unquoted values stop at punctuation,
  so values containing dots (e.g. emails) should be quoted; the benchmark and docs reflect this.
- **Safety heuristics are keyword-based and Autopilot-only.** The destructive-form guard
  matches a keyword set against a scoped set of signals (the target control's own name /
  value / option labels and the names of the other actionable controls, buttons/links), plus
  the password+payment combination. It deliberately does NOT scan the whole page's visible
  body text (that would over-trigger on any prose mentioning "delete"), so it can still miss
  unusual phrasings or off-screen/image-only signals; it errs toward refusing (fail-safe). It
  covers the Autopilot auto-submit (`CLICK`) path only: the human-driven Assist tools apply
  no destructive check by design. It is a guard rail requiring explicit confirmation, not a
  proof, and is configurable (`LAYA_DESTRUCTIVE_GUARD`).
- **Benchmark metric is coverage, not precision.** The `pnpm run bench` `ops-cov` column is
  expected-ops COVERAGE (a subsequence match): it does not penalize extra or wrong operations,
  so a 100% row only means every expected op appeared in order. The end-to-end success column
  (the independent final-page check) is the trustworthy signal; the harness output, README,
  and this plan all label the metric as coverage rather than accuracy/precision.

## Licensing / attribution

Project code MIT. Laya weights Apache-2.0 (Convai Innovations). Any Mind2Web-derived material is
CC BY 4.0; attribute Deng et al., NeurIPS 2023; do not redistribute the test set.

## Phase 9 addendum: jev_ultrafast input format, model-driven autonomy, reliability fixes

**Root cause of "the rules do everything, the model never helps" (measured).** The Phase 0 spike
note above is superseded: `@receptron/laya` CAN express per-operation target heads (each head is
just another `choice` question). The web-agent model card states its input is jev_ultrafast's;
the engine was sending a custom text rendering, a one-line instruction, and one shared target
list whose option text repeated role/name. Model-only closed-loop runs on six local fixtures:
old input 0/6 verified (SELECT on buttons, endless SCROLL_DOWN), jev input 3/6.
`src/laya/jev-format.ts` now builds the request exactly like jev's `choose()` and serializes it
like the Python reference (`json.dumps` instructions, `repr`-rendered dict criteria), which
`@receptron/laya` does not do for object values.

**Latency (measured, 8-core CPU, web-agent ModernBERT-large 421M).** ~2.3 ms/token per forward
row, independent of `intraOpNumThreads` (4/8/default all within 5%). Each question is a row
over the full state, so the engine asks the operation, then only the chosen head: median
decide 6.6 s -> 4.2 s, identical decisions. The speculative settle-window decide discarded
low-confidence answers and then recomputed them: 14 engine calls for 8 model steps; caching
the answer regardless of confidence (the real step still runs the confidence gate and
escalation) gives 8 calls, engine time 38.9 s -> 22.3 s. CPU is compute-bound here; GPU EPs
are the remaining lever (not measurable in this sandbox).

**Autopilot end to end (rules + model, no client LLM):** 2/6 -> 6/6 verified with the web-agent,
6/6 with the reference bundle. Fixed along the way, each reproduced first:
- Rule 3 re-clicked the same submit every step (fields stay filled after a submit) -> skip once
  that submit was clicked after the last fill.
- Rule 0 declared DONE on the implicit search-echo marker (`search for "X", then open X` ended
  on the results page) -> Rule 0 uses explicit markers only.
- Goal-stated `<select>` values were never set before submit (login submitted without role) ->
  batched into FILL_FORM / Rule 1c; goal-named checkboxes checked before submit (Rule 1d).
- A model/LLM DONE the page refutes (explicit marker absent) ended the run -> treated as BLOCKED.
- A low-confidence DONE/BLOCKED with no LLM ended the run -> ask the model for its best actionable op.
- An action error (timeout, wrong element kind) aborted the whole run -> recorded, re-observed.
- An engine exception aborted the run -> zero-confidence BLOCKED into the escalation path.
- An unparseable/unresolvable LLM answer hard-BLOCKED -> treated as unreachable (local fallback);
  refs like `[ref=e5]` normalized; sampling `maxTokens` 256 -> 1024 (FILL_FORM JSON truncated).
- A two-step cycle (TYPE, CLICK, TYPE, CLICK...) never tripped the all-identical loop detector.
- Fast-path fill/select wrote `.value` on the instance, which React's value tracker swallows:
  a React form never updated (reproduced with React 18). Now the prototype setter; clicks are a
  real `page.mouse.click` at the hit-tested point; contenteditable gets real text input.
- A click that opened a new tab (`target=_blank`) left Autopilot observing the opener.
- `prepare-model.sh` broke with a relative OUT_DIR and on re-run (existing venv).

## Phase 10 addendum: shortlist, input fidelity, calibrated gate, browser robustness

Measured with the new step-scored harness (`benchmark/eval`, 19 cases, 63 scored steps,
web-agent checkpoint), one change at a time, keeping only improvements:
- Relevance shortlist (`src/shortlist.ts`): 65.1% -> 69.8% step accuracy; correct target never
  offered 3 -> 0. Tightening to goal matches + 5 others fixed the 55-link store case.
- Password/file/hidden inputs left out of the model input only: -> 71.4% (fixed typing the
  password first). They stay in the page state for rules and the LLM.
- On-screen text only (jev), space-joined: -> 73.0%. The same text newline-joined lost
  (66.7-68.3%) and was reverted; so was newline-preserving whole-page text.
- aria checked/selected/expanded in the model input: neutral on this set; kept for fidelity.
- Per-operation gate (config `DEFAULT_OPERATION_THRESHOLDS`): local 12/63 (100%) -> 27/63
  (96.3%). Fitted on this same small set; re-derive on real tasks.

Browser fixes, each reproduced first: off-screen targets were refused as "covered" (now
scrolled into view); marker checks read text clamped to 1200/2000 chars so a confirmation at
the bottom of a long page was never seen (verification false on a successful run); an element
that dropped out of a capture kept its old `data-laya-ref`, duplicating the next one (2 -> 1);
every FILL_FORM field after the first fell off the fast path because the batch's own writes
changed the page key (2 -> 0 locator fallbacks). Typed text with no goal-grammar value now
comes from the client LLM (jev's text helper).
