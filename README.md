# Amaterasu

A self-hosted, TradingView-style charting app for Indian markets, with an embedded AI agent
that draws directly on your charts.

Amaterasu pairs live OHLC data from the INDmoney MCP with an [OpenCode](https://opencode.ai)
agent that reads and annotates charts through a structured overlay protocol. Instead of
screenshots, the agent works with chart state as data — OHLC arrays, visible ranges, and
existing annotations — and draws trendlines, rectangles, Fibonacci retracements, channels, and
computed indicator series through the same op DSL the mouse uses.

> Not affiliated with INDmoney. Market data is provided by the INDmoney MCP.

## Features

- **Live Indian market data** — candles, quotes, and symbol search via the INDmoney MCP, with
  INDmoney OAuth (DCR + PKCE).
- **Overlay engine** — data-space anchored annotations (trendline, ray, rectangle, horizontal
  and vertical lines, label, Fibonacci, channel) that survive pan, zoom, and interval switches.
- **AI chart analyst** — an embedded OpenCode agent with `chart_*` tools that draws and updates
  overlays, plots computed series (e.g. SMA), and answers questions with full tool access.
- **Structured draw protocol** — one shared op DSL for mouse, agent, and persistence; ops are
  ack-based and source-stamped per turn.
- **Per-turn undo** — reverts exactly the shapes and series created in a turn.
- **Per-symbol workspaces** — drawings and series persist server-side in SQLite and reload with
  the instrument.
- **Self-hosted** — one Rust service serves the API, SSE channels, and the built SPA; ships
  with an nginx + systemd deployment runbook.

## Architecture

Three decoupled channels keep the data path independent of the agent:

```
Browser (SvelteKit SPA)
  ├─ lightweight-charts v5 + overlay canvases
  ├─ op reducer · undo transactions
  └─ chat panel
        │
        ▼
Rust service (axum, :8787)
  ├─ REST + SSE · cache · SQLite · serves web/build
  ├─ ── data ──►  INDmoney MCP
  └─ ── agent ─►  opencode serve (:4096) ──► chart-bridge plugin
                                                  │ drawing (RPC)
                                                  └──────────────► Browser
```

- **Data** — the webapp talks to the INDmoney MCP directly through the Rust service's own MCP
  client.
- **Agent** — the browser streams chat through the Rust service to a dedicated OpenCode server.
- **Drawing** — the chart-bridge plugin and the browser exchange ops over plugin RPC, so
  refreshing data never depends on the agent.

## Repository layout

| Path | Contents |
|---|---|
| `web/` | SvelteKit 2 + Svelte 5 client — overlay engine, components, chart shell |
| `packages/chart-dsl/` | Shared zod schemas for chart ops and state |
| `server/` | Rust (axum) service — MCP client + OAuth, cache, OpenCode bridge, SSE, SQLite, static hosting |
| `opencode/` | The agent's project — chart-bridge plugin, agent config, permissions |
| `deploy/` | nginx vhost, systemd units, env template, deployment runbook |
| `PLAN.md` | The design of record |

## Getting started

### Prerequisites

- Node.js ≥ 20 (22+ recommended) and npm
- Rust (cargo) for the API service
- [OpenCode](https://opencode.ai) 2.x for the agent bridge (optional for chart-only use)

### Install

```sh
npm install        # repo root; npm workspaces
```

### Run the dev servers

```sh
# web client (http://127.0.0.1:3000)
npm run dev --workspace @amaterasu/web

# API service on :8787 — proxies /api from the web dev server
AMATERASU_APP_URL=http://127.0.0.1:3000 cargo run --manifest-path server/Cargo.toml
```

The chart also runs offline with deterministic sample data at `?demo=1`.

### Enable the agent bridge (optional)

```sh
# 1. dedicated OpenCode server for the webapp's agent
cd opencode && OPENCODE_SERVER_PASSWORD=dev-workspace-secret \
  opencode serve --hostname 127.0.0.1 --port 4096

# 2. API service with chat enabled (from the repo root)
OPENCODE_PASSWORD=dev-workspace-secret OPENCODE_MODEL=opencode-go/deepseek-v4.1-flash \
  AMATERASU_APP_URL=http://127.0.0.1:3000 \
  cargo run --manifest-path server/Cargo.toml
```

## Commands

| Command | Purpose |
|---|---|
| `npm run test --workspace @amaterasu/web` | Web unit tests (Vitest) |
| `npm run check --workspace @amaterasu/web` | `svelte-kit sync` + `svelte-check` |
| `npm run verify:e2e --workspace @amaterasu/web` | Browser E2E checks (dev server running) |
| `npm run build --workspace @amaterasu/web` | Static SPA build into `web/build` |
| `cargo test --manifest-path server/Cargo.toml` | Rust unit tests |
| `cargo test --manifest-path server/Cargo.toml -- --ignored` | Live OAuth discovery + DCR check |

Production serves the built SPA from the API service:

```sh
AMATERASU_STATIC_DIR=/home/levi/amaterasu/web/build cargo run --manifest-path server/Cargo.toml
```

## Configuration

Copy [`deploy/amaterasu.env.example`](deploy/amaterasu.env.example) to `.env` and fill it in.
Key variables:

| Variable | Purpose |
|---|---|
| `AMATERASU_BASE_URL` / `AMATERASU_APP_URL` | Public origin; the INDmoney OAuth redirect is derived from `BASE_URL` |
| `AMATERASU_BIND` | Listen address (default `127.0.0.1:8787`) |
| `AMATERASU_STATIC_DIR` | Built SPA directory to serve |
| `AMATERASU_DATA_DIR` | Token store and app data |
| `OPENCODE_BASE_URL` / `OPENCODE_PASSWORD` | OpenCode server address and shared secret |
| `OPENCODE_AGENT` / `OPENCODE_MODEL` | Agent name and pinned model |
| `OPENCODE_DIRECTORY` | The `opencode/` project directory |
| `INDMONEY_MCP_URL` / `INDMONEY_SCOPE` | MCP endpoint and OAuth scopes (defaults provided) |

## Interaction

- **Select** — click to select, drag to move an annotation, `Delete` to remove, `Esc` to cancel.
- **Draw tools** — `Trend`/`Ray` are two clicks; `Rect` is click-click or drag; `H-Line`/`V-Line`/`Label`
  commit on click.
- **Pan** = drag empty space; **zoom** = wheel. Overlays are anchored in `(time, price)` and
  re-project on every viewport change.

## Deployment

See [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) for the full VPS guide — nginx + TLS + systemd,
the one-time INDmoney consent, upgrades, and troubleshooting.

## Documentation

[`PLAN.md`](PLAN.md) is the design of record: architecture, the overlay engine spec, the op
protocol, and the build plan.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. Run `npm run check --workspace @amaterasu/web` and `npm run test --workspace @amaterasu/web`.
2. Run `cargo test --manifest-path server/Cargo.toml` for the service.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

## License

[MIT](LICENSE)
