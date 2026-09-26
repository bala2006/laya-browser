# laya-browser-mcp

A TypeScript / Node 22 [MCP](https://modelcontextprotocol.io) server that is a **superset of
Playwright MCP** plus a **local, sub-100ms [Laya](https://huggingface.co/convaiinnovations/laya)
on-device decision engine** for fast browser automation.

- **Assist mode** — the familiar ref-based Playwright toolset (navigate, snapshot, click, type,
  select, press_key, wait_for, close). Works standalone with **no model weights**.
- **Autopilot mode** — `laya_run_goal`: snapshot -> typed page state -> a local Laya narrow
  decision + deterministic rules -> Playwright execution -> repeat, escalating to the client LLM
  via MCP sampling on low confidence or when blocked, and degrading gracefully when weights are
  absent.

## Positioning (honest)

This is a **fast local decision layer with LLM fallback**. It is strong on structured forms and
limited on arbitrary real sites. It is **not** a fully autonomous general web agent. See
[`docs/PLAN.md`](docs/PLAN.md) for the phased plan, data shapes, the ONNX-export spike result,
and known risks.

## Status

Early scaffold (Phase 0). Toolchain, core data shapes (`src/types.ts`), and a green baseline are
in place; Assist tools, the Laya engine, and the Autopilot loop land in later phases.

## Develop

```sh
corepack enable
pnpm install
pnpm exec playwright install chromium
pnpm run typecheck
pnpm run build
pnpm run test        # offline: stubbed Laya + local HTML fixtures
```

The Laya ONNX bundle (~1.3–1.7 GB) is never committed. It is downloaded/exported at runtime and
cached under `~/.cache/receptron-laya` (`LAYA_CACHE`), or point at a local bundle via `modelDir`
/ `LAYA_MODEL_DIR`.

## License

Project code MIT. Laya weights Apache-2.0 (Convai Innovations). Any Mind2Web-derived material is
CC BY 4.0 (attribute Deng et al., NeurIPS 2023; do not redistribute the test set).
