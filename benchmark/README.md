# Benchmark harness

A fair, honest comparison of **laya-browser-mcp** against the **real Playwright MCP**
(`@playwright/mcp`, the baseline). Both servers are driven over MCP stdio through the
**identical** task scripts against **identical local loopback HTML fixtures**, so the
comparison is deterministic and unbiased.

## Run it

From the project root:

```sh
pnpm run bench:compare
```

This builds the project if needed, installs the harness's own dev deps on first run, starts
the fixture server, runs the full matrix against both servers (plus a laya-only Autopilot
pass), and writes:

- `RESULTS.md` — the Markdown results table + honesty notes + reproduce steps.
- `results.json` — the full machine-readable model.
- `charts/*.svg` — success-by-category, latency-by-task, round-trips, capability-coverage.

Environment knobs: `BENCH_RUNS` (default 5), `PLAYWRIGHT_BROWSERS_PATH` (default
`/opt/playwright`, where the chrome-for-testing build the Playwright MCP subprocess needs is
installed).

## Layout

| File | Role |
| --- | --- |
| `server.mjs` | Local loopback fixture server (fixtures + a JSON endpoint). |
| `fixtures/*.html` | Broad-variety fixtures, each with a literal DOM/text success marker. |
| `tasks.mjs` | Task registry: per task an Assist script (fair to both servers) + optional laya Autopilot variant + a `verify()` predicate that re-probes the real DOM. |
| `runner.mjs` | Drives one server through the applicable tasks over MCP stdio, measuring success / latency / round-trips (N runs, first discarded as warm-up, median + p90). |
| `charts.mjs` | Hand-templated SVG bar charts (no charting library). |
| `compare.mjs` | Entrypoint: runs both servers, compiles the model, writes RESULTS.md / results.json / charts. |

## Fairness and honesty

- **Identical tasks and fixtures for both servers.** The arg shapes of laya-browser-mcp and
  Playwright MCP match (`target`, `text`, `values`, `fields`, ...), so a single Assist script
  drives both.
- **Success is re-probed on the real DOM**, not inferred from a tool's own success message.
- **N/A is recorded honestly** for tools a server's core toolset does not offer (Playwright MCP
  has no cookie/localStorage/verify tools); neither side is penalised for a missing capability.
- **Where Playwright wins, the table shows it** (e.g. `window.open` popup tab-tracking).
- **Autopilot uses the reference stub (no weights)**, so its numbers reflect the deterministic
  rule layer, not a web-tuned model.
