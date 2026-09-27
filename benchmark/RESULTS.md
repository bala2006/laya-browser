# Benchmark: laya-browser-mcp vs Playwright MCP

Generated 2026-09-27T17:38:32.103Z. 5 runs per task (first discarded as warm-up), median reported. Baseline: the real Playwright MCP (`@playwright/mcp`). All tasks run against identical local loopback HTML fixtures (no live sites) for deterministic, fair results.

## Headline

| Metric | laya-browser-mcp (Assist) | Playwright MCP |
| --- | --- | --- |
| Tasks applicable | 23 | 20 |
| Tasks passed | 23 | 20 |
| Success rate | 100% | 100% |
| Median latency (applicable tasks) | 312 ms | 965 ms |
| Tools exposed | 25 core / 72 all-caps | 24 core |

## Per-task results

| Task | Category | laya | laya ms | laya calls | Playwright | PW ms | PW calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nav-basic | navigation | PASS | 242 | 2 | PASS | 410 | 2 |
| search-type-submit | forms | PASS | 293 | 4 | PASS | 939 | 4 |
| login-fill-form | multi-field-form | PASS | 388 | 9 | PASS | 1094 | 9 |
| select-option | selection | PASS | 282 | 4 | PASS | 479 | 4 |
| click-button | click | PASS | 312 | 4 | PASS | 942 | 4 |
| hover-reveal | hover | PASS | 302 | 4 | PASS | 475 | 4 |
| wait-for-dynamic | wait-for | PASS | 1053 | 3 | PASS | 1202 | 3 |
| tabs-open | tabs | PASS | 312 | 5 | PASS | 982 | 5 |
| dialog-confirm | dialogs | PASS | 320 | 6 | PASS | 960 | 6 |
| console-capture | console | PASS | 243 | 3 | PASS | 386 | 3 |
| network-capture | network | PASS | 242 | 3 | PASS | 423 | 3 |
| screenshot | screenshot | PASS | 274 | 2 | PASS | 452 | 2 |
| storage-cookies | storage | PASS | 321 | 5 | N/A | N/A | N/A |
| storage-localstorage | storage | PASS | 317 | 5 | N/A | N/A | N/A |
| evaluate | evaluate | PASS | 245 | 2 | PASS | 913 | 2 |
| verify-text | verify | PASS | 295 | 5 | N/A | N/A | N/A |
| signup-validated-form | multi-field-form | PASS | 385 | 9 | PASS | 1090 | 9 |
| search-then-select | search-select | PASS | 336 | 6 | PASS | 1502 | 6 |
| wizard-two-step | multi-step-navigation | PASS | 391 | 8 | PASS | 1583 | 8 |
| table-row-select | list-selection | PASS | 307 | 4 | PASS | 969 | 4 |
| consent-dismiss | consent-dismiss | PASS | 366 | 6 | PASS | 1505 | 6 |
| modal-dismiss | modal-dismiss | PASS | 357 | 6 | PASS | 1521 | 6 |
| login-then-action | multi-step-navigation | PASS | 409 | 9 | PASS | 1631 | 9 |

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
| search-select | 100% | 100% |
| multi-step-navigation | 100% | 100% |
| list-selection | 100% | 100% |
| consent-dismiss | 100% | 100% |
| modal-dismiss | 100% | 100% |

## Autopilot round-trips (laya single-call goal runner)

laya-browser-mcp offers `laya_run_goal`, a single MCP call that runs the whole goal on-device/server-side. Playwright MCP has no single-call goal runner, so the same outcome needs a multi-call Assist script. Fewer client<->server round-trips is a real architectural difference, not a defect on either side.

| Task | laya Assist calls | Playwright calls | laya Autopilot calls | Autopilot result |
| --- | --- | --- | --- | --- |
| search-type-submit | 4 | 4 | 2 | PASS |
| login-fill-form | 9 | 9 | 3 | FAIL |
| search-then-select | 6 | 6 | 2 | FAIL |
| consent-dismiss | 6 | 6 | 2 | FAIL |
| modal-dismiss | 6 | 6 | 2 | FAIL |

## Charts

![success-by-category.svg](charts/success-by-category.svg)

![latency-by-task.svg](charts/latency-by-task.svg)

![round-trips.svg](charts/round-trips.svg)

![capability-coverage.svg](charts/capability-coverage.svg)

## Honesty and limitations

- **Autopilot uses the REFERENCE stub engine (no model weights).** Its success reflects the deterministic rule layer (fill goal-stated fields, submit, verify the success marker), NOT a web-tuned model. Autopilot FAILs are honest reference-layer limitations, not defects of the loop: the stub batch-fills goal-stated text fields and submits, but it does not choose an unstated dropdown option (login-fill-form), it does not disambiguate one search result from a list (search-then-select), and clicking a marker button under a consent banner or blocking modal (consent-dismiss / modal-dismiss) needs the auto-dismiss pass plus a web-tuned target choice the stub does not make. The Assist column and the independent final-page verify are the trustworthy signals; a real model bundle (see the SETUP in the README) is what closes the Autopilot gap.
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
