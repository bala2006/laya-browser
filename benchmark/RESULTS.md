# Benchmark: laya-browser-mcp vs Playwright MCP

Generated 2026-09-27T19:26:36.746Z — 5 runs per task (first discarded as warm-up), median reported. Baseline: the real Playwright MCP (`@playwright/mcp`). All tasks run against identical local loopback HTML fixtures (no live sites) for deterministic, fair results.

## Headline

| Metric | laya-browser-mcp (Assist) | Playwright MCP |
| --- | --- | --- |
| Tasks applicable | 19 | 16 |
| Tasks passed | 19 | 16 |
| Success rate | 100% | 100% |
| Median latency (applicable tasks) | 306 ms | 945 ms |
| Tools exposed | 25 core / 72 all-caps | 24 core |

## Per-task results

| Task | Category | laya | laya ms | laya calls | Playwright | PW ms | PW calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nav-basic | navigation | PASS | 236 | 2 | PASS | 377 | 2 |
| search-type-submit | forms | PASS | 289 | 4 | PASS | 936 | 4 |
| login-fill-form | multi-field-form | PASS | 373 | 9 | PASS | 1062 | 9 |
| select-option | selection | PASS | 278 | 4 | PASS | 416 | 4 |
| click-button | click | PASS | 295 | 4 | PASS | 975 | 4 |
| hover-reveal | hover | PASS | 313 | 4 | PASS | 455 | 4 |
| wait-for-dynamic | wait-for | PASS | 1052 | 3 | PASS | 1197 | 3 |
| tabs-open | tabs | PASS | 324 | 5 | PASS | 1001 | 5 |
| dialog-confirm | dialogs | PASS | 312 | 6 | PASS | 954 | 6 |
| console-capture | console | PASS | 240 | 3 | PASS | 408 | 3 |
| network-capture | network | PASS | 238 | 3 | PASS | 401 | 3 |
| screenshot | screenshot | PASS | 274 | 2 | PASS | 433 | 2 |
| storage-cookies | storage | PASS | 320 | 5 | N/A | N/A | N/A |
| storage-localstorage | storage | PASS | 306 | 5 | N/A | N/A | N/A |
| evaluate | evaluate | PASS | 241 | 2 | PASS | 883 | 2 |
| flights-search | multi-field-form | PASS | 338 | 6 | PASS | 1016 | 6 |
| wiki-open | navigation | PASS | 334 | 7 | PASS | 1486 | 7 |
| hotel-search-filter | multi-field-form | PASS | 419 | 8 | PASS | 1584 | 8 |
| verify-text | verify | PASS | 289 | 5 | N/A | N/A | N/A |

## Success rate by category

| Category | laya | Playwright |
| --- | --- | --- |
| navigation | 100% | 100% |
| forms | 100% | 100% |
| multi-field-form | 100% | 100% |
| selection | 100% | 100% |
| click | 100% | 100% |
| hover | 100% | 100% |
| wait-for | 100% | 100% |
| tabs | 100% | 100% |
| dialogs | 100% | 100% |
| console | 100% | 100% |
| network | 100% | 100% |
| screenshot | 100% | 100% |
| storage | 100% | N/A |
| evaluate | 100% | 100% |
| verify | 100% | N/A |

## Autopilot round-trips (laya single-call goal runner)

laya-browser-mcp offers `laya_run_goal`, a single MCP call that runs the whole goal on-device/server-side. Playwright MCP has no single-call goal runner, so the same outcome needs a multi-call Assist script. Fewer client<->server round-trips is a real architectural difference, not a defect on either side.

| Task | laya Assist calls | Playwright calls | laya Autopilot calls | Autopilot result |
| --- | --- | --- | --- | --- |
| search-type-submit | 4 | 4 | 2 | PASS |
| login-fill-form | 9 | 9 | 3 | FAIL |
| flights-search | 6 | 6 | 2 | PASS |
| wiki-open | 7 | 7 | 3 | PASS |
| hotel-search-filter | 8 | 8 | 3 | PASS |

## Charts

![success-by-category.svg](charts/success-by-category.svg)

![latency-by-task.svg](charts/latency-by-task.svg)

![round-trips.svg](charts/round-trips.svg)

![capability-coverage.svg](charts/capability-coverage.svg)

## Honesty and limitations

- **Autopilot uses the REFERENCE stub engine (no model weights).** Its success reflects the deterministic rule layer (fill goal-stated fields, submit, verify the success marker), NOT a web-tuned model. On the multi-field login goal the reference stub batch-fills the text fields and submits without choosing the role option, so it does not satisfy the stricter Assist-mode verify — an honest reference-layer limitation, shown as FAIL.
- **Local fixtures, not live sites.** Every task runs against loopback HTML served from `benchmark/fixtures/`. This removes bot-detection and network-latency skew so the comparison is deterministic and fair; it is NOT a claim about live-web robustness.
- **Single machine, headless.** Latency figures include per-task process spin-up amortised by the warm-up run being discarded; absolute milliseconds are environment-specific and only the relative comparison is meaningful.
- **Both track `window.open` popups.** Like Playwright MCP, laya-browser-mcp subscribes to the browser context's `page` event, so a popup the page opens itself (via `window.open`, `target="_blank"`, or ctrl/cmd+click) becomes a listable, selectable tab; focus stays on the opener until you select it. Both pass the `tabs-open` popup task.
- **N/A is honest, not a loss.** Cookie, localStorage, and verify/assert tasks are N/A for Playwright MCP core because its core toolset has no such tools; laya exposes them under its `storage` / `testing` capabilities. Neither side is penalised for a capability the other simply does not offer.

## Reproduce

```sh
# from the project root
pnpm install
pnpm run build
pnpm run bench:compare   # writes results.json, RESULTS.md, and charts/
```

The harness launches both servers over MCP stdio, drives the identical task scripts against each (arg shapes match, so one script is fair to both), re-probes the real DOM for every success check, and regenerates this file plus `results.json` and the SVGs in `charts/`.

## Fast browser loop: before vs after

Generated 2026-09-27T19:28:44.386Z. 7 runs per task (first discarded as warm-up), median reported. This is laya's OWN Autopilot (`laya_run_goal`, reference stub engine) on identical local fixtures, run with the fast loop OFF (before, LAYA_FAST_LOOP unset) and ON (after, LAYA_FAST_LOOP=true). Only laya's dist server plus the loopback fixture server are involved (no @playwright/mcp). Metric labels: wall-clock ms and step/round-trip counts are MEASURED here; absolute ms are machine-specific, so only the relative before vs after delta is meaningful. The final-page verify() re-probes the real DOM and is the trust signal (a run counts only if it reached the same literal outcome).

| Task | before ms | after ms | ms delta | before steps | after steps | before browser RT | after browser RT | before verify | after verify |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flights-search | 468 | 513 | -10% | 3 | 3 | 2 | 2 | PASS | PASS |
| wiki-open | 450 | 475 | -6% | 3 | 3 | 2 | 2 | PASS | PASS |
| hotel-search-filter | 453 | 470 | -4% | 3 | 3 | 2 | 2 | PASS | PASS |

Reading the delta: a positive ms delta means the fast loop was faster (lower wall-clock). Step and browser-round-trip counts show whether the fast path reached the same real outcome with the same or fewer browser interactions per step; the win is in per-step target-resolution and settle cost, not in the number of decisions. verify() PASS on both sides means the fast path did not sacrifice correctness for speed.
