# Benchmark: laya-browser-mcp vs Playwright MCP

Generated 2026-09-26T19:25:14.603Z — 5 runs per task (first discarded as warm-up), median reported. Baseline: the real Playwright MCP (`@playwright/mcp`). All tasks run against identical local loopback HTML fixtures (no live sites) for deterministic, fair results.

## Headline

| Metric | laya-browser-mcp (Assist) | Playwright MCP |
| --- | --- | --- |
| Tasks applicable | 16 | 13 |
| Tasks passed | 15 | 13 |
| Success rate | 94% | 100% |
| Median latency (applicable tasks) | 217 ms | 942 ms |
| Tools exposed | 25 core / 72 all-caps | 24 core |

## Per-task results

| Task | Category | laya | laya ms | laya calls | Playwright | PW ms | PW calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nav-basic | navigation | PASS | 152 | 2 | PASS | 398 | 2 |
| search-type-submit | forms | PASS | 203 | 4 | PASS | 978 | 4 |
| login-fill-form | multi-field-form | PASS | 313 | 9 | PASS | 1152 | 9 |
| select-option | selection | PASS | 193 | 4 | PASS | 483 | 4 |
| click-button | click | PASS | 221 | 4 | PASS | 957 | 4 |
| hover-reveal | hover | PASS | 223 | 4 | PASS | 444 | 4 |
| wait-for-dynamic | wait-for | PASS | 965 | 3 | PASS | 1197 | 3 |
| tabs-open | tabs | FAIL | 224 | 5 | PASS | 972 | 5 |
| dialog-confirm | dialogs | PASS | 223 | 6 | PASS | 947 | 6 |
| console-capture | console | PASS | 152 | 3 | PASS | 439 | 3 |
| network-capture | network | PASS | 155 | 3 | PASS | 420 | 3 |
| screenshot | screenshot | PASS | 192 | 2 | PASS | 480 | 2 |
| storage-cookies | storage | PASS | 222 | 5 | N/A | N/A | N/A |
| storage-localstorage | storage | PASS | 227 | 5 | N/A | N/A | N/A |
| evaluate | evaluate | PASS | 153 | 2 | PASS | 942 | 2 |
| verify-text | verify | PASS | 212 | 5 | N/A | N/A | N/A |

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
