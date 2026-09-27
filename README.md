# laya-browser-mcp

**A superset of [Playwright MCP](https://github.com/microsoft/playwright-mcp) with a local,
sub-100ms Laya on-device decision engine.** It exposes the familiar ref-based Playwright
browser tools (Assist mode) and adds an Autopilot loop (`laya_run_goal`) that resolves each
step's element/action choice **on-device** with a local Laya "System 1" model, so the client
LLM is invoked far less often. When the local model is not confident, Autopilot escalates the
single step to the client's own LLM via **MCP sampling**.

- [What it is and honest positioning](#what-it-is-and-honest-positioning)
- [Quick start (easy setup)](#quick-start-easy-setup)
- [Tools](#tools)
- [Benchmark results](#benchmark-results)
- [Autopilot](#autopilot)
- [How it works](#how-it-works)
- [Configuration reference](#configuration-reference)
- [Development](#development)
- [Weights](#weights)
- [License and attribution](#license-and-attribution)

## What it is and honest positioning

laya-browser-mcp is a **drop-in superset of Playwright MCP** plus a **fast local decision
layer with an LLM fallback**. It is not a magic autonomous agent. Please read this before
deciding whether it fits your use case:

- **Playwright-MCP superset.** Every core browser tool uses the same ref-based contract
  (`browser_snapshot` gives `[ref=eN]` markers; you pass a ref as `target` to
  `browser_click` / `browser_type` / ...). Migrating from Playwright MCP is a config change.
- **Strong on clean, structured forms.** The web-agent checkpoint scores roughly **97.7%
  per-step** on clean synthetic forms (search boxes, filters, logins, checkouts).
- **Weak on arbitrary real sites.** On real-world Mind2Web pages it is only right about
  **1 step in 5** end to end. Autopilot leans on deterministic rules and LLM escalation to
  cover the gap, and it still may fail on messy sites.
- **The reference model is not web-tuned.** The bundled reference/stub decision layer is
  deterministic rules, not a web-tuned model. Treat Autopilot numbers here as the rule
  layer's behaviour, not a model benchmark.
- **NOT a fully autonomous general web agent.** Do not deploy it unattended against sites
  where a wrong click matters. `DONE` is never trusted on its own: every run ends with an
  **independent final-page verification**.
- **Works with no weights.** Assist mode is fully standalone (no model needed). Autopilot
  degrades gracefully to an Assist-mode hint when weights are absent.

## Quick start (easy setup)

Requires **Node.js 22+** and `pnpm`.

```sh
# 1. Install dependencies
pnpm install

# 2. Install the Chromium browser Playwright drives
pnpm exec playwright install chromium

# 3. Build the server (emits dist/index.js)
pnpm run build
```

That is enough to run **Assist mode** with no model weights.

### MCP client configuration (stdio)

Point your MCP client at the built entry with a stdio server block:

```jsonc
{
  "mcpServers": {
    "laya-browser": {
      "command": "node",
      "args": ["/absolute/path/to/laya-browser-mcp/dist/index.js"],
      "env": {
        // Optional: enable extra tool groups (default is core-only, like Playwright MCP)
        "LAYA_CAPS": "network,storage,testing,devtools,pdf,vision,config",
        // Optional: pick a browser engine (chromium | firefox | webkit)
        "LAYA_BROWSER": "chromium",
        // Optional (Autopilot): use local weights when present, else the stub
        "LAYA_ENGINE": "auto",
        "LAYA_MODEL_DIR": "/absolute/path/to/laya-onnx-bundle"
      }
    }
  }
}
```

- **Enable extra tools** with `LAYA_CAPS` (comma or space separated). Unset means **core-only**,
  matching Playwright MCP. See [capability groups](#capability-groups-laya_caps).
- **Cross-browser** with `LAYA_BROWSER`. Chromium is preinstalled; Firefox / WebKit need
  `pnpm exec playwright install firefox webkit` first.
- Clients that intend to use Autopilot should advertise the `sampling` capability so the
  low-confidence escalation path is available. Autopilot still runs without it (it degrades to
  `BLOCKED` on low confidence).

## Tools

The full toolset is a capability-gating registry (`src/tools/index.ts`): a tool with no
capability is **CORE** and always registered; a tool tagged with a capability is registered
only when that capability is enabled via `LAYA_CAPS`. Core-only exposes **25 tools**; enabling
every group exposes **72 tools**. The tables below list every tool grouped by capability.

### Capability groups (`LAYA_CAPS`)

Like Playwright MCP, the server exposes only its **core** toolset by default. Extra groups are
opt-in through `LAYA_CAPS`, a comma or space separated list. An unset or empty `LAYA_CAPS`
registers **core-only**; unknown names are ignored.

| Group | What it adds |
| --- | --- |
| `network` | Request route-mocking (fulfill/abort) and an offline/online toggle. |
| `storage` | Cookies, `localStorage`, `sessionStorage`, and save/restore of the storage state. |
| `testing` | Playwright locator generation and `verify_*` assertions. |
| `devtools` | Real tracing + element highlight; honest no-ops for the headed-only codegen/video features. |
| `pdf` | Save the page as a PDF (Chromium-only). |
| `vision` | Coordinate-based mouse primitives (move/click/drag/down/up/wheel). |
| `config` | Report the resolved configuration. |

```sh
# enable every group at once
LAYA_CAPS=network,storage,testing,devtools,pdf,vision,config
```

Only the core tools plus the groups you list are registered; everything else is neither listed
nor callable.

### CORE tools (always registered)

| Tool | Description |
| --- | --- |
| `browser_navigate` | Navigate to a URL and return a snapshot of the resulting page (subject to the domain allow-list). |
| `browser_navigate_back` | Navigate back to the previous page and return a snapshot. |
| `browser_resize` | Resize the viewport to a given width and height, then return a snapshot. |
| `browser_snapshot` | Capture a compact accessibility snapshot; interactive elements carry stable `[ref=eN]` markers. |
| `browser_click` | Click an element identified by a snapshot ref (`eN`) or a Playwright selector. |
| `browser_type` | Type text into an editable element (ref `eN` or selector). |
| `browser_hover` | Hover over an element (ref `eN` or selector). |
| `browser_find` | Search the current snapshot for controls whose name/value/role matches a substring or regexp, returning each match's ref. |
| `browser_drag` | Drag one element and drop it onto another. |
| `browser_drop` | Drop files (`paths`) or MIME data (`data`) onto an element. |
| `browser_fill_form` | Fill multiple form fields (textbox/checkbox/radio/combobox/slider) in a single call, then return one snapshot. |
| `browser_evaluate` | Evaluate a JavaScript function on the page or on an element, returning the JSON result. |
| `browser_select_option` | Select one or more options in a dropdown (ref `eN` or selector). |
| `browser_press_key` | Press a keyboard key or combination (e.g. `Enter`, `Control+A`). |
| `browser_wait_for` | Wait for text to appear, text to disappear, or a fixed number of seconds. |
| `browser_close` | Close the browser session and release all resources. |
| `browser_tabs` | Manage tabs: list, create (optionally at a URL), close by index, or select by index. |
| `browser_handle_dialog` | Register how the NEXT JS dialog (alert/confirm/prompt/beforeunload) is handled; call before the triggering action. |
| `browser_file_upload` | Upload files by setting them on a file input (ref/selector; defaults to the first file input). |
| `browser_take_screenshot` | Capture a screenshot of the page (or one element) as a PNG/JPEG/WebP image block. |
| `browser_console_messages` | Return console messages and uncaught page errors captured since session start; optionally errors only. |
| `browser_network_requests` | List captured network requests, one per line (index, method, status, URL). |
| `browser_network_request` | Return the full detail of one captured request, selected by `index` or by a `url` substring. |
| `browser_run_code_unsafe` | DANGEROUS: run a raw Playwright snippet against the page. Disabled unless `LAYA_ALLOW_UNSAFE_CODE=true` (see divergence notes). |

`element` (where present) is a human-readable description; `target` is either a snapshot ref
(`e5`) or a unique Playwright selector (CSS / `text=`).

### STORAGE tools (`LAYA_CAPS=storage`)

| Tool | Description |
| --- | --- |
| `browser_cookie_list` | List all cookies in the current context. |
| `browser_cookie_get` | Get the cookie(s) with a given name. |
| `browser_cookie_set` | Set or overwrite a cookie (omit domain to scope it to the active page). |
| `browser_cookie_delete` | Delete the cookie(s) with a given name. |
| `browser_cookie_clear` | Remove all cookies from the context. |
| `browser_localstorage_list` | List all `localStorage` entries on the active page. |
| `browser_localstorage_get` | Get a `localStorage` entry by key. |
| `browser_localstorage_set` | Set a `localStorage` entry. |
| `browser_localstorage_delete` | Delete a `localStorage` entry by key. |
| `browser_localstorage_clear` | Clear all `localStorage` entries. |
| `browser_sessionstorage_list` | List all `sessionStorage` entries on the active page. |
| `browser_sessionstorage_get` | Get a `sessionStorage` entry by key. |
| `browser_sessionstorage_set` | Set a `sessionStorage` entry. |
| `browser_sessionstorage_delete` | Delete a `sessionStorage` entry by key. |
| `browser_sessionstorage_clear` | Clear all `sessionStorage` entries. |
| `browser_storage_state` | Save the context's cookies and per-origin `localStorage` to a JSON file (Playwright storageState format). |
| `browser_set_storage_state` | Restore cookies and per-origin `localStorage` from a storage-state JSON file. |

### NETWORK tools (`LAYA_CAPS=network`)

| Tool | Description |
| --- | --- |
| `browser_route` | Mock a request: fulfill matching requests with a canned response, or abort them, by URL pattern. |
| `browser_route_list` | List the active route-mocking rules. |
| `browser_unroute` | Remove a route-mocking rule by its URL pattern. |
| `browser_network_state_set` | Set network connectivity: offline (`true`) or online (`false`). |

### TESTING tools (`LAYA_CAPS=testing`)

| Tool | Description |
| --- | --- |
| `browser_generate_locator` | Generate a stable Playwright locator (`getByRole`/`getByText`/`locator`) for an element. |
| `browser_verify_element_visible` | Assert the element is visible. Returns PASS or FAIL. |
| `browser_verify_text_visible` | Assert the given text is visible somewhere on the page. Returns PASS or FAIL. |
| `browser_verify_list_visible` | Assert a list container is visible and, optionally, that each expected item text is visible. Returns PASS or FAIL. |
| `browser_verify_value` | Assert a form field has an exact value. Returns PASS or FAIL. |

### PDF tools (`LAYA_CAPS=pdf`)

| Tool | Description |
| --- | --- |
| `browser_pdf_save` | Save the current page as a PDF (Chromium-only; print-to-PDF path). Returns the output path and byte size. |

### VISION tools (`LAYA_CAPS=vision`)

| Tool | Description |
| --- | --- |
| `browser_mouse_move_xy` | Move the mouse to absolute page coordinates. |
| `browser_mouse_click_xy` | Move to absolute coordinates and click; returns a fresh snapshot. |
| `browser_mouse_drag_xy` | Drag the mouse from a start coordinate to an end coordinate; returns a fresh snapshot. |
| `browser_mouse_down` | Press and hold a mouse button at the current cursor position. |
| `browser_mouse_up` | Release a mouse button at the current cursor position. |
| `browser_mouse_wheel` | Scroll the page by a wheel delta. |

### CONFIG tools (`LAYA_CAPS=config`)

| Tool | Description |
| --- | --- |
| `browser_get_config` | Return the resolved configuration (capabilities, engine, headless, viewport, thresholds, allow-list) as JSON. |

### DEVTOOLS tools (`LAYA_CAPS=devtools`)

| Tool | Description |
| --- | --- |
| `browser_start_tracing` | Start Playwright context tracing (screenshots + snapshots + sources). |
| `browser_stop_tracing` | Stop tracing and write the trace zip (open with `npx playwright show-trace`). |
| `browser_highlight` | Draw a visible outline around an element via an injected style. |
| `browser_hide_highlight` | Remove any outlines added by `browser_highlight`. |
| `browser_start_video` | Honest no-op: video capture needs `recordVideo` set at context creation (see divergence notes). |
| `browser_stop_video` | Honest no-op: no headless video recording is active (see divergence notes). |
| `browser_video_chapter` | Honest no-op: video chapters are a live trace-viewer feature (see divergence notes). |
| `browser_video_show_actions` | Honest no-op: action overlays are rendered by the interactive trace viewer (see divergence notes). |
| `browser_video_hide_actions` | Honest no-op: action overlays are rendered by the interactive trace viewer (see divergence notes). |
| `browser_start_recording` | Honest no-op: codegen recording needs the headed inspector (see divergence notes). |
| `browser_stop_recording` | Honest no-op: codegen recording needs the headed inspector (see divergence notes). |
| `browser_annotate` | Honest no-op: annotations are a live inspector feature (see divergence notes). |
| `browser_resume` | Honest no-op: there is no paused inspector to resume headless (see divergence notes). |

### Divergence notes (where behaviour differs from Playwright)

These tools are exposed for parity but behave differently in this headless server. Rather than
faking success, each is deliberate and documented:

- **`browser_pdf_save` is Chromium-only.** Print-to-PDF is a Chromium capability; on Firefox or
  WebKit the tool reports that it is unsupported instead of producing a bogus file.
- **`browser_run_code_unsafe` is gated by a flag.** It is always listed, but refuses with a
  clear message unless `LAYA_ALLOW_UNSAFE_CODE=true`. Running arbitrary Playwright code against
  the live page is a deliberate, risky opt-in.
- **The DEVTOOLS video / recording / annotate / resume tools are honest no-ops.** Tracing
  (`browser_start_tracing`/`browser_stop_tracing`) and element highlight
  (`browser_highlight`/`browser_hide_highlight`) are **real**. The video, codegen recording,
  video chapter/action-overlay, annotate, and resume tools correspond to Playwright's headed
  codegen/inspector features that have **no faithful headless analogue**, so they return an
  honest text result explaining what the real interactive feature would do rather than
  pretending to succeed.

## Benchmark results

A fair, honest comparison against the **real Playwright MCP** (`@playwright/mcp`, the
baseline), driving both servers over MCP stdio through the **identical** task scripts (the arg
shapes match, so one script is fair to both) against **identical local loopback HTML fixtures**
(no live sites, so no bot-detection or network-latency skew). Every success check re-probes the
real DOM. N=5 runs per task, first discarded as warm-up, median reported. Full detail and the
reproduce steps live in [`benchmark/RESULTS.md`](./benchmark/RESULTS.md).

### Headline

| Metric | laya-browser-mcp (Assist) | Playwright MCP |
| --- | --- | --- |
| Tasks applicable | 16 | 13 |
| Tasks passed | 16 | 13 |
| Success rate | 100% | 100% |
| Median latency (applicable tasks) | 211 ms | 919 ms |
| Tools exposed | 25 core / 72 all-caps | 24 core |

### Per-task results

| Task | Category | laya | laya ms | laya calls | Playwright | PW ms | PW calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nav-basic | navigation | PASS | 152 | 2 | PASS | 405 | 2 |
| search-type-submit | forms | PASS | 198 | 4 | PASS | 976 | 4 |
| login-fill-form | multi-field-form | PASS | 311 | 9 | PASS | 1102 | 9 |
| select-option | selection | PASS | 196 | 4 | PASS | 482 | 4 |
| click-button | click | PASS | 211 | 4 | PASS | 962 | 4 |
| hover-reveal | hover | PASS | 218 | 4 | PASS | 484 | 4 |
| wait-for-dynamic | wait-for | PASS | 966 | 3 | PASS | 1225 | 3 |
| tabs-open | tabs | PASS | 235 | 5 | PASS | 1040 | 5 |
| dialog-confirm | dialogs | PASS | 228 | 6 | PASS | 1001 | 6 |
| console-capture | console | PASS | 149 | 3 | PASS | 450 | 3 |
| network-capture | network | PASS | 157 | 3 | PASS | 415 | 3 |
| screenshot | screenshot | PASS | 190 | 2 | PASS | 508 | 2 |
| storage-cookies | storage | PASS | 218 | 5 | N/A | N/A | N/A |
| storage-localstorage | storage | PASS | 225 | 5 | N/A | N/A | N/A |
| evaluate | evaluate | PASS | 155 | 2 | PASS | 950 | 2 |
| verify-text | verify | PASS | 208 | 5 | N/A | N/A | N/A |

_(Absolute milliseconds are environment-specific; only the relative comparison is meaningful.
Numbers above are one recorded run; re-running regenerates them.)_

### Charts

![Success rate by category](benchmark/charts/success-by-category.svg)

![Median latency by task](benchmark/charts/latency-by-task.svg)

![Round-trips per task](benchmark/charts/round-trips.svg)

![Capability coverage](benchmark/charts/capability-coverage.svg)

### What each side won and lost (honest)

- **Both track tab popups.** Like Playwright MCP, laya-browser-mcp now subscribes to the
  browser context's `page` event, so a `window.open` popup the page opens itself is tracked as
  a listable, selectable tab (focus stays on the opener until you select it). Both pass
  `tabs-open`.
- **laya wins on latency here.** Against local fixtures laya's median per-task time is well
  under Playwright MCP's. This is an in-process advantage on local pages, not a claim about
  live-web robustness.
- **N/A is honest, not a loss.** Cookie, localStorage, and verify/assert tasks are N/A for
  Playwright MCP core because its core toolset has no such tools; laya offers them under its
  `storage` / `testing` capabilities. Neither side is penalised for a capability the other
  simply does not offer.
- **Both pass all shared basics** (navigation, search, multi-field form, select, click, hover,
  wait-for-dynamic, tabs, dialogs, console, network, screenshot, evaluate).

### Limitations of this benchmark

- **Local fixtures, not live sites.** Removes bot-detection and network-latency skew for a
  deterministic, fair comparison; it is NOT a live-web robustness claim.
- **Single machine, headless.** Latency includes per-task process spin-up, amortised by
  discarding the warm-up run. Absolute milliseconds are environment-specific.
- **Autopilot uses the reference stub (no weights),** so its success reflects the deterministic
  rule layer, not a web-tuned model (see the [Autopilot](#autopilot) section).

### Reproduce

```sh
pnpm install
pnpm run build
pnpm run bench:compare   # writes benchmark/results.json, benchmark/RESULTS.md, benchmark/charts/
```

`pnpm run bench:compare` starts the local fixture server, launches both MCP servers, runs the
full matrix, and regenerates the results table, `results.json`, and the SVG charts. It installs
the benchmark's own dev deps (`@playwright/mcp` + the MCP SDK) on first run.

## Autopilot

Give `laya_run_goal` a natural-language goal and it drives the current (or a given) page,
resolving each step on-device and escalating only low-confidence steps to the client LLM.

| Tool | Input schema | Description |
| --- | --- | --- |
| `laya_run_goal` | `{ goal: string, url?: string, maxSteps?: number }` | Pursue a natural-language goal using the local Laya engine + deterministic rules + LLM escalation. Returns a per-step transcript (operation / target / confidences / source), the final snapshot, and an independent final-page verification. Degrades to an Assist-mode hint if no weights are present. |

**Goal grammar** (small and explicit, matching the structured-form domain the model is strong
on): field assignments `email is "a@b.com"` / `keyword: laptop` / `search for "laptops"`, and
success markers `expect "Signed in"` / `see "Order placed"` / `until "Results"`.

### Operation set (broadened to drive the richer toolset faster)

The base operation set mirrors `abedinia/laya-web-agent`
(`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`). Autopilot broadens
it so a single step can do more of the work, modelled as a **discriminated union so illegal
(operation, payload) combinations are unrepresentable** (`src/types.ts`):

| Operation | Shape | What it does |
| --- | --- | --- |
| `HOVER` | targeted (`target`) | Move the pointer over a control. |
| `NAVIGATE_BACK` | targetless | Go back in history. |
| `PRESS_KEY` | carries `key` | Press a keyboard key such as `Enter`/`Escape`. |
| `FILL_FORM` | carries `fields[]`, no single `target` | Fill SEVERAL fields in ONE batch step. |
| `SCREENSHOT` | terminal | Capture the page as a verification/terminal step. |
| `VERIFY` | terminal, carries a marker | Check an expected marker against the live page. |

So a `FILL_FORM` can never carry a lone `target`, a `PRESS_KEY` can never lack a `key`, and a
targetless operation can never carry field payloads.

### Faster automation: fewer round-trips (measured)

The concrete speed-up is **fewer client<->server round-trips** on multi-step goals. A single
`laya_run_goal` call runs the whole goal on-device/server-side; Playwright MCP has no
single-call goal runner, so the same outcome needs a multi-call Assist script. This is a real
architectural difference, not a defect on either side. From the benchmark
([`benchmark/RESULTS.md`](./benchmark/RESULTS.md)):

| Task | laya Assist calls | Playwright calls | laya Autopilot calls | Autopilot result |
| --- | --- | --- | --- | --- |
| search-type-submit | 4 | 4 | **2** | PASS |
| login-fill-form | 9 | 9 | **3** | FAIL |

On the search goal Autopilot completes in **2 round-trips vs 4** for the Assist script. On the
multi-field login goal, the **reference stub** batch-fills the text fields and submits without
choosing the role option, so it does not satisfy the stricter Assist-mode verify: it is shown
honestly as **FAIL**. This reflects the deterministic rule layer with **no model weights**, not
a web-tuned model. `DONE` is never trusted on its own: after the loop, the independent
final-page verification runs regardless of how the loop ended.

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

### Autopilot decision pipeline

```
snapshot -> compact typed PageState -> DECISION -> execute (Playwright) -> repeat
```

The **decision** stage follows the authoritative laya-ultrafast design lesson — *Laya answers
narrow questions reliably but not the open "what next?"* — as a three-stage pipeline:

1. **Deterministic-rule seed** (`src/autopilot/policy.ts`). High-confidence, transparent
   rules: (1) fill the values the goal states, mapping each to a field (when two or more fields
   are unfilled, batch them into ONE `FILL_FORM` step rather than N separate type steps);
   (2) after typing into or opening a control, prefer choosing from the options that just
   appeared; (3) once every goal-stated field is filled, submit — then open/verify the named
   item.
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

### Reliability and self-healing

Three always-on (by default) reliability behaviours keep a run robust and bounded:

- **Self-healing refs (`LAYA_SELF_HEAL_RETRIES`, default `1`).** When a targeted action
  (`CLICK`/`TYPE_TEXT`/`SELECT`/`HOVER`) fails because its captured ref went stale (the DOM
  re-rendered between snapshot and execution), Autopilot re-captures the page, re-resolves the
  **same** element by its accessible **name + role**, and retries against the fresh ref. When
  no matching element is found the original error is rethrown. Steps that needed a retry record
  `retries` in the transcript and surface a "Re-resolving stale element" hint on the overlay.
- **Settle detection (`LAYA_SETTLE_PROBE`, default on).** After each action the loop runs a
  short, bounded probe (`document.readyState` + URL change + a brief `MutationObserver` window,
  capped at ~400ms). It uses **no** `networkidle` and **no** `slowMo`. The probe is purely
  observational: it records `settled` on the step (and toasts "No change detected" when nothing
  moved) but never changes the decision path or the run outcome.
- **Loop detection / stuck guard (`LAYA_LOOP_DETECTION`, default on; `LAYA_LOOP_WINDOW`,
  default `3`).** The loop signs each step by URL + control set + decision. When the last
  `LAYA_LOOP_WINDOW` steps are identical (no progress) it stops early with the additive
  **`stuck`** outcome instead of burning the whole step budget.

### Safety guards (`src/safety.ts`)

- **Domain allow-list.** When `LAYA_ALLOWED_DOMAINS` is set, `browser_navigate` and every
  Autopilot navigation are restricted to those hosts and their subdomains; off-list
  navigation is rejected with a reason (fail-closed).
- **Destructive-form guard.** This guard covers the **Autopilot auto-submit (`CLICK`) path
  only** — the human-driven Assist tools (`browser_click`, `browser_type`, …) apply no
  destructive check by design. Before Autopilot auto-submits, it inspects a **scoped** set of
  signals for a destructive keyword
  (`delete`/`remove`/`pay`/`purchase`/`confirm order`/`transfer`/`deactivate`): the target
  control's own accessible name, current value, and option labels; and the names of the other
  actionable controls (buttons/links) on the page. It also flags a form that combines a
  password field with a payment-like field. It deliberately does **not** scan the whole page's
  visible body text, so prose that merely mentions "delete" elsewhere on the page does not trip
  it. When a signal is present the auto-submit is refused and the reason is surfaced, so a human
  can confirm explicitly. The check errs toward refusing (fail-safe). Disable with
  `LAYA_DESTRUCTIVE_GUARD=false`.

## Configuration reference

All configuration is parsed **once** (`src/config.ts`) from environment + tool args +
constructor options, then handed inward as typed config.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAYA_BROWSER_HEADLESS` | `false` (headed) | Set `true` to run headless. A headed launch on a machine with no display server auto-falls-back to headless (one stderr warning). |
| `LAYA_BROWSER_CHANNEL` | — | Chromium channel (e.g. `chrome`). |
| `LAYA_BROWSER_VIEWPORT` | `1280x800` | Viewport `WIDTHxHEIGHT`. |
| `LAYA_BROWSER_OVERLAY` | `auto` | agentLens visual overlay: `auto` (on when headed, off when headless), `on`, or `off`. |
| `LAYA_BROWSER_OVERLAY_ACCENT` | `#a855f7` | Overlay brand accent as a `#rgb`/`#rrggbb` hex (invalid falls back to the default). |
| `LAYA_BROWSER_OVERLAY_TYPING` | `false` | `true` enables the per-character typing effect. |
| `LAYA_BROWSER_OVERLAY_COUNTDOWN` | `false` | `true` shows a WAIT countdown. |
| `LAYA_BROWSER_OVERLAY_DEBUG` | `false` | `true` outlines the elements the agent sees. |
| `LAYA_BROWSER_OVERLAY_LOG` | `true` | `false` hides the collapsible activity-log panel. |
| `LAYA_AUTOPILOT_WAIT_MS` | `300` | Autopilot `WAIT` duration in ms (clamped `0..5000`). |
| `LAYA_ENGINE` | `auto` | `stub` forces the deterministic engine; `auto` uses weights when present. |
| `LAYA_MODEL_DIR` | — | Local ONNX bundle directory (skips download). |
| `LAYA_REPO` / `LAYA_SUBFOLDER` / `LAYA_REVISION` | — | Hugging Face source coordinates. |
| `LAYA_CACHE` | `~/.cache/receptron-laya` | Download cache root. |
| `LAYA_EXECUTION_PROVIDERS` | `cpu` | onnxruntime execution providers (comma-separated). |
| `LAYA_CONFIDENCE_THRESHOLD` | `0.6` | Escalate below this operation/target confidence. |
| `LAYA_MAX_STEPS` | `15` | Autopilot step budget. |
| `LAYA_ALLOWED_DOMAINS` | — (allow all) | Comma-separated navigation allow-list. |
| `LAYA_DESTRUCTIVE_GUARD` | `true` | `false` disables the destructive-form guard. |
| `LAYA_CAPS` | (core-only) | Comma/space-separated tool capability groups to enable. |
| `LAYA_BROWSER` | `chromium` | Browser engine: `chromium`, `firefox`, or `webkit`. |
| `LAYA_ALLOW_UNSAFE_CODE` | `false` | `true` lets `browser_run_code_unsafe` actually run raw Playwright snippets. |
| `LAYA_SELF_HEAL_RETRIES` | `1` | Autopilot self-healing retries for a failed targeted action, re-resolving the same element by name+role (clamped `0..3`; `0` disables). |
| `LAYA_SETTLE_PROBE` | `true` | `false` disables the purely-observational post-action settle probe (readyState + URL + a short bounded MutationObserver window; never `networkidle`). |
| `LAYA_LOOP_DETECTION` | `true` | `false` disables loop detection; when on, an Autopilot run that repeats the identical step stops early with the `stuck` outcome. |
| `LAYA_LOOP_WINDOW` | `3` | How many recent steps the loop detector compares before declaring a run `stuck` (clamped `2..6`). |

### Cross-browser (`LAYA_BROWSER`)

The browser engine is selected once from `LAYA_BROWSER` (`chromium` by default). Chromium is
preinstalled; **Firefox and WebKit must be installed first**:

```sh
pnpm exec playwright install firefox webkit
```

The Chromium `channel` option (e.g. `chrome`, `msedge`) is applied only for the `chromium`
engine; Firefox and WebKit have no channel. Everything else (viewport, timeouts, multi-tab,
console / network / dialog listeners, routing, storage, the ref boundary) is identical across
engines because engine selection is confined to `src/browser.ts`.

**Tested engines.** Chromium is the default and is exercised by the whole suite. **Firefox was
smoke-tested** here: it really launches and drives the sign-in fixture to its literal
signed-in outcome. **WebKit is gated in this sandbox**: the binary downloads, but launch fails
on this host for lack of system shared libraries, so the WebKit smoke test probes real
launchability once and `describe.skipIf`s itself rather than faking a pass. It runs
automatically in an environment where WebKit can launch.

## Development

```sh
pnpm run typecheck    # tsc --noEmit
pnpm run build        # tsc
pnpm run test         # vitest (offline: stubbed Laya + local HTML fixtures)
pnpm run bench        # offline goal benchmark over local fixtures with the stub engine
pnpm run bench:compare # full comparison vs the real Playwright MCP (writes benchmark/ artifacts)
```

The offline goal benchmark (`pnpm run bench`) runs `laya_run_goal` with the StubEngine over the
local structured-form fixtures under `test/fixtures/`, and prints a summary with two columns:
**end-to-end success** (via the independent final-page check — the trustworthy signal) and
**expected-ops coverage** (`ops-cov`). The coverage column is a subsequence match — the fraction
of each fixture's expected operations that appear, in order, in the transcript — so it does
**not** penalize extra or wrong steps and should not be read as precision/accuracy. When
`LAYA_MODEL_DIR` is set, it also benchmarks the real engine.

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

## License and attribution

- **Project code: MIT.** See [LICENSE](./LICENSE).
- **Laya weights: Apache-2.0**, © Convai Innovations. Not redistributed by this project.
- **Mind2Web-derived material: CC BY 4.0.** Attribute Deng et al., *Mind2Web: Towards a
  Generalist Agent for the Web*, NeurIPS 2023. The Mind2Web test set is **not** redistributed
  here.
