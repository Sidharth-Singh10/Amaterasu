# Amaterasu

INDmoney-backed chart app with an embedded OpenCode agent that draws and writes on charts
through a data-space overlay protocol. **`PLAN.md` (v0.0.4) is the design of record.**

## Status

**Phase 0 complete** (2026-09-17) on the final stack: SvelteKit 2 + Svelte 5 (runes) +
Tailwind 4 via `adapter-static` (SPA), and a Rust (axum) service. Delivered: the overlay
engine (Transform + resolver, Painter, renderer registry, canvas layers, DOM labels), op DSL
+ reducer with snapshot undo, chart shell + dev op console, 44 unit tests, svelte-check
clean, and a 13-check browser E2E harness. The Rust service compiles and serves the built
SPA. The INDmoney data bridge lands in Phase 1.

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
npm run dev --workspace @amaterasu/web          # dev server on http://127.0.0.1:3000
npm run test --workspace @amaterasu/web         # vitest unit suite (44 tests)
npm run verify:e2e --workspace @amaterasu/web   # browser E2E checks (dev server must be running)
npm run check --workspace @amaterasu/web        # svelte-kit sync + svelte-check
npm run build --workspace @amaterasu/web        # SPA build into web/build
cargo check --manifest-path server/Cargo.toml
```

The Rust service hosts the production bundle:
`AMATERASU_STATIC_DIR=/home/levi/amaterasu/web/build cargo run --manifest-path server/Cargo.toml`
(then http://127.0.0.1:8787).

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
