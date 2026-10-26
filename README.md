# Amaterasu

A self-hosted, TradingView-style charting app for Indian markets, with an embedded AI agent
that draws directly on your charts.

[![CI](https://github.com/Sidharth-Singh10/Amaterasu/actions/workflows/ci.yml/badge.svg)](https://github.com/Sidharth-Singh10/Amaterasu/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-5d91e9.svg)](LICENSE)

Amaterasu pairs live OHLC data from the INDmoney MCP with an [OpenCode](https://opencode.ai)
agent that reads and annotates charts through a structured overlay protocol. Instead of
screenshots, the agent works with chart state as data — OHLC arrays, visible ranges, and
existing annotations — and draws trendlines, rectangles, Fibonacci retracements, channels, and
computed indicator series through the same op DSL the mouse uses.

> Not affiliated with INDmoney. Market data is provided by the INDmoney MCP.

> **SDK status:** the `@tenon-protocol/*` packages are built and ready for `0.1.0`, but npm
> publication is intentionally paused. Until the release, use the workspace source in `packages/`;
> the install commands below describe the published build.

## Tenon

Amaterasu is the reference app for **Tenon**, an open protocol for humans and AI agents
editing the same visual workspace. Agents send typed operations; every op is acknowledged,
attributable, reversible, scoped by a capability, and recorded in a hash-chained audit log.

- [Landing page](https://sidharth-singh10.github.io/Amaterasu/)
- [Interactive demo](https://sidharth-singh10.github.io/Amaterasu/demo/?demo=1)
- [SDK guide](docs/sdk.md)
- [Protocol specification](spec/protocol.md)
- [Build plan](TENON.md)
- [Conformance fixtures](spec/conformance/)
- [MCP server](packages/canvas-mcp/README.md)

Install the protocol and a chart adapter:

```sh
npm install @tenon-protocol/core @tenon-protocol/chart zod
```

```ts
import { DocStore } from "@tenon-protocol/chart"

const store = new DocStore({ checkAnchor: () => ({ ok: true, warnings: [] }) })
store.beginTurn()
store.applyOp({
  op: "draw",
  kind: "hline",
  points: [{ t: 1_700_000_000, p: 2400 }],
})
store.commitTurn()
store.undo()
```

The MCP server exposes a running journal to Claude Desktop, OpenCode, and other MCP clients:

```sh
npx -y @tenon-protocol/mcp
```

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

## Tenon protocol (v0.1)

Amaterasu is the first reference app for **Tenon**: a typed, reversible, attributable
protocol for humans and agents editing the same visual workspace. Ops carry an actor, a turn, a
capability, and an idempotency key; the server owns revisions, the op log, and the audit chain;
the client adapter owns projection and anchor resolution.

- [`spec/protocol.md`](spec/protocol.md) — normative contract (v0.1)
- [`spec/schemas/`](spec/schemas/) — JSON Schemas generated from `packages/canvas-core`
- [`spec/conformance/`](spec/conformance/) — six language-agnostic fixtures
- [`docs/extraction-audit.md`](docs/extraction-audit.md) — what moves, stays, and dies

The six fixtures pass against two targets: the TypeScript `MemoryTarget` in
`packages/canvas-conformance` and the Rust journal harness in `server/tests/conformance.rs`.
A second product adapter also exists: Weave's canvas applies `graph.*` envelopes, computes
node/edge inverses, and acks the journal (`weave/frontend/src/lib/tenon.ts`).

Phase 1a–1c are wired, and Phase 2 is largely in place: the Rust service journals every agent
chart op before dispatch, verifies an ed25519 `tn1.…` capability token on writes, records the
browser's inverse ops, and exposes document metadata, snapshots, op history, audit, and
forward-only undo endpoints. Human edits are recorded after local application with their own
inverse and snapshot, so the same journal shows both actors. Destructive agent ops require a
one-shot human approval, surfaced in the Journal tab. On reload the shell restores the workspace
snapshot, falling back to the journal snapshot or a replay of applied ops. The browser still owns
projection and anchor resolution.

### Human edits

Manual chart edits and manual Weave graph edits use the same protocol path:

1. The adapter applies the edit locally and computes the before/after inverse.
2. It posts an envelope plus result, inverse, and snapshot to
   `POST /api/docs/{doc_id}/records` with a `cap_human` token.
3. The server assigns the op id and revision, stores the audit entry with
   `actor.kind = "human"`, and refreshes the Journal.

One gesture is one turn; multi-object deletes are one turn with several records. View changes,
position-only drags, and agent ops are not double-recorded. Local snapshot undo remains local in
v1; use the Journal's forward-only undo for turns that are in the journal.

| Endpoint | Purpose |
|---|---|
| `GET /api/docs/{doc_id}` | Revision, pending count, and audit verification |
| `GET /api/docs/{doc_id}/ops` | Recent journaled ops with envelopes and acks |
| `GET /api/docs/{doc_id}/snapshot` | Latest adapter snapshot persisted with an applied ack |
| `POST /api/capabilities` | Mint/register signed claims (loopback only) |
| `GET /api/capabilities/key` | Issuer public key |
| `GET /api/capabilities/{cap_id}/token` | Local signed token for a registered capability |
| `GET /api/docs/{doc_id}/audit` | Append-only audit entries + chain verification |
| `POST /api/docs/{doc_id}/ops` | Journal a batch, dispatch to the browser, wait for acks |
| `POST /api/docs/{doc_id}/acks` | Finalize dispatched ops with adapter results/inverses |
| `POST /api/docs/{doc_id}/records` | Journal human edits the adapter has already applied |
| `POST /api/docs/{doc_id}/turns/{turn_id}/undo` | Replay a turn's inverses as a new turn |
| `POST /api/docs/{doc_id}/approvals/{approval_id}` | Apply a rejected destructive op once, with human approval |
| `POST /api/chart/op` | Pre-application submit from the chart plugin (journal + capability + browser ack) |

## Repository layout

| Path | Contents |
|---|---|
| `web/` | SvelteKit 2 + Svelte 5 client — overlay engine, components, chart shell |
| `packages/canvas-chart/` | Chart adapter: zod op/state schemas, `DocStore` reducer, inverse computation |
| `packages/canvas-core/` | Tenon protocol: envelope, ack, capability, audit, turn schemas |
| `packages/canvas-graph/` | Second adapter: graph nodes/edges, merge, inverses |
| `weave/` (separate repo) | Weave frontend bridge: `graph.*` envelopes over SSE |
| `packages/canvas-mcp/` | MCP server: `doc_get`, `op_apply`, `turn_undo`, `state_query` |
| `packages/canvas-conformance/` | Conformance fixtures runner and reference target |
| `examples/` | SDK quickstarts that use the published packages |
| `spec/` | Protocol specification, generated JSON Schemas, conformance cases |
| `site/` | Tenon landing page and static demo composition |
| `launch/` | Launch essay and post drafts |
| `docs/` | SDK guide, release guide, extraction audit, launch status |
| `server/` | Rust (axum) service — MCP client + OAuth, cache, OpenCode bridge, SSE, SQLite, static hosting |
| `opencode/` | The agent's project — chart-bridge plugin, agent config, permissions |
| `deploy/` | nginx vhost, systemd units, env template, deployment runbook |
| `TENON.md` | Tenon protocol and product build plan |
| `PLAN.md` | Amaterasu app design of record |

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

## MCP server

`packages/canvas-mcp` exposes the protocol over stdio for MCP clients. Registry name:
`io.github.Sidharth-Singh10/tenon`.

| Tool | Purpose |
|---|---|
| `doc_get` | Revision, pending count, audit status, and latest adapter snapshot |
| `op_apply` | Journal and apply protocol envelopes, waiting for the browser ack |
| `turn_undo` | Replay a turn's inverses as a new audited turn |
| `state_query` | Recent ops plus audit-chain verification |

Run the published package:

```sh
TENON_URL=http://127.0.0.1:8787 npx -y @tenon-protocol/mcp
```

Or run the checkout directly:

```sh
TENON_URL=http://127.0.0.1:8787 node packages/canvas-mcp/src/main.ts
```

Claude Desktop / MCP client config:

```json
{
  "mcpServers": {
    "tenon": {
      "command": "npx",
      "args": ["-y", "@tenon-protocol/mcp"],
      "env": { "TENON_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

`doc_id` is the chart id (`sessionStorage["amaterasu.chartId"]`). Envelopes are the full
protocol envelopes from `spec/protocol.md`; domain shorthand is an adapter concern.

## Commands

| Command | Purpose |
|---|---|
| `npm run test --workspace @amaterasu/web` | Web unit tests (Vitest) |
| `npm run check --workspace @amaterasu/web` | `svelte-kit sync` + `svelte-check` |
| `npm run verify:e2e --workspace @amaterasu/web` | Browser E2E checks (dev server running) |
| `npm run test:packages` | Protocol package tests (core + chart + graph + MCP + conformance) |
| `npm run typecheck:packages` | Typecheck all protocol packages |
| `npm run build:packages` | Build ESM + declarations into each package's `dist/` |
| `npm run verify:dist` | Pack and install all five packages into a clean temp project |
| `npm run schemas` | Regenerate `spec/schemas/` from the zod definitions |
| `npm run verify` | Web typecheck + tests + package typecheck + package tests |
| `npm run build:site` | Compose the landing page and demo into `_site/` |
| `npm run preview:site` | Serve `_site/` on `http://127.0.0.1:4173` |
| `npm run build --workspace @amaterasu/web` | Static SPA build into `web/build` |
| `cargo test --manifest-path server/Cargo.toml` | Rust unit, HTTP integration, conformance, and p95 latency tests |
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
| `AMATERASU_JOURNAL_DB` | Op journal SQLite file (default `$AMATERASU_DATA_DIR/journal.db`) |
| `AMATERASU_URL` | Base URL the chart plugin uses for pre-application submits (default `http://127.0.0.1:8787`) |
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

- [`TENON.md`](TENON.md) — the protocol and product build plan
- [`PLAN.md`](PLAN.md) — the Amaterasu app design of record
- [`docs/sdk.md`](docs/sdk.md) — install, adapter model, capabilities, audit, MCP
- [`docs/releasing.md`](docs/releasing.md) — npm, MCP registry, tags, and Pages releases
- [`docs/launch-status.md`](docs/launch-status.md) — launch criteria and verification evidence
- [`docs/extraction-audit.md`](docs/extraction-audit.md) — what moved out of Amaterasu
- [`spec/protocol.md`](spec/protocol.md) — normative protocol v0.1
- [`launch/`](launch/) — launch essay and post drafts

## Contributing

Issues and pull requests are welcome. Before opening a PR:

1. Run `npm run check --workspace @amaterasu/web` and `npm run test --workspace @amaterasu/web`.
2. Run `cargo test --manifest-path server/Cargo.toml` for the service.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

## License

[MIT](LICENSE)
