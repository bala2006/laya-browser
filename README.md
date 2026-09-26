# laya-browser-mcp

**A superset of [Playwright MCP](https://github.com/microsoft/playwright-mcp) with a local,
sub-100ms Laya on-device decision engine.** It exposes the familiar ref-based Playwright
browser tools (Assist mode) and adds an Autopilot loop (`laya_run_goal`) that resolves each
step's element/action choice **on-device** with a local Laya "System 1" model, so the client
LLM is invoked far less often. When the local model is not confident, Autopilot escalates the
single step to the client's own LLM via **MCP sampling**.

## Honest positioning and limits

This is a **fast local decision layer with an LLM fallback**, not a magic autonomous agent.
Please read this before deciding whether it fits your use case:

- **Strong on clean, structured forms.** The web-agent checkpoint scores roughly **97.7%
  per-step** on clean synthetic forms (search boxes, filters, logins, checkouts).
- **Weak on arbitrary real sites.** On real-world Mind2Web pages it is only right about
  **1 step in 5** end to end. Autopilot leans on deterministic rules and LLM escalation to
  cover the gap, and it still may fail on messy sites.
- **NOT a fully autonomous general web agent.** Do not deploy it unattended against sites
  where a wrong click matters.
- **`DONE` is not proof of success.** A `DONE` decision from the model is never trusted on
  its own. After every run, Autopilot performs an **independent final-page verification**
  (checking the goal's declared success marker directly on the page) and reports
  `verified` separately from the operation the model chose.
- **Works with no weights.** Assist mode is fully standalone (no model needed). Autopilot
  degrades gracefully to an Assist-mode hint when weights are absent.

## How it works

### Assist mode (standalone, no weights)

A ref-based superset of Playwright MCP. You call `browser_snapshot` (or any navigating /
mutating tool, which returns a fresh snapshot) to get stable `[ref=eN]` element references,
then drive the page by passing a ref (or a raw Playwright selector) as the `target` of
`browser_click` / `browser_type` / `browser_select_option`.

We **own the ref boundary** ourselves: an in-page DOM walk stamps stable `data-laya-ref="eN"`
attributes on interactive/landmark elements. Stable `playwright-core@1.63.0` does **not**
expose a public `_snapshotForAI`/`snapshotForAI`, so nothing here depends on a Playwright
private API.

### Autopilot mode (`laya_run_goal`)

Give it a natural-language goal and it drives the current (or a given) page:

```
snapshot -> compact typed PageState -> DECISION -> execute (Playwright) -> repeat
```

The **decision** stage follows the authoritative laya-ultrafast design lesson — *Laya answers
narrow questions reliably but not the open "what next?"* — as a three-stage pipeline:

1. **Deterministic-rule seed** (`src/autopilot/policy.ts`). High-confidence, transparent
   rules: (1) fill the values the goal states, mapping each to a field; (2) after typing into
   or opening a control, prefer choosing from the options that just appeared; (3) once every
   goal-stated field is filled, submit — then open/verify the named item.
2. **Narrow Laya decision** (`src/laya/engine.ts`). When no rule fires, the local model
   answers two narrow `choice` questions in one pass: *which operation?* and *which control?*
3. **Confidence check + escalation** (`src/autopilot/escalation.ts`). If the operation or
   target confidence is below the configured threshold, or the model returns `BLOCKED`, the
   step is escalated to the client's LLM through the MCP `sampling/createMessage` request; the
   structured answer is parsed back into a decision (`source: "llm"`). If the client does not
   support sampling, escalation degrades to a clear `BLOCKED` (it never throws).

Every step in the returned transcript records its **source** (`rule` / `laya` / `llm` /
`stub`) and confidences. After the loop, the **independent final-page verification** runs
regardless of how the loop ended.

### Safety guards (`src/safety.ts`)

- **Domain allow-list.** When `LAYA_ALLOWED_DOMAINS` is set, `browser_navigate` and every
  Autopilot navigation are restricted to those hosts and their subdomains; off-list
  navigation is rejected with a reason (fail-closed).
- **Destructive-form guard.** Before an Autopilot auto-submit, the target and its
  surroundings are inspected for destructive signals
  (`delete`/`remove`/`pay`/`purchase`/`confirm order`/`transfer`/`deactivate`, or a form
  combining a password field with a payment-like field). When one is present, the auto-submit
  is refused and the reason is surfaced, so a human can confirm explicitly. Disable with
  `LAYA_DESTRUCTIVE_GUARD=false`.

## Install

```sh
pnpm install
pnpm exec playwright install chromium
pnpm run build
```

Requires Node.js 22+.

### MCP client configuration (stdio)

```jsonc
{
  "mcpServers": {
    "laya-browser": {
      "command": "node",
      "args": ["/absolute/path/to/laya-browser-mcp/dist/index.js"],
      "env": {
        "LAYA_ENGINE": "auto",
        "LAYA_MODEL_DIR": "/absolute/path/to/laya-onnx-bundle"
      }
    }
  }
}
```

Clients that intend to use Autopilot should advertise the `sampling` capability so the
low-confidence escalation path is available. Autopilot still runs without it (it degrades to
`BLOCKED` on low confidence).

### Configuration (environment variables)

All configuration is parsed **once** (`src/config.ts`) from environment + tool args +
constructor options, then handed inward as typed config.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAYA_BROWSER_HEADLESS` | `true` | `false` runs headed. |
| `LAYA_BROWSER_CHANNEL` | — | Chromium channel (e.g. `chrome`). |
| `LAYA_BROWSER_VIEWPORT` | `1280x800` | Viewport `WIDTHxHEIGHT`. |
| `LAYA_ENGINE` | `auto` | `stub` forces the deterministic engine; `auto` uses weights when present. |
| `LAYA_MODEL_DIR` | — | Local ONNX bundle directory (skips download). |
| `LAYA_REPO` / `LAYA_SUBFOLDER` / `LAYA_REVISION` | — | Hugging Face source coordinates. |
| `LAYA_CACHE` | `~/.cache/receptron-laya` | Download cache root. |
| `LAYA_EXECUTION_PROVIDERS` | `cpu` | onnxruntime execution providers (comma-separated). |
| `LAYA_CONFIDENCE_THRESHOLD` | `0.6` | Escalate below this operation/target confidence. |
| `LAYA_MAX_STEPS` | `15` | Autopilot step budget. |
| `LAYA_ALLOWED_DOMAINS` | — (allow all) | Comma-separated navigation allow-list. |
| `LAYA_DESTRUCTIVE_GUARD` | `true` | `false` disables the destructive-form guard. |

## Tools

### Assist tools

| Tool | Input schema | Description |
| --- | --- | --- |
| `browser_navigate` | `{ url: string }` | Navigate to a URL and return a snapshot (subject to the domain allow-list). |
| `browser_snapshot` | `{}` | Capture the current page as a compact `[ref=eN]` snapshot. |
| `browser_click` | `{ element?: string, target: string, doubleClick?: boolean, button?: "left"\|"right"\|"middle" }` | Click a ref/selector. |
| `browser_type` | `{ element?: string, target: string, text: string, submit?: boolean, slowly?: boolean }` | Type into a ref/selector; optional Enter/slow typing. |
| `browser_select_option` | `{ element?: string, target: string, values: string[] }` | Choose option(s) in a select/combobox. |
| `browser_press_key` | `{ key: string }` | Press a key or combination (e.g. `Enter`, `Control+A`). |
| `browser_wait_for` | `{ text?: string, textGone?: string, time?: number }` | Wait for text to appear/disappear or a duration. |
| `browser_close` | `{}` | Close the browser session. |

`element` is a human-readable description; `target` is either a snapshot ref (`e5`) or a
unique Playwright selector (CSS / `text=`).

### Autopilot tool

| Tool | Input schema | Description |
| --- | --- | --- |
| `laya_run_goal` | `{ goal: string, url?: string, maxSteps?: number }` | Pursue a natural-language goal using the local Laya engine + deterministic rules + LLM escalation. Returns a per-step transcript (operation / target / confidences / source), the final snapshot, and an independent final-page verification. Degrades to an Assist-mode hint if no weights are present. |

**Goal grammar** (small and explicit, matching the structured-form domain the model is strong
on): field assignments `email is "a@b.com"` / `keyword: laptop` / `search for "laptops"`, and
success markers `expect "Signed in"` / `see "Order placed"` / `until "Results"`.

## Weights

The Laya ONNX bundle is **not bundled** with this package. It is roughly **1.7 GB** (needs
~2 GB RAM loaded) and is downloaded/exported at runtime, cached under
`~/.cache/receptron-laya` (`LAYA_CACHE`) or pointed at via `LAYA_MODEL_DIR`. The bundle is
loaded through `Laya.load({ modelDir, repo, subfolder, revision, cacheDir, executionProviders })`.

### Web-agent export spike (VERIFIED)

We verified that the browser-agent checkpoint `abedinia/laya-web-agent` (mmBERT-derived,
ModernBERT-shaped, `max_len` 2048 / `head_max_len` 512, `jev_ultrafast` I/O) can be exported to
an ONNX bundle usable by `@receptron/laya`'s `modelDir` path with **no Python at runtime**.
The reference `export_onnx.py` exported it cleanly (logit parity `max |dlogits| = 2.48e-05`).
Loading it in Node initially failed because `@receptron/laya@0.1.2` hardcodes the ModernBERT
special-token names `[CLS] [SEP] [MASK] [PAD]`, while the web-agent tokenizer names them
`<bos>/<eos>/<mask>/<pad>`.

**Prepare step (one-line tokenizer rename).** Before writing the bundle, rename those four
special-token contents in `tokenizer/tokenizer.json` to the `[CLS]`-style names (**same token
IDs**). `Laya.load({ modelDir })` then loads and runs. This is a data rename, not a code
change to `@receptron/laya`, and the ONNX graph needs no modification.

**Fallback (not needed, documented for completeness).** If a future checkpoint's graph does
not export cleanly, a thin local Python sidecar using the `laya` pip package can serve
decisions over a local socket. This loses the no-Python-at-runtime property and is a last
resort. Independent of either path, the product and its whole test suite run **without any
weights** (Assist mode standalone, Autopilot degrades gracefully, tests use a stubbed engine).

## Development

```sh
pnpm run typecheck   # tsc --noEmit
pnpm run build       # tsc
pnpm run test        # vitest (offline: stubbed Laya + local HTML fixtures)
pnpm run bench       # offline benchmark over local fixtures with the stub engine
```

The offline benchmark (`pnpm run bench`) runs `laya_run_goal` with the StubEngine over the
local structured-form fixtures under `test/fixtures/`, records per-step correctness and
end-to-end success (via the independent final-page check), and prints a summary table. When
`LAYA_MODEL_DIR` is set, it also benchmarks the real engine.

## License and attribution

- **Project code: MIT.** See [LICENSE](./LICENSE).
- **Laya weights: Apache-2.0**, © Convai Innovations. Not redistributed by this project.
- **Mind2Web-derived material: CC BY 4.0.** Attribute Deng et al., *Mind2Web: Towards a
  Generalist Agent for the Web*, NeurIPS 2023. The Mind2Web test set is **not** redistributed
  here.
