# Amaterasu

INDmoney-backed chart app with an embedded OpenCode agent that draws and writes on charts
through a data-space overlay protocol. **`PLAN.md` (v0.0.4) is the design of record.**

## Status

**Phase 1 complete — live data verified** (2026-09-17). Phase 0 delivered the overlay
engine (Transform + resolver, Painter, renderer registry, canvas layers, DOM labels), the op
DSL + reducer with snapshot undo, the SvelteKit chart shell + dev op console, and a 13-check
browser E2E harness. Phase 1 adds the Rust data service: INDmoney OAuth (DCR + PKCE S256 +
refresh, 0600 token store), a streamable-HTTP MCP client, `/api/candles` · `/api/search` ·
`/api/quote` with timestamp normalization and a single-flight TTL cache, and the live-data
shell (symbol search, interval tabs, quote header, auto-refresh, view persistence, plus a
`?demo=1` offline mode for deterministic E2E). Verified live: 248 daily RELIANCE bars
(2025-09-17 → 2026-09-17), live quote, 302 ms uncached intraday fetch, 3.6 ms cached reads,
annotations drawn on real data.

**Phase 2 complete** (2026-09-17): the `opencode/` project (chart-analyst agent + chart-bridge
plugin exposing `chart_*` tools over RPC) and the Rust bridge (chat sessions, a single upstream
event subscription fanned out to browsers, chart RPC forwarding) are live and verified — the
agent read the chart, drew on it, every op is stamped with its `sessionID`/`messageID`, and
per-turn undo removes exactly that turn's shapes. Two V2 facts to carry to the VPS: plugin/MCP
tools are reached through Code Mode (`execute` must be allowed; nested calls still enforce their
own permissions), and primary sessions ignore an agent's `model` (the bridge pins
`OPENCODE_MODEL`).

**Phase 3 complete** (2026-09-17): `fib` (7 labelled retracement levels) and `channel` (parallel
rails with fill) shapes, both handle-editable; computed **series** (`chart_add_series` /
`chart_remove_series` → autoscaled lightweight-charts lines, upsert by id, 12 series / 2500
points caps, undo-aware); per-turn undo now clears a turn's shapes *and* its series. Live-verified:
the agent drew a fib from the swing low to the high, a channel along the last 40 bars, and
plotted SMA(20) computed in Code Mode — the plotted last value matched the independently
computed SMA (₹1289.05) *and* the number it reported. A tool-schema bug (`points` capped at 2)
was caught by live testing: channels need 3, so the model had been composing them from
trendlines. 80 web tests, 14/14 demo E2E, 28 Rust tests. **Hardening** (2026-09-18): per-symbol workspace documents persisted server-side in SQLite —
drawings and computed series survive reloads, are scoped per symbol (switching instruments
swaps the document; the outgoing one is flushed first), and an upstream 5xx from INDmoney gets
one retry before the error surfaces. Next: execute
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) on the VPS (you drive it; everything it needs is
committed).

## Layout

| Path | Contents |
|---|---|
| `web/` | SvelteKit client: `src/routes` (shell page), `src/lib` (engine + components) |
| `packages/chart-dsl/` | zod op/state schemas (shared with the chart-bridge plugin in Phase 2) |
| `server/` | Rust (axum): MCP client + OAuth, cache, OpenCode bridge, SSE, static hosting |
| `opencode/` | the agent's project: chart-bridge plugin + config (Phase 2) |
| `deploy/` | nginx vhost + systemd units (Phase 4) |

## Commands

```sh
npm install                                     # repo root; npm workspaces
npm run dev --workspace @amaterasu/web          # web dev server on http://127.0.0.1:3000
npm run test --workspace @amaterasu/web         # vitest unit suite (53 tests)
npm run verify:e2e --workspace @amaterasu/web   # browser E2E checks (dev server must be running)
npm run check --workspace @amaterasu/web        # svelte-kit sync + svelte-check
npm run build --workspace @amaterasu/web        # SPA build into web/build

cargo test --manifest-path server/Cargo.toml                # Rust unit tests (23)
cargo test --manifest-path server/Cargo.toml -- --ignored   # live OAuth discovery + DCR check
# API service on :8787 (dev proxies /api from the web server to here):
AMATERASU_APP_URL=http://127.0.0.1:3000 cargo run --manifest-path server/Cargo.toml
```

Production: `AMATERASU_STATIC_DIR=/home/levi/amaterasu/web/build cargo run --manifest-path server/Cargo.toml`
serves the built SPA with an index.html fallback (then http://127.0.0.1:8787).

Local agent bridge (Phase 2 development):

```sh
# 1. dedicated OpenCode server for the webapp's agent (project: opencode/)
cd opencode && OPENCODE_SERVER_PASSWORD=dev-workspace-secret \
  opencode serve --hostname 127.0.0.1 --port 4096
# 2. the API service with chat enabled (from the repo root)
OPENCODE_PASSWORD=dev-workspace-secret OPENCODE_MODEL=opencode-go/deepseek-v4.1-flash \
  AMATERASU_APP_URL=http://127.0.0.1:3000 \
  cargo run --manifest-path server/Cargo.toml
# 3. type-check the plugin/agent project
cd opencode && npm install && npm run check
```

**Production deployment:** see [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) — nginx + TLS + systemd
on the VPS, the Firecrawl check, the INDmoney consent, upgrades, and troubleshooting.

## Dev op console

The right-hand panel applies chart ops through the same reducer the mouse and (Phase 2) the
agent use. Preset buttons fill the JSON box with valid ops built from the loaded bars; apply
them to draw. Results appear in the log with structured warnings and unresolved reasons.

In dev builds the controller is exposed as `window.__amaterasu` for E2E checks
(`getSnapshot()`, `pixelsOf(id)`).

## Interaction

- **Select** tool: click to select, drag to move an annotation, `Delete` removes, `Esc` cancels.
- Draw tools: `Trend`/`Ray` are two clicks; `Rect` is click-click or drag; `H-Line`/`V-Line`/`Label`
  commit on click.
- Pan = drag empty space; zoom = wheel. Overlays are anchored in `(time, price)` and re-project
  on every viewport change.
- Touch is left to the chart in Phase 0; touch drawing is Phase 3 work.
