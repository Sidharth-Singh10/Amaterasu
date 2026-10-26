# Tenon implementation report

> **Historical naming note:** this report predates the rename. Its `canvas-*` package labels
> and directory paths refer to what are now the `@tenon-protocol/*` packages.

**Date:** 2026-10-24  
**Primary source of intent:** `TENON.md`  
**Secondary sources:** `spec/protocol.md`, `docs/extraction-audit.md`, `PLAN.md`, README files, git history  
**Repositories:** `Sidharth-Singh10/Amaterasu` (master `0e1471d`), `Sidharth-Singh10/weave` (master `4e13326`)  
**State:** both working trees clean and pushed to `origin/master`

---

## 1. Executive summary

Tenon has moved from a concept document to a working protocol, runtime, and two reference
adapters.

The strongest parts are:

- a versioned protocol spec with generated JSON Schemas and six language-agnostic fixtures;
- an append-only SQLite journal with revisions, idempotency, turns, typed rejections, and a
  blake3 audit chain;
- signed ed25519 capability tokens, scoped claims, and one-shot human approval for destructive ops;
- a reusable chart adapter (`@tenon-protocol/chart`), a graph adapter (`@tenon-protocol/graph`), and a stdio MCP
  server (`@tenon-protocol/mcp`);
- two adapters in products: Amaterasu's chart and Weave's knowledge graph;
- human and agent edits recorded in the same journal;
- two conformance targets passing all six fixtures;
- a verified 60-second intro video and 40-second 1.5× cut.

The main gaps against `TENON.md` are:

- no wire-level HTTP/SSE conformance target (the Rust harness drives the journal directly);
- no generic “define 3 object types and 5 ops” SDK surface; the two domains are still code-defined;
- hosted capability issuance, rotation, and revocation are not implemented;
- local snapshot undo is not journaled;
- Weave note-ingestion deltas are not journaled;
- the 90-second demo, five external testers, open-source launch, and hosted alpha are not done.

---

## 2. Phase alignment

| Phase in `TENON.md` | Status | What exists | Gap / deviation |
|---|---|---|---|
| **Phase 0 — Extraction audit and spec v0** | **Done** | `spec/protocol.md` v0.1, `docs/extraction-audit.md`, JSON Schemas, six fixtures, conformance runner, CI, npm workspace | Licensing and a separate `tenon/` monorepo were not decided; work stayed in Amaterasu |
| **Phase 1 — canvas-core and chart adapter** | **Substantially done** | Protocol schemas in `@tenon-protocol/core`; reducer/schemas/anchors/undo in `@tenon-protocol/chart`; Rust server with SQLite, snapshots, HTTP/SSE; Amaterasu wired; 141 JS + 70 Rust tests; journal p95 ~0.5 ms | No WebSocket; no domain reducer in `@tenon-protocol/core`; draw→reload→restore was not re-verified live in a connected INDmoney session; p95 measured on the journal, not the full browser round trip |
| **Phase 2 — Agent bridge and policy** | **Mostly done** | `@tenon-protocol/mcp` tools; ed25519 capability tokens; approval mode; audit + Journal UI; structured suggestions; 10-shape/undo integration test; replay helper; human record path | Wire-level conformance target missing; 10-shape demo is an integration test with a fake browser, not a live OpenCode run; audit replay is not the default reload path |
| **Phase 3 — Reference demo and second adapter** | **Partial** | `@tenon-protocol/graph`; Weave SSE bridge; merge; live Weave agent create/undo/approval; 60-second intro and 40-second 1.5× cut | No 90-second demo; 0 of 5 external testers; Weave human-edit path has typecheck/build coverage but no completed browser click-through; graph clustering/explanation are existing Weave projections, not journaled ops |
| **Phase 4 — Open-source launch** | **Not started** | Spec, packages, conformance suite, docs, intro video exist in repositories | No landing page, MCP registry listing, launch posts, essay, or external adapter |
| **Phase 5 — Hosted alpha** | **Not started** | None | No multi-tenant Postgres, auth, share links, metering, audit export, design partners, or billing |

The roadmap’s Phase 1 exit is the weakest claim: the machinery exists, but “draw → reload →
restore verified live” and “p95 op ack < 50 ms” are not both demonstrated end to end. The journal
benchmark is ~0.5 ms, which is encouraging, but not the same measurement.

---

## 3. MVP scope check

### In scope

| Requirement | Result | Evidence / note |
|---|---|---|
| One document type: chart | **Done, plus graph** | Chart adapter and Amaterasu; graph adapter and Weave |
| `shape.create/update/delete`, `series.add/remove`, `view.set`, `state.get` | **Done with chart names** | Chart DSL: `draw/update/remove/clear/set_view/add_series/remove_series`; `state.get` is the `get_state` tool / `doc_get`, not a journaled op |
| Anchors survive interval changes and reject out of range | **Existing, partial evidence** | Existing anchoring tests and resolver; conformance fixture 01 tests a 2D point model, not a real interval switch |
| Ack protocol; per-turn undo/redo; idempotency | **Done** | Applied/rejected acks; forward-only undo; redo is undo of undo; applied-key replay and conflict rejection |
| Capability: read + apply for one agent; human approval for destructive ops | **Done** | `cap_local`, `cap_human`, `cap_undo`, `cap_graph`; ed25519 `tn1` tokens; one-shot approvals |
| Audit log + history UI | **Done** | Hash chain, verification, Amaterasu Journal tab, Weave panel |
| MCP tools; live demo in OpenCode and Claude | **Partial** | `@tenon-protocol/mcp` exposes four tools; OpenCode chart plugin live-verified earlier; Claude config documented but not live-tested |
| SQLite persistence; single user; local server | **Done** | SQLite journal and workspace store; local Rust service |
| Amaterasu UI: agent panel, approval prompt, history drawer | **Done** | Chat panel, Journal tab with approve/undo |

### Out of scope

No multiplayer/CRDT, hosted multi-tenant Postgres, design/map/BI adapters, team roles/SSO/billing,
per-object policies beyond document/type, or mobile work was added. The scope stayed within the
documented non-goals.

---

## 4. Definition-of-done audit

`TENON.md` asks whether a developer can:

1. **Add `@tenon-protocol/core` to an app.**  
   **Partial.** `@tenon-protocol/core` exists in the npm workspace and Amaterasu consumes the
   chart package, but nothing is published to a registry. The server and clients share the
   workspace, not an external SDK install.

2. **Define 3 object types and 5 ops.**  
   **Not done as a generic SDK.** The chart and graph schemas are closed, code-defined domains.
   There is no public “register an object type and op set” API; consumers would edit the packages.

3. **Expose them as MCP tools.**  
   **Partial.** `@tenon-protocol/mcp` exposes `doc_get`, `op_apply`, `turn_undo`, `state_query`, but the
   tools are fixed, not generated from a consumer’s object/op definitions. `op_apply` does accept
   full protocol envelopes.

4. **Watch an agent draw in under a day.**  
   **No external evidence.** The integration exists and works in the reference app, but no
   external builder has completed the onboarding task.

**Every op acked, undoable, auditable, scoped:** mostly. Agent ops and committed human edits are
journaled and acked. View ops are intentionally non-undoable, local snapshot undo is not
journaled, and Weave note-ingestion deltas are not journaled.

**Two adapters pass the same conformance suite:** yes for the two protocol targets
(`MemoryTarget` and the Rust journal harness), not yet for the two product adapters (Amaterasu
chart and Weave graph).

---

## 5. Architecture and stack alignment

| `TENON.md` decision | Implemented | Notes |
|---|---|---|
| `@tenon-protocol/core` (TS): schema, reducer, anchors, undo, presence | **Partial** | `@tenon-protocol/core` has protocol schema/capability/audit; reducer, anchors, and inverse logic live in `@tenon-protocol/chart`; no presence |
| `tenon-server` (Rust): axum/tokio, SQLite, WebSocket + HTTP | **Partial** | Rust/axum/tokio and SQLite exist; transport is HTTP + SSE, not WebSocket |
| `@tenon-protocol/mcp` | **Done** | stdio MCP server with four tools |
| `canvas-policy` (Rust): capabilities, approvals, audit | **Merged** | Implemented in `server/src/capability.rs` and the journal; no separate crate |
| `canvas-react` / `canvas-svelte` bindings | **Not built** | Amaterasu uses its Svelte app directly; Weave uses React |
| SQLite → Postgres | **SQLite only** | No hosted store |
| TypeScript + zod | **Done** | `@tenon-protocol/core`, `@tenon-protocol/chart`, `@tenon-protocol/graph`, conformance |
| lightweight-charts v5 | **Done** | Amaterasu chart engine |
| React Flow | **Done** | Weave graph |
| MCP TS SDK | **Done** | `@modelcontextprotocol/sdk` 1.32.1 |
| Ed25519 capability tokens | **Done locally** | Persisted issuer key; no hosted issuer, rotation, or revocation |
| blake3 audit chain | **Done** | Canonical JSON; genesis; first-break reporting |
| pnpm workspaces + Cargo workspace | **Partial** | npm workspaces and a standalone `server/` Cargo package; not pnpm, not a multi-crate Cargo workspace |
| Separate `tenon/` repo | **Deferred** | Protocol and adapters live in Amaterasu; Weave remains a separate repo |

Repository layout differs from §10: there is no `crates/` or `apps/` tree. The actual layout is
`spec/`, `packages/`, `server/`, `web/`, plus the separate Weave repo.

---

## 6. What was built

### 6.1 Protocol and schemas

- `spec/protocol.md` v0.1: envelope, ack, turns/revisions, forward-only undo, idempotency,
  capabilities, approval, anchors, audit chain, transport, rejection codes, conformance, and
  documented deviations.
- `spec/schemas/`: generated JSON Schemas for envelope, batch, ack, turn, capability, and audit
  entry, plus a manifest. A schema-drift check is part of CI.
- `spec/conformance/cases/`: six fixtures covering anchor survival, undo/redo, idempotent retry,
  capability denial, malformed ops, and audit tampering.
- `packages/canvas-core`: zod protocol schemas, rejection codes, wildcard scopes, canonical JSON,
  audit-chain hashing/verification; 18 tests.
- `packages/canvas-conformance`: target interface, fixture loader/runner, `MemoryTarget` reference
  implementation; 8 tests.

### 6.2 Server and journal

`server/src/journal.rs` provides:

- SQLite tables: `doc_meta`, `doc_ops`, `doc_turns`, `doc_audit`, `doc_snapshots`.
- Server-assigned `op_id` and `seq`, per-document revision, applied-key idempotency.
- Rejected attempts are audited but not idempotency-cached.
- Same-key/different-payload attempts are journaled as `idempotency_conflict`.
- Malformed envelopes return a typed `invalid_op` ack without an audit row.
- `expected_revision` optimistic-concurrency rejection (`revision_conflict`).
- Reverse-ordered undo planning, `undoes`/`undone_by`, and journaled undo rejections.
- `blake3` hash chain with genesis and first-break verification.
- Adapter-supplied snapshots persisted with revisions.
- `record_batch` for already-applied human edits, plus `begin_batch`/`complete` for dispatched ops.

`server/src/capability.rs` provides:

- Scoped `CapabilityClaims` and `ApprovalPolicy`.
- `cap_local` (chart agent), `cap_human`, `cap_undo`, `cap_graph` (Weave agent).
- Ed25519 `tn1.<claims>.<signature>` tokens with a persisted `0600` key.
- One-shot approvals with 5-minute TTL, bound to capability, document, op type, and idempotency key.
- Typed denials: unknown, expired, actor/session mismatch, document/type out of scope, no apply,
  `approval_required`, `approval_invalid`.
- Local token minting endpoints are restricted to a loopback bind.

`server/src/api.rs` exposes:

- `GET /api/docs/{id}`, `/ops`, `/snapshot`, `/audit`.
- `POST /api/docs/{id}/ops`, `/acks`, `/records`.
- `POST /api/docs/{id}/turns/{turn}/undo`.
- `POST /api/docs/{id}/approvals/{approval_id}`.
- `POST /api/capabilities`, `GET /api/capabilities/key`,
  `GET /api/capabilities/{cap_id}/token`.
- `POST /api/chart/op` for the chart plugin’s pre-application submit.

`server/src/bridge.rs` journals agent chart ops before dispatch, annotates the browser event with
doc/op/turn/seq, finalizes on the ack, and delivers intake rejections to the plugin. The plugin
uses `POST /api/chart/op` first and keeps the legacy RPC path as a fallback for missing endpoints
or unreachable servers.

### 6.3 Chart adapter

`packages/canvas-chart` (`@tenon-protocol/chart`) contains:

- The chart DSL schemas, including an explicit optional id on `draw` so replay and inverse restore
  preserve annotation identity.
- `DocStore`: single write path, undo/redo snapshots, validated ops, anchor checks, style merge.
- `inverseOf`: adapter-supplied shape/series inverses used by the server for undo.
- `replayApplied`: reconstructs a document from applied journal envelopes, skipping rejects and
  hydrating draw ids from acks.
- Structured anchor suggestions for self-correction.
- 32 tests.

Amaterasu’s `ChartController`:

- tags human vs agent ops;
- groups one gesture into one turn;
- shares a turn across multi-select delete and OpConsole batches;
- emits before/after snapshots for successful human edits;
- skips view ops and agent ops from human journaling.

`web/src/lib/ops/human-journal.ts` queues human edits, computes inverses, posts to `/records` with
`cap_human`, retries with stable idempotency keys, and refreshes the Journal. Three tests cover
recording, filtering, and retry.

### 6.4 Weave graph adapter

`packages/canvas-graph`:

- Graph node/edge schemas, `GraphStore`, merge, and dependency-ordered inverses.
- 7 tests.

Weave (`frontend/src/lib`):

- `tenon.ts`: SSE bridge, graph op application, protocol inverses, acks, snapshots.
- `graph-record.ts`: records manual graph edits with `cap_human`, one turn per action, aggregate
  patch for multi-object changes.
- `store.ts`: human node/edge/rename actions capture before/after snapshots; position-only drags
  and view changes are excluded.
- `TenonPanel.tsx`: Journal view with audit status, approvals, undo, and full document id.
- `app/tenon/[...path]/route.ts`: streaming same-origin proxy for HTTP and SSE.
- `scripts/tenon-smoke.mjs`: live node-creation check.

### 6.5 MCP

`packages/canvas-mcp` (`@tenon-protocol/mcp`):

- `doc_get`: metadata, audit verification, latest snapshot.
- `op_apply`: validates envelopes with `@tenon-protocol/core` and posts them to the journal.
- `turn_undo`: forward-only undo.
- `state_query`: metadata, ops, audit.
- stdio transport; token fetching/caching; 4 tests.
- A live stdio smoke test against the Rust server listed all four tools and returned document/state
  data.

### 6.6 Journal and history UI

- Amaterasu **Journal** tab: groups ops by turn, shows actor, applied/rejected status, revision,
  audit verification, approve/apply for `approval_required`, and undo.
- Weave **Tenon** panel: same core history, approval, and undo actions for graph documents.
- Approver identity is recorded in the audit entry (`approved_by`).

### 6.7 Video

The separate `~/projects/deepseek-video` project contains:

- `out/tenon-intro-1080p.mp4` — 60 s, 1920×1080, 30 fps, silent.
- `out/tenon-intro-1080p-1.5x.mp4` — 40 s, 1.5× cut, silent.
- `public/videos/` copies and a poster used by the video project README.
- `storyboards/tenon-intro.md` — brief, scene table, claims, and verification.
- Composition `TenonIntro`; the full render and 1.5× cut both passed `scripts/verify.sh`.

This is an intro, not the 90-second demo requested in Phase 3.

---

## 7. Verification and evidence

### Automated tests

| Suite | Count | Result |
|---|---:|---|
| Web (Svelte/Vitest) | 72 | Pass |
| `@tenon-protocol/core` | 18 | Pass |
| `@tenon-protocol/chart` | 32 | Pass |
| `@tenon-protocol/graph` | 7 | Pass |
| `@tenon-protocol/mcp` | 4 | Pass |
| `@tenon-protocol/conformance` | 8 | Pass |
| **JS total** | **141** | **Pass** |
| Rust unit | 56 | Pass |
| Rust conformance harness | 1 | Pass (all six fixtures) |
| Rust HTTP integration | 12 | Pass |
| Rust latency | 1 | Pass |
| **Rust total** | **70** | **Pass**; 1 live OAuth test ignored |

Other checks:

- `npm run verify` — pass.
- `npm run check --workspace @amaterasu/web` — 0 errors, 0 warnings.
- `cargo fmt --check` — clean.
- `cargo clippy --all-targets -D warnings` — clean.
- schema generation / drift — clean.
- OpenCode plugin `tsc --noEmit` — clean.
- Weave `tsc --noEmit` and ESLint — pass; `next build` passed before the final human-edit
  slice, but was not re-run after it.

### Performance

`server/tests/latency.rs` measures the journal begin/complete path with snapshot persistence:

```text
journal p95 ack: 504 µs over 200 ops
```

This is below the 50 ms target, but it is a journal benchmark, not a full browser/network/SSE
round trip.

### Live checks

- MCP stdio server: tools listed; `doc_get` and `state_query` returned real data.
- Weave agent flow: node creation, server turn display, undo, destructive delete approval, audit
  revision, and verified audit chain were exercised in a browser.
- Weave human-edit path: implemented and typechecked, but the browser click-through was
  interrupted; no completed live evidence.
- Chart human-edit path: covered by unit/API tests; no completed live INDmoney chart session.
- Video: still/range inspection and `verify.sh` PASS.

---

## 8. Deviations from `TENON.md`

These are deliberate and documented in `spec/protocol.md` §15 and §17.

1. **Server authority is split.** The server owns ids, revisions, log, idempotency, capabilities,
   and audit; the client adapter owns projection, anchors, and inverse computation.
2. **Undo is a new turn, not a snapshot revert.** The log is append-only; a second undo is an undo
   of the undo.
3. **Object ids are client-generated.** The server rejects duplicates rather than assigning object
   ids; it assigns op ids and sequence numbers.
4. **One repository, hard package boundaries.** The protocol and adapters live in Amaterasu; the
   separate `tenon/` monorepo is deferred to open-source launch.
5. **Anchor resolution is client-side.** The server does not reject on anchor grounds; adapters
   return `anchor_out_of_range`.
6. **Approval can be applied by the UI.** The server endpoint replays the stored rejected envelope
   instead of requiring another model turn.
7. **Transport is HTTP + SSE.** `TENON.md` says WebSocket; the implementation uses SSE.
8. **`@tenon-protocol/core` is not the whole runtime.** The reducer and inverses live in `@tenon-protocol/chart`;
   `@tenon-protocol/core` is the protocol layer.
9. **Capabilities are locally issued.** Ed25519 tokens exist, but there is no hosted issuer,
   public-key distribution, rotation, or revocation.
10. **MCP tools are fixed, not generated from consumer schemas.** The tool surface works, but the
    “define your own types/ops” path is not built.

---

## 9. Remaining gaps and risks

### Protocol and runtime

- **Wire-level HTTP/SSE conformance target** is the largest protocol gap. The Rust harness drives
  the journal directly; the HTTP endpoints and SSE have separate integration tests but no shared
  fixture run.
- **Generic adapter SDK** is missing. A developer cannot define 3 object types and 5 ops without
  editing the packages.
- **Hosted capability issuance** and key rotation/revocation are missing. Token verification is
  local; reads are not token-gated.
- **Replay-on-reload is a fallback**, not the primary path. The workspace snapshot remains
  authoritative.
- **Local snapshot undo is not journaled**, so local and Journal undo can diverge.
- **Weave note-ingestion deltas** are not journaled or attributed.
- **Product adapters are not conformance targets.** The shared suite passes `MemoryTarget` and the
  Rust harness, not Amaterasu chart and Weave graph.

### Product and launch

- No 90-second demo; the 60-second intro and 40-second cut are promotional assets, not the planned
  demo.
- 0 of 5 external testers.
- No open-source launch package: license, published SDK, landing page, live demo, MCP registry
  listing, launch posts, or essay.
- No hosted alpha: multi-tenant Postgres, auth, share links, metering, audit export, approval
  policies, design partners, or billing.

### Risks

- **Adapter trust:** a record/ack is the adapter’s assertion that it applied the op. The server
  cannot verify domain application without a domain reducer.
- **Races:** human local application and in-flight agent dispatch can interleave; server revisions
  stay authoritative but the final snapshot depends on ack order.
- **Snapshot storage:** full chart/graph snapshots per record can grow; no pruning or compression
  policy yet.
- **Weave duplication:** `@tenon-protocol/graph` and Weave’s adapter mirror the same domain logic instead of
  importing one package across repos. They can drift.
- **Approval/undo UX:** Amaterasu and Weave have panels, but there is no unified approval inbox or
  cross-adapter history.

---

## 10. Mapping to §19 “Immediate next actions”

| §19 action | Status | Note |
|---|---|---|
| 1. Freeze the op envelope spec to one page | **Partial** | `spec/protocol.md` v0.1 is written and stable, but longer than one page |
| 2. Inventory and extract chart DSL / overlay reducer | **Done** | `@tenon-protocol/chart`; audit document; tests moved |
| 3. Write and record the 90-second demo | **Not done** | 60-second intro and 40-second 1.5× cut exist instead |
| 4. Interview 5 visual SaaS builders | **Not done** | No tester sessions recorded |
| 5. Decide repo name, license, separation | **Partial** | “Tenon” name in use; license and repo separation undecided |
| 6. Create monorepo skeleton and CI | **Partial** | CI and npm workspaces exist; no separate `tenon/` monorepo or pnpm/Cargo workspace |

---

## 11. Bottom line

Tenon is beyond a prototype: the protocol, journal, audit chain, capability gate,
approval flow, MCP surface, chart adapter, graph adapter, and both product integrations are real
and tested. The implementation does not yet satisfy the full `TENON.md` definition of done
because the generic SDK path, wire-level conformance, live 90-second demo, five tester sessions,
open-source launch, and hosted alpha are not complete.

The next engineering task should be the **wire-level HTTP/SSE conformance target**. The next
go-to-market task should be the **five tester sessions**.
