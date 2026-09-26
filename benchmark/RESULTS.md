# Benchmark: laya-browser-mcp vs Playwright MCP

Generated 2026-09-26T19:36:16.942Z — 5 runs per task (first discarded as warm-up), median reported. Baseline: the real Playwright MCP (`@playwright/mcp`). All tasks run against identical local loopback HTML fixtures (no live sites) for deterministic, fair results.

## Headline

| Metric | laya-browser-mcp (Assist) | Playwright MCP |
| --- | --- | --- |
| Tasks applicable | 16 | 13 |
| Tasks passed | 15 | 13 |
| Success rate | 94% | 100% |
| Median latency (applicable tasks) | 210 ms | 950 ms |
| Tools exposed | 25 core / 72 all-caps | 24 core |

## Per-task results

| Task | Category | laya | laya ms | laya calls | Playwright | PW ms | PW calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nav-basic | navigation | PASS | 152 | 2 | PASS | 405 | 2 |
| search-type-submit | forms | PASS | 198 | 4 | PASS | 976 | 4 |
| login-fill-form | multi-field-form | PASS | 311 | 9 | PASS | 1102 | 9 |
| select-option | selection | PASS | 196 | 4 | PASS | 482 | 4 |
| click-button | click | PASS | 211 | 4 | PASS | 962 | 4 |
| hover-reveal | hover | PASS | 218 | 4 | PASS | 484 | 4 |
| wait-for-dynamic | wait-for | PASS | 966 | 3 | PASS | 1225 | 3 |
| tabs-open | tabs | FAIL | 227 | 5 | PASS | 1017 | 5 |
| dialog-confirm | dialogs | PASS | 228 | 6 | PASS | 1001 | 6 |
| console-capture | console | PASS | 149 | 3 | PASS | 450 | 3 |
| network-capture | network | PASS | 157 | 3 | PASS | 415 | 3 |
| screenshot | screenshot | PASS | 190 | 2 | PASS | 508 | 2 |
| storage-cookies | storage | PASS | 218 | 5 | N/A | N/A | N/A |
| storage-localstorage | storage | PASS | 225 | 5 | N/A | N/A | N/A |
| evaluate | evaluate | PASS | 155 | 2 | PASS | 950 | 2 |
| verify-text | verify | PASS | 208 | 5 | N/A | N/A | N/A |

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
| tabs | 0% | 100% |
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

## Charts

![success-by-category.svg](charts/success-by-category.svg)

![latency-by-task.svg](charts/latency-by-task.svg)

![round-trips.svg](charts/round-trips.svg)

![capability-coverage.svg](charts/capability-coverage.svg)

## Honesty and limitations

- **Autopilot uses the REFERENCE stub engine (no model weights).** Its success reflects the deterministic rule layer (fill goal-stated fields, submit, verify the success marker), NOT a web-tuned model. On the multi-field login goal the reference stub batch-fills the text fields and submits without choosing the role option, so it does not satisfy the stricter Assist-mode verify — an honest reference-layer limitation, shown as FAIL.
- **Local fixtures, not live sites.** Every task runs against loopback HTML served from `benchmark/fixtures/`. This removes bot-detection and network-latency skew so the comparison is deterministic and fair; it is NOT a claim about live-web robustness.
- **Single machine, headless.** Latency figures include per-task process spin-up amortised by the warm-up run being discarded; absolute milliseconds are environment-specific and only the relative comparison is meaningful.
- **Where Playwright wins, the table shows it.** Playwright MCP auto-tracks `window.open` popups as tabs; laya-browser-mcp's tab tool tracks only tabs it opens, so laya honestly FAILS the `tabs-open` popup task while Playwright passes.
- **N/A is honest, not a loss.** Cookie, localStorage, and verify/assert tasks are N/A for Playwright MCP core because its core toolset has no such tools; laya exposes them under its `storage` / `testing` capabilities. Neither side is penalised for a capability the other simply does not offer.

## Reproduce

```sh
# from the project root
pnpm install
pnpm run build
pnpm run bench:compare   # writes results.json, RESULTS.md, and charts/
```

The harness launches both servers over MCP stdio, drives the identical task scripts against each (arg shapes match, so one script is fair to both), re-probes the real DOM for every success check, and regenerates this file plus `results.json` and the SVGs in `charts/`.
