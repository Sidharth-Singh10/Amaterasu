# Tenon — Full Build Plan

**Name:** Tenon (formerly Common Ground)
**Status:** v0.1 implemented; hosted alpha pending
**Date:** 2026-10-20
**Owner:** Sidharth Singh
**Seed projects:** Amaterasu, Weave, OxiDock, PerOXO
**Target:** 12 weeks from start to hosted alpha

> **Naming note:** the protocol is Tenon. Published packages use the `@tenon-protocol/*`
> scope; source directories keep the original `packages/canvas-*` names.

---

## 1. Executive summary

Tenon is an open protocol and runtime that lets humans and AI agents edit the same
visual workspace safely. Instead of agents taking screenshots and clicking pixels, they send
typed, semantic operations against a shared object model. Every operation is acknowledged,
attributable, reversible, permission-scoped, and recorded.

The first product is **Amaterasu**: an AI chart analyst for Indian markets that draws directly
on the chart. The platform is extracted from it:

- `@tenon-protocol/core` — protocol, document state, anchors, reducer, undo
- `@tenon-protocol/mcp` — agent bridge exposed as MCP tools and MCP Apps UI
- `tenon-policy` — capabilities, approvals, audit (planned)
- adapters — chart (Amaterasu), knowledge graph (Weave), and later map/design/BI

The thesis in one sentence:

> **MCP gave agents tools. Tenon gives them a shared workspace — every action typed,
> attributable, reversible, and scoped.**

---

## 2. The problem

Three failures define the current state of agent-native software.

**1. Computer use is brittle and opaque.**
Pixel-level agents guess coordinates, break on layout changes, cannot express intent, and leave
no auditable record of what they did. In precision domains — charts, CAD, GIS, medical imaging,
financial dashboards — "close enough" is wrong.

**2. MCP tools are stateless verbs.**
MCP standardizes *what an agent can do*, but not *what state it is acting on*. A tool call like
`draw_line(x1, y1, x2, y2)` has no notion of the object it creates, whether the user can undo it,
who authorized it, or how it survives a zoom or interval change.

**3. Collaboration infrastructure assumes humans.**
Liveblocks, Velt, and tldraw sync model human cursors and human edits. They have no concept of an
agent actor, capability scopes, per-turn undo, approval gates, or provenance.

The gap is the **action layer**: a shared, typed, auditable state that both a human and an agent
can mutate.

---

## 3. The insight

Your last five projects are the same project in different clothes:

| Project | Shared-state surface | Agent role |
|---|---|---|
| Amaterasu | Chart annotations, series | Draws and explains |
| Weave | Knowledge graph nodes/edges | Extracts, links, clusters |
| Portfolio | Topic network, 3D objects | Arranges, highlights |
| daisy | Planner, gym log | Updates state |
| Graphite fork | Node canvas | Plans operations |

You keep rebuilding the missing layer: **a safe, reversible, attributable way for humans and
agents to manipulate shared state**. Tenon is that layer, made explicit.

---

## 4. Why now

- **MCP Apps became the first official MCP extension in January 2026.** A2UI emerged alongside it.
  The industry is standardizing how agents *show* UI, not how they *act on stateful visual objects*.
- **Agent security is the adoption bottleneck.** A 2026 Gravitee survey cited by the Cloud Security
  Alliance found 88% of organizations reported confirmed or suspected AI agent security incidents.
  Permissions, approvals, and audit are becoming the product.
- **Agent memory commoditized.** 20+ memory MCP servers and a provenance-verified memory protocol
  paper by May 2026. Another memory layer is not the bet; memory as a *component of action* is.
- **Agents are a real user class.** 90% of professional developers used AI coding agents weekly in
  2026 (JetBrains). The user base for agent-native tooling exists.
- **Structured beats pixels where precision matters.** Screenshot agents remain slow, expensive,
  and unauditable for regulated or high-stakes surfaces.

---

## 5. Users

**Primary (developer):** teams building visual SaaS — trading terminals, BI dashboards, GIS,
design tools, CAD, planning boards, observability canvases. They want agents to operate their
product without building an agent stack.

**Secondary (end user):** traders, analysts, designers, operators who want an agent to do real work
inside the tool, with control and trust.

**Beachhead:** Indian retail traders using Amaterasu. Precision-sensitive, willing to pay, and
poorly served by chat-only assistants.

**Economic buyer:** the vertical SaaS team (per-seat or platform fee), not the individual trader,
once the SDK is proven.

---

## 6. Competitive landscape and positioning

| Category | Examples | What they do | What they miss |
|---|---|---|---|
| Agent UI | MCP Apps, A2UI | Render UI in chat | State mutation, undo, audit |
| Computer use | Browser/desktop agents | Click pixels | Precision, intent, audit |
| Human multiplayer | Liveblocks, Velt, tldraw sync | Human cursors/edits | Agent actors, capabilities |
| Vendor MCP | Figma MCP, CAD MCP | Read/write one tool | Cross-app protocol, policy |
| Agent frameworks | LangGraph, CrewAI | Orchestration | Workspace state |
| Memory | Mem0, Zep, Weave | Recall | Action, approval, undo |

**Positioning:** the action layer for agent-native workspaces. Complementary to MCP Apps, not
competitive with it. MCP Apps renders the UI; Tenon owns the state the UI manipulates.

---

## 7. What we are building

### Layer 1 — The protocol (open)

A versioned JSON protocol for shared visual state:

- **Document** — a versioned workspace (chart, graph, map, board).
- **Object** — a typed entity with a stable id and domain fields.
- **Anchor** — a domain-space reference (time/price, node id, geo coordinate) that survives
  viewport changes.
- **Op** — a typed mutation with actor, capability, idempotency key, and optional rationale.
- **Turn** — a group of ops from one actor, atomically undoable.
- **Ack** — applied or rejected, with a normalized result the agent can reason about.
- **Capability** — a scoped, expiring grant (read, propose, apply, undo, export).
- **Audit entry** — append-only, hash-chained record of who did what, when, why.
- **Memory link** — optional provenance to claims, notes, or evidence (Weave).

### Layer 2 — The runtime

- **`@tenon-protocol/core` (TypeScript)** — schema, reducer, anchors, undo, presence.
- **`tenon-server` (Rust)** — axum + tokio, SQLite now / Postgres later, WebSocket + HTTP.
- **`@tenon-protocol/mcp`** — MCP server exposing document read, op apply, turn undo, state query.
- **`canvas-policy` (Rust)** — capability engine, approval modes, audit chain.
- **`canvas-react` / `canvas-svelte`** — bindings for the two ecosystems you actually use.

### Layer 3 — Reference apps

- **Amaterasu** — chart analyst; the commercial wedge and the demo.
- **Weave adapter** — graph merge/cluster/explain; proves the protocol generalizes.
- **Portfolio topic graph** — third demo with zero domain overlap; proves visual range.

---

## 8. Protocol design

### 8.1 Op envelope

```json
{
  "v": 1,
  "op_id": "01J9Z4K3T7",
  "doc_id": "reliance-1d",
  "turn_id": "turn_01J9Z4K4",
  "actor": {
    "kind": "agent",
    "id": "chart-analyst",
    "model": "provider/model",
    "session": "ses_..."
  },
  "capability": "cap_01J9Z4...",
  "type": "shape.create",
  "target": { "kind": "shape", "id": "sh_01J9Z4..." },
  "anchor_space": "data",
  "payload": {
    "shape": "trendline",
    "from": { "t": 1730000000, "p": 1284.5 },
    "to": { "t": 1730900000, "p": 1312.0 },
    "style": { "color": "accent", "width": 2 }
  },
  "rationale": "Higher low at the 20-SMA; invalidation below 1276.",
  "idempotency_key": "turn_01J9Z4K4:shape-1",
  "created_at": "2026-10-20T09:41:02Z"
}
```

### 8.2 Ack

```json
{
  "op_id": "01J9Z4K3T7",
  "status": "applied",
  "revision": 42,
  "result": {
    "shape_id": "sh_01J9Z4...",
    "normalized": {
      "from": { "t": 1730000000, "p": 1284.5 },
      "to": { "t": 1730900000, "p": 1312.0 }
    }
  }
}
```

Rejections are typed and instructive:

```json
{
  "op_id": "01J9Z4K3T7",
  "status": "rejected",
  "code": "anchor_out_of_range",
  "message": "t=1730900000 is outside the loaded window; nearest is 1730800000.",
  "retryable": true,
  "suggestion": { "t": 1730800000 }
}
```

### 8.3 Rules

1. **Agent ops are data-space.** They resolve against the document, not the viewport. Human ops may
   use pixel tolerance and snap.
2. **Every op is acked within the turn.** The agent receives ids and normalized coordinates and can
   self-correct before the turn ends.
3. **Undo is per-turn.** One agent turn or one human gesture is one undo unit. Redo is explicit.
4. **Idempotency.** Retries with the same key are safe; the server returns the original ack.
5. **Typed rejection.** No silent failure. Every rejection names a cause and a remedy.
6. **No raw HTML.** Labels are text, escaped; styling is a closed enum.
7. **Versioned schema.** Unknown op types are rejected; unknown fields are preserved for forward
   compatibility.
8. **Deterministic anchors.** The same op resolves identically after zoom, pan, resize, and
   interval switch, or is rejected with a reason.

### 8.4 Capabilities

A capability is a signed token with:

- **Scope:** document ids, object types, op types, time window.
- **Permissions:** `read`, `propose`, `apply`, `undo`, `export`.
- **Approval mode:** `auto` for low-risk ops, `human` for destructive or high-value ops.
- **Audience:** agent id and session.
- **Expiry:** short-lived (minutes to hours).

Example policy for a trading assistant:

```json
{
  "scope": { "documents": ["reliance-*"], "op_types": ["shape.*", "series.*"] },
  "permissions": ["read", "apply", "undo"],
  "approval": { "mode": "human", "op_types": ["shape.delete", "doc.clear"] },
  "expires_in": 3600
}
```

### 8.5 Audit and provenance

- Append-only log, one entry per op, hash-chained (`blake3`).
- Each entry stores actor, capability, op id, before/after revision, rationale, timestamp.
- Export as JSONL; optional Merkle root signing.
- Optional link to Weave claims: a shape can cite the evidence that justified it.
- The UI shows a human-readable history: *"Agent drew a trendline at 09:41 because…"*.

### 8.6 Conformance suite

A language-agnostic JSON test corpus:

- anchor survival across zoom/pan/interval
- undo/redo equivalence
- idempotent retry
- capability denial
- malformed op rejection
- audit chain verification

Any adapter that passes the suite is compatible. This is how the protocol becomes real.

---

## 9. Architecture

```
Agent host (Claude, OpenCode, ChatGPT, IDE)
        │  MCP (tools + optional MCP Apps UI)
        ▼
canvas-mcp  ──────────────┐
                          │ JSON ops over WS/HTTP
                          ▼
                   tenon-server (Rust)
                   ├─ document store (SQLite → Postgres)
                   ├─ op log + undo/redo
                   ├─ capability engine
                   ├─ audit chain
                   ├─ presence + sync
                   └─ adapter registry
                          ▲
                          │ WS
                   Browser client (TS)
                   ├─ canvas-core (state, reducer, anchors, undo)
                   ├─ renderer adapter (chart / graph / map / design)
                   └─ UI (approval, history, presence)
```

### 9.1 Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Server | Rust, axum, tokio | Your strength; low latency; single binary |
| Storage | SQLite → Postgres | Local-first now; hosted later |
| Client core | TypeScript + zod | Shared schemas; browser-native |
| Chart adapter | lightweight-charts v5 | Already proven in Amaterasu |
| Graph adapter | React Flow / custom canvas | Already proven in Weave |
| Agent bridge | MCP TS SDK or `rmcp` | Official protocol; host compatibility |
| Auth | Ed25519 capability tokens | Local-first, verifiable, no server dependency |
| Audit | blake3 hash chain | Fast, tamper-evident |
| Monorepo | pnpm workspaces + Cargo workspace | One version, one test run |

### 9.2 Non-goals for v1

- CRDT multiplayer (v2; start with server-authoritative ops)
- Offline conflict resolution (v2)
- Rich text / freeform drawing (v2)
- Mobile client (v3)
- Billing and SSO (hosted alpha can be manual)

---

## 10. Repository layout

```
tenon/
├─ spec/
│  ├─ protocol.md
│  ├─ schemas/                 # JSON Schema for ops, acks, capabilities
│  ├─ conformance/             # language-agnostic test corpus
│  └─ rfcs/
├─ crates/
│  ├─ tenon-core/                 # domain types, anchors, reducer, undo
│  ├─ tenon-server/               # axum service, storage, WS, snapshots
│  ├─ tenon-policy/               # capabilities, approvals, audit
│  └─ tenon-mcp/                  # optional Rust MCP server
├─ packages/
│  ├─ canvas-core/             # TS client core
│  ├─ canvas-chart/            # chart adapter
│  ├─ canvas-graph/            # graph adapter
│  ├─ canvas-react/            # React bindings
│  └─ canvas-svelte/           # Svelte bindings
├─ apps/
│  ├─ amaterasu/               # reference app (or external dependency)
│  ├─ atlas/                   # knowledge graph demo
│  └─ playground/              # adapter testbed
├─ examples/
├─ docs/
└─ deploy/
```

**Decision:** keep Amaterasu in its own repo and consume published packages. The monorepo holds
the protocol, runtime, adapters, and demos. This keeps the product repo clean and forces the SDK
to be usable from outside.

---

## 11. Relationship to existing projects

| Project | Role in Tenon | Action |
|---|---|---|
| **Amaterasu** | Reference app; commercial wedge | Extract `chart-dsl` and overlay reducer; consume `@tenon-protocol/core` |
| **Weave** | Provenance + memory component; graph adapter demo | Add `@tenon-protocol/graph`; link claims to audit entries |
| **OxiDock** | Scoped access patterns; later a remote-document adapter | Reuse capability/approval UX ideas |
| **PerOXO** | Real-time transport lessons; not a dependency | Reuse ack/actor patterns |
| **Portfolio** | Third demo (topic graph) | Add a read-only canvas adapter |
| **bgit** | Policy/guardrail philosophy | Reuse secret-scanning and rule UX if relevant |

Do not merge repos. Extract, publish, and depend.

---

## 12. MVP scope

### In

- One document type: chart.
- Ops: `shape.create`, `shape.update`, `shape.delete`, `series.add`, `series.remove`,
  `view.set`, `state.get`.
- Anchors: time/price; interval-switch survival with explicit rejection when out of range.
- Ack protocol; per-turn undo/redo; idempotency.
- Capability: read + apply for one agent; human approval for destructive ops.
- Audit log + history UI.
- MCP tools; live demo in OpenCode and Claude.
- SQLite persistence; single user; local server.
- Amaterasu UI: agent panel, approval prompt, history drawer.

### Out

- Multiplayer and CRDT.
- Hosted multi-tenant Postgres.
- Design/map/BI adapters.
- Team roles, SSO, billing.
- Fine-grained per-object policies beyond document/type.
- Mobile.

### Definition of done

A developer can:

1. Add `@tenon-protocol/core` to an app.
2. Define 3 object types and 5 ops.
3. Expose them as MCP tools.
4. Watch an agent draw in under a day.

Every agent op is acked, undoable, auditable, and scoped. Two adapters pass the same conformance
suite.

---

## 13. Roadmap

### Phase 0 — Extraction audit and spec v0 (week 1)

- Inventory Amaterasu's `packages/chart-dsl`, overlay engine, plugin RPC, op log.
- Write `spec/protocol.md`: envelope, anchors, ack, undo, capabilities, audit.
- Decide package boundaries and licensing.
- Create the monorepo and CI (fmt, clippy, typecheck, tests).

**Exit:** spec reviewed; a written list of what moves, what stays, what dies.

### Phase 1 — canvas-core and chart adapter (weeks 2–3)

- Port reducer, anchors, undo, schemas into `@tenon-protocol/core`.
- Stand up `tenon-server` with SQLite, WebSocket, snapshots.
- Wire Amaterasu to the SDK with zero behavior regression.
- Port existing tests; add conformance tests.

**Exit:** draw → reload → restore verified live; 30+ tests; p95 op ack < 50 ms locally.

### Phase 2 — Agent bridge and policy (week 4)

- `@tenon-protocol/mcp` tools: `doc_get`, `op_apply`, `turn_undo`, `state_query`.
- Capability tokens; approval mode; destructive-op gate.
- Audit log + history UI.
- Self-correction loop: reject → retry → ack.

**Exit:** agent draws 10 shapes in one turn; undo all; rejected op self-corrects; audit replay works.

### Phase 3 — Reference demo and second adapter (weeks 5–6)

- Polish Amaterasu as "the AI analyst that draws, not chats."
- Build `@tenon-protocol/graph` on Weave: merge duplicates, cluster, explain with sources.
- Write the 90-second demo script; record it.
- Recruit 5 external testers.

**Exit:** the same protocol drives chart and graph; 5 testers complete an integration task; demo is
publishable.

### Phase 4 — Open-source launch (weeks 7–8)

- Publish spec, SDK, docs, examples, conformance suite.
- Landing page with a live demo; MCP registry listing.
- Launch posts: Show HN, r/mcp, MCP Discord, Graphite community, your blog.
- Write the "why structured ops beat screenshots" essay.

**Exit:** 25+ stars, 5 developers try it, 1 external adapter, 3 inbound conversations.

### Phase 5 — Hosted alpha (weeks 9–12)

- Multi-tenant Postgres, auth, workspaces, share links.
- Usage metering, audit export, approval policies.
- Onboard 3 design partners (trading, BI, GIS/design).
- Pricing page and manual billing.

**Exit:** 3 active design partners, 1 paid pilot, weekly active workspaces > 10.

---

## 14. Success metrics and kill criteria

**North star:** successful agent turns per active workspace per week.

**Supporting metrics:**

- Time to first ack: p95 < 100 ms.
- Op rejection rate after self-correction: < 5%.
- Undo rate: monitored as a quality signal, not a failure.
- Integration time for a new adapter: < 1 day.
- Demo → signup conversion: > 10%.
- External integrations: 5 by week 8.

**Kill criteria (be honest):**

- No external integration 6 weeks after launch.
- In target domains, screenshot agents perform equally well in a head-to-head test.
- Platform vendors ship equivalent semantics and developers do not care.
- You cannot get 5 visual-SaaS builder interviews in 2 weeks.
- You cannot keep the demo under 90 seconds because the setup is too complex.

---

## 15. Go-to-market

**Beachhead:** Indian retail traders via Amaterasu. Content angle: *"The AI analyst that draws on
your chart — and shows its work."* Demo-led, not feature-led.

**Developer channel:** spec + 90-second demo + MCP registry + Show HN + MCP communities +
Graphite's community (node-canvas developers are a natural fit).

**Design partners:** 5 visual SaaS teams. Offer free integration help in exchange for feedback and
a logo. Target trading, BI, GIS, and design.

**Pricing (hosted alpha):**

- Free: local, single user, unlimited ops, community support.
- Pro: $19/mo — hosted sync, history, MCP Apps, 3 workspaces.
- Team: $149/mo — approvals, audit export, roles, 10 seats.
- Enterprise: self-hosted license + support.
- Vertical packs: trading, research, design templates.

---

## 16. Business model

Open-core. The protocol, client core, and single-user server are open source (Apache-2.0 or MIT).
Hosted governance — sync, audit retention, approvals, roles, SSO — is the paid product. This keeps
adoption friction low and monetizes the part enterprises actually need.

Do not monetize the protocol. Monetize trust, retention, and team workflow.

---

## 17. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| MCP Apps / A2UI absorb stateful ops | Medium | High | Own domain semantics (anchors, undo, provenance, policy), not transport; be complementary; open spec |
| Computer use gets good enough | Medium | High | Target precision/audit domains where pixels are unacceptable; structured ops are cheaper and faster |
| Developer adoption is slow | High | High | Wedge with Amaterasu; one-day integration; killer demo; design partners |
| Solo bandwidth | High | Medium | Narrow v1; no multiplayer; reuse existing code; timebox phases |
| Security incident | Low | High | Capability tokens, approval gates, no raw HTML, audit, least privilege |
| Trading regulation / data licensing | Medium | Medium | Position as analysis tool, not advice; disclaimers; verify INDmoney terms; keep the SDK domain-neutral |
| Spec fragmentation | Medium | Medium | One reference implementation first; conformance suite; publish only after 2 adapters pass |
| Naming/trademark conflict ("Tenon") | Medium | Medium | Search before launch; keep a fallback name |

---

## 18. Open questions

1. Is the primary buyer the app developer or the end user? The answer changes pricing and roadmap.
2. Does MCP Apps UI remove the need for a custom client, or is a first-party workspace still required?
3. Should the reference server be Rust-only, or also a TypeScript implementation for adoption?
4. How much of Weave's memory belongs in v1 versus v2?
5. What is the exact open-source boundary — protocol + client, or server too?
6. Is "Tenon" the right name? Check trademarks and domain availability.
7. Do you want to run a paid trading product, given the regulatory surface?

---

## 19. Immediate next actions (this week)

1. Freeze the op envelope spec to one page.
2. Inventory and extract Amaterasu's `chart-dsl` and overlay reducer into a package.
3. Write the 90-second demo script and record a rough version.
4. Interview 5 visual SaaS builders; ask what broke when they tried computer use.
5. Decide repo name, license, and whether Amaterasu stays separate.
6. Create the monorepo skeleton and CI.

---

## 20. What this is not

- Not another memory server. Weave is a component, not the headline.
- Not another chat wrapper. The interface is the workspace, not a transcript.
- Not a generic agent framework. Orchestration is someone else's problem.
- Not screenshot automation. Pixels are the fallback, not the protocol.
- Not a Rizumu feature. Music is a distribution asset, not this bet.
- Not a Graphite fork. Graphite is prior art and a potential adapter.

---

## 21. One-paragraph pitch

Every company is about to put an agent inside its product, and almost all of them will do it with
screenshots, chat, or brittle tool calls. Tenon is the missing action layer: a typed,
reversible, auditable protocol for humans and agents to edit the same visual state. We prove it
with Amaterasu, an AI chart analyst that draws on the chart and shows its work, then open the
protocol so any visual app can become agent-native in a day. MCP standardized what agents can do;
Tenon standardizes what they can safely change.
