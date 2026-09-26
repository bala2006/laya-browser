# laya-browser-mcp — Plan

`laya-browser-mcp` is a TypeScript / Node 22 MCP server that is a **superset of Playwright
MCP** plus a **local, sub-100ms Laya on-device decision engine**. It exposes the familiar
ref-based Playwright toolset (Assist mode) and adds an Autopilot loop (`laya_run_goal`) that
drives structured web tasks with a local Laya "System 1" decision model, deterministic rules,
and MCP-sampling escalation to the client LLM when confidence is low.

Honest positioning: this is a **fast local decision layer with LLM fallback**. It is strong
on structured forms and weak on arbitrary real sites (the web-agent checkpoint scores ~97.7%
per-step on clean synthetic forms but only ~1 step in 5 fully right on real Mind2Web sites).
It is **not** a fully autonomous general web agent.

## Phased plan

- **Phase 0 — Scaffold + core types + spike (FEAT-001, this phase).**
  pnpm + `tsc` (ESM NodeNext, strict) + vitest toolchain; verified deps installed;
  green baseline (typecheck + build + one meaningful test); the **pure** core type module
  `src/types.ts` that every later phase depends on; the time-boxed ONNX-export spike; this plan.

- **Phase 1 — Snapshot + ref boundary + browser lifecycle.**
  `src/snapshot.ts`: an in-page DOM walk that stamps stable `data-laya-ref="eN"` attributes on
  interactive/landmark elements and returns (a) a compact human-readable snapshot with
  `[ref=eN]` markers and (b) a `ref -> metadata` map. `src/browser.ts`: Playwright lifecycle
  and the ref-resolution boundary (`page.locator('[data-laya-ref="eN"]')`, falling back to
  treating `target` as a raw selector). **We own the ref boundary ourselves** — stable
  `playwright-core@1.63.0` does NOT expose a public `_snapshotForAI`/`snapshotForAI` (only
  alpha/mcp-bundled builds do), so no Playwright private API is assumed anywhere.

- **Phase 2 — Assist-mode MCP tools.**
  `src/tools/*.ts`: navigate, snapshot, click, type, select, press_key, wait_for, close, using
  the Playwright MCP convention (`element` human-readable description + `target` exact ref or
  selector), zod input schemas. `src/server.ts` / `src/index.ts`: the stdio MCP server. Works
  standalone with **no weights**.

- **Phase 3 — State builder + Laya engine + stub.**
  `src/state-builder.ts`: snapshot -> compact typed `PageState` for Laya (numbered controls with
  current values, condensed visible text, recent actions), budgeted to the checkpoint's
  `max_len`. `src/laya/engine.ts`: `LayaDecisionEngine` wrapping `@receptron/laya`
  (`Laya.load` + `systemOne` narrow choice questions -> `Decision`). `src/laya/stub.ts`: a
  deterministic fake engine implementing the same interface for offline tests.

- **Phase 4 — Autopilot loop.**
  `src/autopilot/loop.ts`: snapshot -> state -> decision -> execute -> repeat, until DONE/BLOCKED.
  Narrow Laya decisions + deterministic rules (fill goal-stated values; after typing/opening a
  control choose from the options that appeared; submit then open the named item) + **one** text
  plan per task. Low confidence or BLOCKED escalates to the client LLM via **MCP sampling**.
  Degrades gracefully when weights are absent. A DONE decision is not proof of success — the
  loop verifies the final page independently.

- **Phase 5 — Escalation + rules + hardening + benchmark + docs (DONE).**
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

## Verified / inferred / guessed ledger

- **VERIFIED (ran it):**
  - `@receptron/laya@0.1.2` API (`Laya.load` + `systemOne` narrow `choice` questions),
    `head_max_len` 192 throw behavior, and the web-agent ONNX export + tokenizer-rename step
    (logit parity `max |dlogits| = 2.48e-05`).
  - Stable `playwright-core@1.63.0` has no public `_snapshotForAI`/`snapshotForAI`; we own the
    ref boundary via our own DOM walk.
  - `@modelcontextprotocol/sdk@1.30.1` sampling: `McpServer.server.createMessage(params)`
    (result `content` is a single block with `.type`/`.text`) and
    `McpServer.server.getClientCapabilities()?.sampling` for capability detection — confirmed
    against the installed SDK type declarations.
  - The full offline test suite + `pnpm run bench` are green with the stub (3/3 fixtures,
    100% per-step), headless Chromium, no weights.
- **INFERRED (from docs/patterns, not run here):**
  - Real per-step accuracy (~97.7% clean forms, ~1 step in 5 on real Mind2Web) — from the
    checkpoint's reported figures; not reproduced offline.
  - The bundle size (~1.7 GB) and ~2 GB RAM footprint.
- **GUESSED (reasonable defaults, tunable):**
  - The default confidence threshold `0.6`, default `maxSteps` `15`, the destructive-keyword
    set, and the goal-grammar surface. All are configurable / centralized so they can change
    without touching the decision core.

## Core data shapes (designed first — `src/types.ts`)

The type module is **pure**: it imports neither `playwright` nor any ONNX / `@receptron/laya`
runtime, so it type-checks and unit-tests in isolation and keeps the ref/snapshot boundary
decoupled from the decision layer.

- **`Ref`** — a branded `string` (`e5`), so a raw string cannot be passed where a resolved ref
  is expected. Refs are assigned by our own in-page DOM walk, not by any Playwright private API.
- **`Control`** — one interactive/landmark element: `{ ref, index (1-based), role, name, tag,
  type?, value?, options?, editable, checked?, disabled? }`. `index` is the position in the
  numbered control list the model sees; `ref` resolves the element back on the page.
- **`PageState`** — the compact snapshot handed to Laya: `{ goal, url, title, visibleText,
  controls, recentActions }`. Mirrors the web-agent `jev_ultrafast` input format (goal + title +
  visible text + numbered controls with current values + recent actions), kept within `max_len`.
- **`Operation`** — `'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SCROLL_DOWN' | 'WAIT' | 'DONE' |
  'BLOCKED'`, mirroring `abedinia/laya-web-agent` exactly.
- **`Decision`** — modelled as a **discriminated union so illegal states are unrepresentable**:
  a `CLICK`/`TYPE_TEXT`/`SELECT` decision must carry a `target: Ref`; `DONE`/`BLOCKED`/
  `SCROLL_DOWN`/`WAIT` cannot. Carries `operationConfidence`, `targetConfidence` (both in
  `[0,1]`, used to decide escalation), an optional `value` (text to type / option to choose),
  and a `source` of `'laya' | 'rule' | 'llm' | 'stub'` for observability.
- **`LayaDecisionEngine`** — `{ decide(state): Promise<Decision>; readonly available: boolean;
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
   `max |dact| = 0.0`. Output bundle: `laya.onnx` (1291 MB, weights inline —
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
weights — Assist mode is fully standalone, Autopilot degrades gracefully (deterministic rules +
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
  `modelDir` / `LAYA_MODEL_DIR`.
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
- **Safety heuristics are keyword-based.** The destructive-form guard matches a keyword set and
  the password+payment combination. It can miss unusual phrasings or over-trigger on benign
  text; it is a guard rail requiring explicit confirmation, not a proof, and is configurable.

## Licensing / attribution

Project code MIT. Laya weights Apache-2.0 (Convai Innovations). Any Mind2Web-derived material is
CC BY 4.0 — attribute Deng et al., NeurIPS 2023; do not redistribute the test set.
