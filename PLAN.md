# Amaterasu — Implementation Plan

**Version:** v0.0.4
**Date:** 2026-09-17
**Status:** Approved for implementation
**Build status:** Phase 3 complete (2026-09-17) — `fib` + `channel` shapes (handle-editable), computed series
(`chart_add_series`/`remove_series`, autoscaled, upsert by id, caps), per-turn undo covering shapes *and* series.
Live-verified: fib from swing low → high, channel along 40 bars, SMA(20) plotted — the plotted value matched the
independently computed and reported SMA (₹1289.05). Live testing caught a tool-schema cap (`points` ≤ 2) that had
been silently forcing channel-by-trendlines workarounds. 80 web tests, svelte-check clean, 14/14 demo E2E,
28 Rust tests. Firecrawl: agent permission + prompt done; the MCP block belongs in the VPS config (local dev has
none) with the verification step in the deploy runbook.
Phase 2 complete — `opencode/` project + Rust bridge verified end to end (agent draws on the live chart,
source-stamped ops, per-turn undo). Phase 1 complete — Rust data service + live-data shell; live-verified 248
daily RELIANCE bars, live quote, 302 ms uncached intraday fetch.
**Supersedes:** v0.0.3 — frontend migrated from Next.js to SvelteKit. v0.0.2 — backend switched from Node route
handlers to a Rust (axum) service. v0.0.1 — overlay engine raised to a first-class component after review of the
Graphite planning artifact (`/home/levi/Graphite/chart-app-plan.md`).

TradingView-style chart webapp for Indian stocks sourced from the INDmoney MCP, with an embedded OpenCode agent
that draws and writes over the charts via a structured, screenshot-free overlay protocol. Self-hosted on the VPS
(`paradis`), served through nginx with a custom domain.

---

## Revision history

**v0.0.4** (this document) — frontend framework revision: Next.js replaced by **SvelteKit 2 + Svelte 5** with
`adapter-static` (SPA mode, `ssr = false`), served by the Rust service from `web/build`. Rationale: every Next
feature except the component shell was unused (no SSR/SEO/routing/image optimization needed) while its dev-loop
costs were real. The overlay engine, DSL, tests, and E2E harness carried over unchanged; only the ~255-line shell
was rewritten (React → runes), and the engine moved under `src/lib/`.

**v0.0.3** — stack revision.
- Backend replaced by a Rust (axum + tokio) service in `server/`: MCP client (`rmcp`), OAuth token store, cache,
  OpenCode bridge, SSE fan-out, SQLite, and hosting for the built frontend. Node route handlers from v0.0.2 are
  dropped; the Next.js app becomes a static-export client (dev server still used during development).
- Overlay engine, DSL, phases, and acceptance criteria are unchanged and remain the build order.

**v0.0.2** — overlay engine revision. Key deltas from v0.0.1:

1. **Anchor resolver policy** resolves the contradiction between "every `t` must exist in the loaded series" and
   interval-switch survival under the 250-candle window (see §6.3).
2. **Snap determinism split**: agent ops snap in data space (viewport-independent); human input keeps pixel
   tolerance (§6.3.7).
3. **Ack-based agent op protocol** (plugin awaits the browser-applied result within the turn) replaces
   fire-and-forget events; the agent receives ids + normalized coordinates and can self-correct (§6.4).
4. **Verified LWC 5.2 APIs**: `priceScale().setVisibleRange()` / `setAutoScale()` exist → `chart_set_view` gains a
   `priceAuto` reset verb; `timeScale().timeToIndex(t, findNearest)` exists → replaces the hand-rolled index search.
5. **Per-pane `Transform`** and pane-relative canvas positioning (prevents the axis-offset drawing bug).
6. **Culling extents for unbounded shapes** (ray/channel/hzone) named explicitly.
7. **Caps, XSS-safe DOM labels, op-log sequencing, and v1 `chartId` routing** added to the engine spec.
8. **Timestamp canonicalization at ingest** (daily-bars-at-05:30 quirk) made part of the resolver contract.
9. **Testing**: disjoint-window / disjoint-interval anchoring test added to Phase 0 acceptance; RecordingPainter
   uses pixel tolerances at DPR 1 and 2.
10. **Agent tools collapsed to the op-family** (`chart_draw`/`update`/`remove`/`clear`/`get_state`/`set_view`/
    `add_series`) — one DSL shared by mouse, agent, and persistence.

**v0.0.1** — initial plan: topology (all-on-VPS + nginx + domain), INDmoney MCP OAuth, dedicated OpenCode server,
overlay protocol sketch, phases, risks.

---

## 1. Objective

- Indian stock charts (candles + volume) sourced from the INDmoney MCP.
- Refreshable latest data (live last candle, manual + automatic refresh).
- Embedded agent for insights using all server tools (INDmoney MCP, self-hosted Firecrawl, websearch/webfetch).
- The agent draws and writes on charts via **overlays**, using one JSON op protocol shared with the human user.
- **No screenshots**: the agent reads chart state as structured data only — OHLC arrays, visible x range, visible
  y range, existing annotations, indicator parameters.

## 2. Decisions locked

| Decision | Choice |
|---|---|
| Hosting | All on the VPS (`paradis`); nginx + TLS + custom domain; no Vercel |
| Frontend | SvelteKit 2 + Svelte 5 (runes) + Tailwind 4, `adapter-static` SPA; `lightweight-charts` v5 |
| Backend | Rust (axum, tokio) in `server/`: REST + SSE, MCP client (`rmcp`), OpenCode bridge, SQLite, static hosting |
| Firecrawl | Self-hosted at `http://127.0.0.1:3002`, no key (stdio MCP with `FIRECRAWL_API_URL`) |
| OpenCode | Existing install; dedicated `opencode serve` instance for the webapp |
| Overlay engine | Data-space anchors + resolver policy; four coordinate spaces; per-turn snapshot undo |
| Agent draw protocol | Ack-based op requests over plugin RPC; agent receives normalized results |
| v1 scope | Single chart, stocks + indices; agent chat + agent drawing; core shape set |

Stack decision (v0.0.4, resolved): frontend = SvelteKit 2 + Svelte 5 (`adapter-static` SPA); backend = Rust
(axum). The overlay engine spec in §6 is framework-free and unchanged by this decision.

## 3. Verified environment facts

| Fact | Detail | Implication |
|---|---|---|
| OpenCode | v2.0.6, plugin/tool/RPC APIs available | Full agent embedding capability |
| `opencode serve` auth | HTTP Basic `opencode:<password>`; pinned via `OPENCODE_SERVER_PASSWORD` (verified 200/401) | Dedicated server, stable credentials, localhost-only |
| Dedicated server DB | Shares `~/.local/share/opencode/opencode.db` | INDmoney MCP auth + provider logins carry over |
| INDmoney MCP | OAuth only (401 without token); metadata: DCR `register`, PKCE S256, refresh tokens, scopes `market:read` + `portfolio:read` | Webapp needs its own OAuth flow; **not** URL + API key |
| No HTTP route invokes MCP tools | `/api/mcp`, `/api/rpc/{rpcID}/{method}`, `/api/event` exist; no tool-call endpoint | Chart data from the webapp's own MCP client |
| Plugin RPC | `Rpc.define` + `ctx.rpc.register`; `POST /api/rpc/{rpcID}/{method}`; events via `/api/event`, **live-only** | Hydrate-then-subscribe; ack protocol for ops |
| OHLC limits | ≤250 candles/call; `1y` max lookback; no pagination | Interval-appropriate windows; resolver must tolerate window shifts |
| Timestamp quirk | Daily bars `"… 05:30:00"` (UTC midnight as IST) vs intraday true IST (`09:15`…`15:30`) | Canonical normalization at ingest (§6.2) |
| LWC 5.2 `IPriceScaleApi` | `setVisibleRange`, `getVisibleRange`, `setAutoScale`, `applyOptions` | `chart_set_view` price range is directly settable; needs `priceAuto` reset |
| LWC 5.2 `ITimeScaleApi` | `timeToIndex(time, findNearest?)`, `logicalToCoordinate` (null only when no data), `timeToCoordinate` (null only when time absent from data; off-screen in-data times still map), `coordinateToTime` (null in whitespace) | Resolver fast paths; projections via logical space |
| Node | v26.8.1: native TS strip + built-in `node:sqlite` | Frontend tooling only (no server routes) |
| Rust | cargo/rustc 1.98.1 (2026-08-05) installed | Backend service in `server/` |
| Firecrawl MCP | `npx firecrawl-mcp` + `FIRECRAWL_API_URL` verified for self-hosted | stdio form, no key |
| VPS | 16 cores / 15 GB / 102 GB free, CachyOS; nginx not installed; ports 80/443 free | Install nginx + certbot |

## 4. Architecture

```
Internet ── HTTPS ── nginx (:443, TLS + basic auth) ── Rust service (:8787, axum)
                         │                                  ├─ REST: candles · search · quote · SSE: chat + chart events
                         └─ (localhost only, never proxied)  ├─ INDmoney MCP client (rmcp) + OAuth token store
                                                             ├─ OpenCode client (Basic, :4096) + RPC bridge
                                                             ├─ SQLite: workspaces, annotations, chats, op log
                                                             └─ serves the built SvelteKit frontend

Browser (SvelteKit client)
  ├─ lightweight-charts v5 (candles, volume, panes)
  ├─ overlay stack: annotations canvas · ephemeral canvas · labels (DOM) · hit surface
  ├─ ops reducer + undo transactions + op log
  └─ chat panel (streaming, tool cards)

opencode serve :4096 (127.0.0.1, pinned OPENCODE_SERVER_PASSWORD)
  project: /home/levi/amaterasu/opencode/
  ├─ chart-bridge plugin   → `chart` RPC + `chart_*` tools (ack protocol)
  ├─ indmoney MCP          → already connected via shared DB ✓
  └─ firecrawl MCP         → npx firecrawl-mcp, FIRECRAWL_API_URL=http://127.0.0.1:3002
```

Three decoupled channels: **data** (webapp → INDmoney MCP directly), **agent** (webapp → OpenCode HTTP API),
**drawing** (plugin ↔ webapp via plugin RPC). Chart refresh never depends on the agent.

## 5. Repository layout

```
/home/levi/amaterasu/
├─ web/                             # SvelteKit 2 + Svelte 5 + Tailwind 4 (adapter-static SPA)
│  └─ src/
│     ├─ routes/                    # +page.svelte · +layout(.svelte/.ts) — SPA, ssr = false
│     ├─ lib/
│     │  ├─ chart/                  # Transform (pane-aware) + ChartController
│     │  ├─ overlays/               # registry, layers, painter, hit-test, renderers
│     │  ├─ ops/ · data/ · testing/
│     │  └─ components/             # ChartShell.svelte · OpConsole.svelte (chat in Phase 2)
│     └─ app.css · app.html
├─ server/                          # Rust (axum): MCP + OAuth · cache · OpenCode bridge · SSE · SQLite · static hosting
├─ packages/chart-dsl/              # zod op + state schemas (shared browser ↔ plugin)
├─ opencode/                        # the agent's project (clean of app code)
│  ├─ opencode.jsonc                # plugins · firecrawl MCP · chart-analyst agent · permissions
│  └─ .opencode/plugins/chart-bridge/   # RPC contract + tools + instructions
├─ deploy/{nginx,systemd}/
└─ .env
```

`packages/chart-dsl` is the keystone: one zod definition of op/state types, consumed by the browser reducer and
the plugin (via `z.toJSONSchema`) to generate tool input schemas. Agent commands and renderer cannot drift.

## 6. Component specifications

### 6.1 Data layer (webapp's own INDmoney connection)

- Rust service: MCP client via `rmcp` (streamable HTTP) + OAuth 2.1 client (DCR, PKCE S256, refresh) with a
  file-backed token store (0600). One-time "Connect INDmoney" consent → callback on the app domain → code
  exchange → automatic refresh. Scopes: `market:read` (+ `portfolio:read` later).
- App-facing tools: `lookup_ind_keys` (search), `get_indian_stocks_ohlc` (candles), `get_indian_stocks_details`
  (quote); later `user_watchlist`, `get_indian_stocks_movers`.
- Cache: 5–15 s TTL intraday, 60 s daily; single-flight per key; exponential backoff on 429; adaptive polling
  (5 s focused/intraday, 30–60 s daily, paused when hidden).
- Windows respect the 250-candle cap and the 1-year lookback ceiling; coarser interval instead of paging.

### 6.2 Candle normalization (feeds the resolver)

- **Canonical timestamp policy, applied at ingest, identical across intervals:**
  - intraday → epoch seconds of the bar open in exchange time (IST);
  - daily/weekly/monthly → date-keyed anchor at session-open convention (not the raw `05:30:00` rendering);
  - `{(symbol, adjustment)}` identifies an annotation set; `adjustment` stored per annotation.
- Normalization happens once in the adapter module; the rest of the app only ever sees canonical epochs and dates.
- Never interpolate daily gaps as linear time; bar-index space is the interpolation domain.

### 6.3 Overlay engine

#### 6.3.1 Four coordinate spaces

| Space | Unit | Owner | Used for |
|---|---|---|---|
| Data | `(t, p)` canonical epoch + price | annotation store | persistence, agent ops, undo |
| Logical | fractional bar index (2.5 = halfway between bars) | `timeScale()` | projections into whitespace/future |
| CSS pixel | pane-relative, origin = pane top-left | our canvases | all drawing and hit-testing |
| Physical pixel | CSS px × devicePixelRatio | browser | crispness only, never exits the Painter |

Data space is the only representation that survives pan, zoom, refresh, interval changes, and reloads — and it is
what keeps the agent screenshot-free. Logical space is required because projections past the last bar have no
timestamp to map.

#### 6.3.2 Transform (one module, per pane)

```ts
interface Transform {
  readonly paneIndex: number;
  readonly cssWidth: number; readonly cssHeight: number; readonly dpr: number;

  xOfTime(t: number): number | null;            // timeToCoordinate: null only when t absent from data
  xOfLogical(li: number): number | null;        // logicalToCoordinate: null only when no data
  yOfPrice(p: number): number | null;           // series.priceToCoordinate — pane-relative

  timeOfX(x: number): number | null;            // null in whitespace
  logicalOfX(x: number): number | null;
  priceOfY(y: number): number;

  visibleTimeRange(): { from: number; to: number } | null;
  visibleLogicalRange(): { from: number; to: number } | null;
  visiblePriceRange(): { min: number; max: number };   // priceOfY(height) .. priceOfY(0)

  indexOfTime(t: number, nearest?: boolean): number | null;   // timeToIndex(t, findNearest)
  resolve(a: Anchor): ResolvedAnchor;           // THE only projection path for anchors
  pixelOf(a: Anchor): { x: number; y: number } | null;
  anchorOf(x: number, y: number): Anchor;
}
Transform.forPane(paneIndex: number): Transform;
```

- Only this module touches LWC scale APIs. Everything else consumes `Transform` or nothing.
- The canvas element for pane *i* is positioned/clipped to that pane's rect — **not** the chart stack — otherwise
  every shape is offset by the axis widths and drawn over axes. Resolve the pane offset source early (verify
  pane DOM measurement vs `paneSize()`); call it out in Phase 0 acceptance.
- Invalidation subscriptions: `subscribeVisibleLogicalRangeChange`, crosshair move, `ResizeObserver`, pane layout
  changes, DPR change — all funnel into `invalidate()`.

#### 6.3.3 Anchor model and resolver policy

```ts
interface Anchor {
  t: number;          // canonical epoch of a real bar — primary identity
  p: number;          // price
  liOffset?: number;  // fractional bar offset from that bar (whitespace / projection)
}
```

Resolution tiers (applied on render, validation, and agent op intake):

```
resolve(anchor) →
  1. indexOfTime(t) exists            → exact: li = index (+ liOffset)
  2. firstBar ≤ t ≤ lastBar           → nearest bar via indexOfTime(t, true) + residual as liOffset
                                        exact:false → warn("snapped to nearest bar")
  3. t > lastBar                      → lastBar + liOffset from nominal bar duration; exact:false → warn
  4. t < firstBar or outside loaded window → not rendered; listed as `unresolved` in state;
                                        agent ops rejected with structured error
```

Consequences baked into the design:

- Annotations **survive interval switches and window shifts** by resolution, not by migration: tier 2 keeps daily
  annotations meaningful on intraday charts and vice versa once §6.2 normalization is in place.
- Agent validation is soft inside the window (normalize + warn) and hard outside it (reject) — the
  "every t must exist" rule from v0.0.1 was unenforceable under the 250-candle cap.
- `unresolved` annotations are surfaceable in the UI (rail marker + "expand window" hint) and to the agent via
  `chart_get_state`.

#### 6.3.4 Layers and DOM

```html
<div class="chart-stack">              <!-- position: relative -->
  <div class="chart-host"></div>       <!-- LWC canvases, axes, panes -->
  <canvas class="annotations"></canvas> <!-- pane-clipped, pointer-events:none, persisted drawings -->
  <canvas class="ephemeral"></canvas>   <!-- pane-clipped, pointer-events:none, snap/hover/marquee/pulse -->
  <div class="labels"></div>            <!-- pointer-events:auto, label pills/tooltips/handles -->
  <div class="hit-surface"></div>       <!-- pointer-events:auto, all pointer input -->
</div>
```

Two canvases keep the expensive persisted layer out of the pointer-rate path. DOM owns everything text-editable
or interactive. Overlays never participate in layout or autoscaling; the chart learns about them only through
`chart_set_view` ops. Labels are **textContent only** (agent-authored strings) with a style whitelist
(hex/rgb colors, font allowlist) — the DOM layer is the one place untrusted content leaves the canvas sandbox.

#### 6.3.5 Renderer registry and frame loop

```ts
interface Renderer<A extends Annotation = Annotation> {
  kind: A["kind"];
  draw(a: A, t: Transform, painter: Painter, env: FrameEnv): void;
  hitTest?(a: A, t: Transform, pt: Point, tol: number): number | null;  // px distance, null = miss
  handles?(a: A, t: Transform): Handle[];
  moveHandle?(a: A, handleId: string, delta: Delta, t: Transform): A;
  bounds?(a: A): DataBounds;    // data-space bbox; unbounded kinds must declare extents
  validate?(a: A): string[];
}
```

Immediate-mode redraw with one rAF coalescer and per-layer dirty flags. Redraw triggers: visible logical range,
op/undo, selection/drag (annotations); crosshair, snap candidate, marquee (ephemeral); resize, DPR,
`visibilitychange` (both); live-bar append only when relevant values changed. One bad annotation never kills the
frame (per-shape try/catch + error report). Deterministic draw order: `z`, then `createdAt`.

**Culling extents (explicit per kind):** bounded shapes use their data-space bbox; `ray` clips against the visible
logical range; `channel` uses both rails; `hzone` is price-only; `vzone` is time-only. Without declared extents,
panned rays and zones vanish — this is the classic overlay bug.

#### 6.3.6 Painter

Canvas2D kit in CSS-pixel space with `begin()/end()` DPR transform: `snap()`, `snapCenter()`, line, dashedLine,
polygon, rect, ellipse, arrow, markerIcon, measureBadge, queued `text` (batched `textPass()`), and `labelPill`
which delegates to the DOM layer. Rules: pixel snapping only for axis-aligned 1 px strokes (snapping diagonals
independently bends them); dash arrays and gradients cached by style key (no per-call allocation); canvas text
only for throwaway geometry, never for editable labels.

#### 6.3.7 Snap engine (two tolerance modes)

Candidates: per-visible-bar OHLC points, swing pivots (fractal k=3), round levels, visible annotation
anchors/midpoints, fib levels. Precedence within 1 px: `ohlc/swing > anchor > fib > round`; beyond that, pure
distance. Constraints (`h`, `v`, angle, along-ray, ratio) share a `project(point)→point` contract.

| Mode | Tolerance | Rationale |
|---|---|---|
| Human pointer input | 6 px screen, zoom-independent | perceptual cursor targeting |
| **Agent ops** | data space: price within `min(0.1% of price, 0.25×ATR)`; time = exact bar or nearest | deterministic: same op ⇒ same result at any zoom; stable tests |

Agent `snap` is opt-in per op: `"none"` (default) | `"ohlc"` | `"swing"` | `"level"`. "Draw 1250 support" must not
become a swing at 1248.6. Snap badge in the ephemeral layer states `[target] from [source]`; `snappedTo[]` is
returned to the agent so it can see and correct what moved.

#### 6.3.8 Hit-testing, selection, drag editing

Pointer-down priority: selection handles (10 px) → nearest annotation by `hitTest` distance (6 px) → active tool
(marquee / pan / new shape). Line-like kinds use point-to-segment distance with endpoint weighting ×0.7;
zone-like kinds hit inside with priority boost, else nearest edge; labels/markers use a 12 px radius; fib is one
annotation hit by its nearest level. Drag previews live in the `Interaction` state machine and never write to the
store per pointermove: **one gesture = exactly one op = exactly one undo step**; `Shift` constrains, `Alt` clones,
`Esc` cancels. Multi-select drags commit as one transaction. Context menu: Delete, Lock, Hide, Bring to front,
Ask agent about this, Show source message.

#### 6.3.9 Op DSL, transactions, undo, op log

```ts
type Op =
  | { op: "draw"; kind: Kind; points: Anchor[]; style?: Style; label?: string; z?: number;
      snap?: "none" | "ohlc" | "swing" | "level"; source?: Source }
  | { op: "update"; id: string; points?: Anchor[]; style?: Partial<Style>; label?: string;
      hidden?: boolean; locked?: boolean }
  | { op: "remove"; id: string }
  | { op: "clear"; ids?: string[]; kind?: Kind; sourceMessageID?: string }
  | { op: "set_view"; from?: number; to?: number; bars?: number;
      priceMin?: number; priceMax?: number; priceAuto?: boolean }
  | { op: "add_series"; id: string; name: string; paneId?: string;
      data: { t: number; v: number }[]; style: LineStyle }
  | { op: "remove_series"; id: string };

OpResult = { ok: boolean; id?: string; normalizedPoints?: Anchor[]; snappedTo?: string[];
             clamped?: boolean; visible?: boolean; unresolved?: string[]; warnings?: string[] };
```

- Single write path for mouse, agent, and imports. Validation: zod (from `packages/chart-dsl`) → resolver intake
  (§6.3.3) → data-space snap (§6.3.7) → clamp → apply in transaction → return `OpResult`.
- Undo is snapshot-based (document is a few KB): `beginTurn(sourceMessageID?)` pushes one snapshot,
  `applyOp` runs N ops, `commitTurn()` clears redo, `abortTurn()` restores. **An entire agent turn is one undo
  step**; tool cards bind to `sourceMessageID` for "Undo this reply".
- **Op log**: applied ops are appended with a monotonic sequence number and persisted (browser → server ack).
  Reload and second tabs replay deterministically; server stores the log alongside the annotation snapshot and
  wins on conflict. This closes the ordering gap between the RPC op channel and the WS data channel.

#### 6.3.10 Live data reconciliation

| Event | Effect |
|---|---|
| New bar appended | `(t, p)` annotations unchanged; liOffset projections stable; resolver re-runs |
| Running bar replaced | No shape change; `pinned` markers update |
| Interval switched | Resolver tiers 2–3; canonical normalization (§6.2) makes same-day anchors match |
| Symbol switched | Load that `(symbol, adjustment)` annotation set |
| History refetch overlaps | Keep annotations; never silently re-snap stored `snappedTo` values |
| Adjustment mismatch | Annotations record their adjustment; UI warns on mismatch (v1 out of scope for handling) |
| Annotation unresolvable | Listed in state + rail affordance; not deleted |

#### 6.3.11 Caps and safety

Max 500 annotations per workspace, 64 points per polyline/pitchfork, 256-char labels, ops-per-turn rate limit;
`chart_clear`/`chart_remove`/`chart_remove_series` are approval-gated; draw/update auto-allowed. Style fields
whitelisted; label text never interpolated into HTML.

#### 6.3.12 Testing without screenshots

1. Transform round-trips (`resolve → pixel → anchor`) within 0.5 px at several zooms, including whitespace and
   liOffset cases.
2. `RecordingPainter` geometry snapshots with numeric tolerance (0.01–0.05 px) at DPR 1 and 2.
3. Hit-test property tests: points along a shape must hit; 20 px away must miss.
4. Snap tests: synthetic bars with known swings → assert candidate kind and position; agent-mode determinism
   across zoom levels.
5. Op fuzz: invalid ops rejected with structured errors, never throw in the frame loop.
6. **Disjoint-window / disjoint-interval anchoring test (headline):** draw on window W₁ at interval A, reload
   with shifted window W₂ at interval B (disjoint bar set), assert resolution tier, pixel placement, and warning
   behavior.

#### 6.3.13 Performance budget

500 visible annotations × ~10 canvas ops ≈ 5k ops/frame — comfortable at 60 fps. Culling is O(n) over cached
data-space bboxes (invalidated on update) with the unbounded extents of §6.3.5. Text measurement and dash
allocation are the two real hazards and are handled in the Painter. Escape hatch: OffscreenCanvas in a worker —
a `layers.ts` swap, not a rewrite. Agent-computed indicator lines use LWC primitives **only** because they should
autoscale; primitives repaint only via `requestUpdate()`.

### 6.4 Agent bridge (ack-based)

- Plugin registers RPC `chart`:
  - Methods (browser → plugin): `attach({chartId})`, `detach({chartId})`, `opAck({requestId, result})`.
  - Events (plugin → browser): `op.request {requestId, chartId, op}`.
- Tool execution flow:

```ts
const chart = attached.mostRecent(locationKey(ctx));           // v1: single active chart per location
if (!chart) throw new ToolError("No chart open. Ask the user to open a chart first.");
const requestId = crypto.randomUUID();
const pending = defer<OpResult>();  pendingOps.set(requestId, pending);
await rpc.events.emit("op.request", { requestId, chartId: chart.id, op });
try { return await pending.promise; }        // 10 s timeout → typed ToolError
finally { pendingOps.delete(requestId); }
```

- The browser applies the op through the same reducer as user input (one undo transaction per turn) and returns
  the `OpResult` — ids, normalized points, `snappedTo`, `visible`, `unresolved`, warnings. The agent self-corrects
  within the same turn instead of guessing.
- `chartId` routing is a **v1 requirement**, not a later phase: `attached` keyed by `chartId`; if multiple tabs
  are attached, the most recently active wins and the tool states which chart it targeted; ambiguity is never
  silent.
- **Verification item (Phase 2, before traceability work):** confirm the V2 plugin tool execution context exposes
  `sessionID`/`messageID`. If it does not, derive source ids from the session hook or a request-scoped counter;
  the traceability and undo-per-turn UX depends on this.
- Context sync: the debounced viewport preamble travels with the next prompt by default
  (`"User is viewing RELIANCE 1d, range …"`). `session.synthetic` pushes are optional, debounced ≈500 ms, idle-only,
  deduped — never on every pan.
- Op result ordering: browser serializes ops by arrival per chart; the op log (§6.3.9) carries the ordering.
- **V2 Code Mode caveat (verified live):** plugin and MCP tools are reached through Code Mode's catalog
  (`tools.chart.*`, `tools.indmoney.*`); the agent must have the `execute` action allowed, and nested calls still
  enforce their own permission actions. The plugin/RPC/round-trip design is unchanged — only the agent's calling
  convention (JavaScript in `execute`) and its permission list reflect this.
- **Session model:** primary sessions ignore an agent's `model` field; the bridge pins the model when creating a
  session (`OPENCODE_MODEL`, provider/model form).

### 6.5 Agent tools

| Tool | Purpose |
|---|---|
| `chart_get_state` | Columnar snapshot: symbol, indKey, interval, most recent ≤250 bars (`t,o,h,l,c,v`), visible `{from,to,priceMin,priceMax,logicalRange}`, annotations (with ids/source), series, `unresolved`, provenance `{source, fetchedAt, isLive}` |
| `chart_draw` | Batch of draw ops; returns ids + normalized coordinates + `snappedTo` |
| `chart_update` | Patch points/style/label/hidden/locked by id |
| `chart_remove` | Remove by id (approval) |
| `chart_clear` | Clear by ids/kind/sourceMessageID (approval) |
| `chart_set_view` | `from/to/bars/priceMin/priceMax/priceAuto` — pans, zooms, pins or restores price autoscale |
| `chart_add_series` / `chart_remove_series` | Agent-computed indicator lines (autoscaled; LWC primitives) |

Agent instructions (in the plugin): read `chart_get_state` first; coordinates in `{t,p}` only, ISO dates accepted
and converted bridge-side (never make the model do epoch math); `snap:"none"` unless structure-aware placement is
wanted; ≤8 shapes per analysis; labels in ₹ with instrument tick precision; never mention pixels or screenshots;
fetch history beyond the loaded window with the indmoney tools; prefer one batched `chart_draw` per idea.

### 6.6 Chat panel

One session per browser tab (persisted in localStorage); the Rust service subscribes to OpenCode `/api/event`
and re-streams to the browser via SSE; assistant text deltas + tool activity cards; interrupt; model picker from
`/api/model`; canned prompts ("Analyze this setup", "Mark S/R", "Where's the invalidation?"). Tool cards highlight their shapes on hover, offer "Undo this
reply" (`sourceMessageID`), and "Ask agent about this" on a shape sends a synthetic prompt referencing the
annotation id.

## 7. Phases and acceptance criteria

| # | Phase | Deliverable | Done when |
|---|---|---|---|
| 0 | Scaffold + **overlay engine core** | SvelteKit app, LWC chart on mock data, pane-aware `Transform`, Painter, registry, two-canvas stack, 6 renderers (trendline, ray, hline, vline, rect, label), hit-test + drag, reducer + transactions, resolver, dev op console | Ops pasted into the console render correctly; pan/zoom/interval switch keep shapes on bars/prices per resolver tiers; hit/drag/one-step undo work; round-trip + RecordingPainter tests pass; **disjoint-window/interval test passes**; pane offset verified against axes |
| 1 | Data layer | Rust service: MCP client + OAuth + token store; `/api/candles`, `/api/search`, `/api/quote`; normalization (§6.2); cache/backoff; watchlist rail; workspaces + recents in SQLite | Real RELIANCE 1d loads <2 s; refresh updates live candle without flicker; daily/intraday quirk handled; reload restores symbol/interval/view exactly |
| 2 | Bridge + chat | Dedicated `opencode serve` (systemd) + `opencode/` project; Rust bridge (RPC calls + event fan-out + SSE); chart-bridge plugin (RPC + tools + instructions); ack protocol; chat panel (streaming, tool cards); undo-per-turn; traceability | "Mark the March low, draw 1250 support, summarize the trend" → correct drawings, streamed answer; two agent turns undo independently; `source` ids verified or fallback implemented; chartId routing tolerates a second tab |
| 3 | Shapes + snap UI + series + firecrawl | Full shape set (fib, channel, pitchfork, ellipse, arrow, polyline, measure), handle editing, snap badges/UI, `chart_add_series` indicators, firecrawl MCP wired to :3002, permissions polish | Fib/channel edited via handles and patched via `chart_update`; agent-computed SMA matches its own numbers; "Latest RELIANCE news?" uses firecrawl and cites sources |
| 4 | Deploy hardening + perf | nginx TLS + basic auth, systemd user units + linger, SSE tuning (`proxy_buffering off`, long read timeout), certbot renewal, culling perf, op-log replay, end-to-end checklist | Reboot → everything returns; OpenCode unreachable externally; 500 annotations at 60 fps; reload from op log is deterministic |

**Later**: multi-chart grid with per-chart contexts, RSI/MACD panes with pane-level annotations, sharing/export,
Postgres option, CRDT-style concurrent editing if ever multi-user.

## 8. Operational details

- systemd **user** units (`amaterasu-web.service`, `opencode-charts.service`) + `loginctl enable-linger`; `sudo`
  only for nginx/certbot/htpasswd.
- nginx: TLS (certbot), basic auth, HSTS, `proxy_buffering off` + long read timeout on SSE routes; OpenCode :4096
  bound to 127.0.0.1 and never proxied; Firecrawl :3002 localhost-only; app :8787 localhost.
- Secrets in `.env` + unit `Environment=`; firecrawl needs no key.
- Backups: SQLite (workspaces, annotations, op log, chats) + INDmoney token store.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Anchors drift from loaded windows (250-cap, interval switch) | Resolver policy §6.3.3 + canonical normalization §6.2 + disjoint-window test |
| Agent snapping mutates intent nondeterministically | Data-space tolerance, `snap:"none"` default, `snappedTo[]` feedback |
| Canvas offset/axis overlap with LWC panes | Pane-relative canvas positioning; Phase 0 acceptance check |
| Price-range pin disables autoscale permanently | `priceAuto: true` reset verb in `chart_set_view` |
| Event stream live-only / browser closed | Ack protocol with typed failure; hydrate-then-subscribe; op log replay |
| Source ids unavailable in tool context | Phase 2 verification item with fallback design |
| Untrusted agent text in DOM labels | textContent-only + style whitelist |
| Agent tool spam | Caps §6.3.11 + approval-gated destructive ops + undo-per-turn |
| INDmoney OAuth friction | SDK `auth()` DCR/PKCE/refresh; hand-rolled fallback (endpoints verified) |
| MCP rate limits with two consumers (app + agent) | Cache, single-flight, adaptive polling, backoff |
| nginx buffering breaks SSE | `proxy_buffering off` + explicit Phase 4 check |

## 10. Open items

1. **Domain name** for the nginx server block + TLS.
2. **Basic auth confirmation** and htpasswd user (Phase 0).
3. **Stack divergence — resolved (v0.0.4)**: frontend = SvelteKit 2 + Svelte 5; backend = Rust (axum).
4. Verify self-hosted Firecrawl health at `127.0.0.1:3002` (rootful podman not inspectable at planning time).
5. Verify LWC pane offset source (pane DOM measurement vs `paneSize()`) in Phase 0.
6. ~~Verify V2 plugin tool context exposes session/message ids~~ **Resolved (Phase 2):** the tool context
   exposes `sessionID`/`messageID`; every agent op is stamped with them and per-turn undo clears by source.
7. **INDmoney data-path consent** — one-time browser consent for the Rust service (dev callback
   `http://127.0.0.1:8787/api/indmoney/oauth/callback`; the VPS registers a second client against the domain
   callback).

## Appendix A — Overlay design provenance (v0.0.2)

**Adopted from the Graphite planning artifact:** four coordinate spaces; real-bar anchors + `liOffset`;
renderer registry with distance-based `hitTest`; two-canvas + DOM labels + hit-surface stack; immediate-mode
rAF rendering with dirty flags; Painter primitive kit with pixel-center snapping; snap precedence +
constraints + snap badge; snapshot undo with `beginTurn/commitTurn/abortTurn`; `RecordingPainter` tests;
columnar `chart_get_state`; op-family tool vocabulary; the mechanism→decision audit style.

**Modified during review:** anchor resolver policy (tiers replace hard existence check); agent snapping moved to
data space; ack-based op protocol replaces fire-and-forget; autoscale reset verb; per-pane Transform and canvas
positioning; culling extents for unbounded kinds; caps/XSS/op-log/routing added.

**Verified against LWC 5.2 docs (this revision):** `IPriceScaleApi.setVisibleRange/getVisibleRange/setAutoScale`;
`ITimeScaleApi.timeToIndex(t, findNearest)`, `logicalToCoordinate`, `timeToCoordinate`, `coordinateToTime`
null semantics.
