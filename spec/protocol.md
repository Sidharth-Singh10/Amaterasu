# Tenon Protocol

**Version:** 0.1 (Phase 0 draft)
**Date:** 2026-10-20, renamed 2026-10-26
**Status:** Frozen for implementation against the Amaterasu chart adapter
**Protocol name:** Tenon (formerly Common Ground)

This document defines the wire contract between an agent host, the document server, and a
visual client. It is the normative reference for `@tenon-protocol/core`, `tenon-server`,
`@tenon-protocol/mcp`, and any adapter that claims conformance.

The key words MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119.

---

## 0. Scope

v0 covers one domain: a chart with data-space annotations and computed series. The protocol
itself is domain-neutral; the chart vocabulary lives in an adapter (§4.2).

Out of scope for v0: multiplayer, CRDT merge, offline conflict resolution, rich text, mobile,
hosted multi-tenancy. See `TENON.md` §9.2.

---

## 1. Authority model

Two authorities, deliberately split:

| Concern | Owner | Consequence |
|---|---|---|
| Op ids, revisions, op log, idempotency, capabilities, audit | **Server** | The server can always answer "what happened, in what order, authorized by whom" |
| Anchor resolution, projection, rendering, hit-testing | **Client adapter** | The server never guesses pixels or bar windows |
| Domain validity beyond schema (e.g. "is this price inside the loaded window") | **Client adapter** | Rejections from the adapter are first-class acks |
| Turn boundaries | **Client adapter** (from the actor's turn identity) | `turn_id` is stable across tool calls in one agent turn |

The server does **not** hold a document reducer. It holds an append-only log and, in v0, a
materialized snapshot used for fast reads. Undo is computed from inverse ops supplied by the
adapter that applied the original op (§6.4).

This is a deliberate deviation from `TENON.md` §9, which shows the server owning the
document store and undo. It is recorded in §15.

---

## 2. Terms

- **Document** — a versioned workspace identified by an opaque `doc_id`.
- **Object** — a typed entity with a stable id and domain-defined data. `chart.shape` and
  `chart.series` are object types in v0.
- **Anchor** — a domain-space reference that survives viewport changes. In the chart adapter it is
  `{ t, p, liOffset? }` (§9).
- **Op** — a typed mutation carried in an envelope (§3).
- **Turn** — a group of ops from one actor, atomically undoable.
- **Ack** — the per-op result: applied or rejected, with ids, normalized values, and a revision.
- **Revision** — a per-document monotonically increasing integer. It is the total order of
  accepted changes.
- **Capability** — a signed, scoped, expiring grant (§8).
- **Audit entry** — an append-only, hash-chained record of an op attempt (§10).

---

## 3. Envelope

Every op is wrapped. Domain coordinates never appear at the top level.

```json
{
  "v": 1,
  "op_id": "op_01J9Z4K3T7",
  "doc_id": "doc_reliance_1d",
  "turn_id": "turn_ses_9f2:msg_41",
  "seq": 1,
  "actor": {
    "kind": "agent",
    "id": "chart-analyst",
    "model": "opencode-go/deepseek-v4.1-flash",
    "session": "ses_9f2"
  },
  "capability": "cap_01J9Z4",
  "type": "chart.shape.create",
  "target": { "kind": "chart.shape" },
  "anchor_space": "chart.data",
  "payload": {
    "shape": "trendline",
    "points": [
      { "t": 1730000000, "p": 1284.5 },
      { "t": 1730900000, "p": 1312.0 }
    ],
    "style": { "color": "#f0b429", "width": 2 }
  },
  "rationale": "Higher low at the 20-SMA; invalidation below 1276.",
  "idempotency_key": "turn_ses_9f2:msg_41:1",
  "created_at": "2026-10-20T09:41:02Z"
}
```

### 3.1 Fields

| Field | Req | Set by | Meaning |
|---|---|---|---|
| `v` | yes | client | Protocol version. `1` for this document. |
| `op_id` | no | server | Assigned on accept. Clients MUST omit it; a supplied value is ignored. |
| `doc_id` | yes | client | Target document. |
| `turn_id` | yes | client | Groups one actor turn. Derived from session + message, or a request-scoped counter. |
| `seq` | yes | client | 1-based position within the turn. Unique per `(turn_id, seq)`. |
| `actor` | yes | client | `{kind: human|agent|system, id, model?, session?}`. |
| `capability` | yes | client | Capability id (§8). The signed token travels in the request header. |
| `type` | yes | client | `<domain>.<object>.<verb>`, e.g. `chart.shape.create`. |
| `target` | yes | client | `{kind, id?}`. `id` is omitted for create, required for update/delete. |
| `anchor_space` | no | client | Name of the coordinate space the payload uses. Required when the payload contains anchors. |
| `payload` | yes | client | Domain object. Strictly validated by the adapter. |
| `rationale` | no | client | Why. Written to the audit entry verbatim; max 500 chars. |
| `idempotency_key` | yes | client | Unique per document for 30 days (§7). |
| `expected_revision` | no | client | Optimistic concurrency. If present and not current, reject `revision_conflict`. |
| `approval` | no | client | One-shot approval id for operations gated by `approval.mode = human` (§8.4). |
| `created_at` | yes | client | RFC 3339 UTC. Advisory; server time is authoritative in the log. |

### 3.2 Envelope rules

1. Unknown **envelope** fields MUST be preserved and forwarded. This is the forward-compatibility
   channel.
2. Unknown **payload** fields MUST be rejected. Domain payloads are closed: enums are fixed, no
   raw HTML, no styles outside the adapter's allowlist.
3. `op_id` and `revision` are the server's. A client MUST NOT infer order from `created_at`.
4. `turn_id` MUST be stable for every op in one actor turn, including retries after rejection.
5. Every op carries exactly one object change, except ops whose verb is `set`, which are ephemeral and never
   enters undo. Batching happens at the turn level, not inside an op.
6. Text fields are plain text. They are rendered with `textContent`; no markup is interpreted.
7. Maximum envelope size is 1 MiB. Maximum payload depth is 32.

### 3.3 Batch

Ops are submitted as an ordered batch:

```json
{ "ops": [ { "v": 1, "...": "..." }, { "v": 1, "...": "..." } ] }
```

- Ops are applied **in order**.
- A rejection does not roll back earlier ops in the batch. Turns are atomic for **undo**, not for
  application. The agent needs partial success to self-correct.
- The response contains one ack per submitted op, in the same order.
- The batch MUST be serialized per document. Concurrent batches are ordered by arrival.

---

## 4. Op vocabulary

### 4.1 Shape of an op type

`<domain>.<object>.<verb>`:

| Verb | Target id | Meaning | Undoable |
|---|---|---|---|
| `create` | absent | Create an object; adapter assigns or accepts an id | yes |
| `update` | required | Patch fields on an object | yes |
| `delete` | required | Remove an object | yes |
| `upsert` | required (in payload for series) | Create-or-replace by id | yes |
| `set` | absent | Change ephemeral view state | no |

Unknown op types MUST be rejected with `unknown_op_type`, never ignored. A server MAY accept an
op type it does not understand if an adapter is registered for it and the payload schema is known;
in v0 the registry is static.

### 4.2 Chart vocabulary (v0)

| Type | Payload | Notes |
|---|---|---|
| `chart.shape.create` | `{shape, points, style?, label?, snap?}` | `shape` is a closed enum: trendline, ray, hline, vline, rect, hzone, vzone, marker, measure, fib, channel, label |
| `chart.shape.update` | `{points?, style?, label?, hidden?, locked?}` | Partial patch |
| `chart.shape.delete` | `{}` | Target id required |
| `chart.series.upsert` | `{id, name, points, style?}` | Upsert by payload id |
| `chart.series.delete` | `{}` | Target id required |
| `chart.view.set` | `{from?, to?, bars?, priceMin?, priceMax?, priceAuto?}` | Ephemeral; no audit revision bump |

`chart.shape.create` and `chart.series.upsert` are gated by `approval.mode = human` when the
capability says so (§8.4). Deletes are always gated.

---

## 5. Ack

```json
{
  "v": 1,
  "op_id": "op_01J9Z4K3T7",
  "turn_id": "turn_ses_9f2:msg_41",
  "seq": 1,
  "status": "applied",
  "revision": 42,
  "result": {
    "object_id": "sh_01J9Z4",
    "normalized": {
      "points": [
        { "t": 1730000000, "p": 1284.5 },
        { "t": 1730900000, "p": 1312.0 }
      ]
    },
    "snappedTo": [],
    "visible": true
  },
  "inverse": [
    {
      "type": "chart.shape.delete",
      "target": { "kind": "chart.shape", "id": "sh_01J9Z4" },
      "payload": {}
    }
  ]
}
```

### 5.1 Ack fields

| Field | Req | Meaning |
|---|---|---|
| `v` | yes | Must match the envelope. |
| `op_id` | yes | Server-assigned. Stable across replays. |
| `turn_id`, `seq` | yes | Echoed from the envelope. |
| `status` | yes | `applied` or `rejected`. |
| `revision` | yes | Revision after the op. Unchanged on rejection. |
| `result` | applied | Domain result: `object_id`, normalized values, warnings, `unresolved`. |
| `inverse` | applied | Domain ops (no envelope) that undo this op, in reverse application order. MAY be empty for non-undoable types. |
| `replayed` | no | `true` when served from the idempotency cache (§7). |
| `rejected_by` | rejected | `server` or `adapter`. Lets the agent know whether to fix the request or the data. |
| `code` | rejected | Stable machine code (§11). |
| `message` | rejected | Human-readable, one sentence. |
| `retryable` | rejected | Whether the same input could succeed later or after correction. |
| `suggestion` | no | Structured remedy, e.g. `{"t": 1730800000}` or `{"current_revision": 44}`. |

### 5.2 Replay

A replayed op returns the **original ack**, byte-identical except for `replayed: true`. Its
`revision` is the revision at the time of first application, not the current revision.

---

## 6. Turns, revisions, undo

### 6.1 Revision

- Starts at `0` for a new document.
- Increments by exactly `1` for each `applied` op whose verb is not `set`.
- Rejections do not increment.
- An op whose verb is `set` does not increment and is not journaled as a revision-bearing entry. It is
  still recorded in the audit log with `revision` unchanged, so view changes are attributable.

### 6.2 Turn

A turn is `(doc_id, turn_id)`. It has:

```json
{
  "turn_id": "turn_ses_9f2:msg_41",
  "doc_id": "doc_reliance_1d",
  "actor": { "kind": "agent", "id": "chart-analyst", "session": "ses_9f2" },
  "started_at": "2026-10-20T09:41:02Z",
  "ended_at": "2026-10-20T09:41:07Z",
  "op_ids": ["op_...", "op_..."],
  "undoes": null,
  "undone_by": null
}
```

`turn_id` derivation is the adapter's business, but it MUST satisfy:

- all ops from one agent message share a turn;
- two different messages never share a turn;
- a retry of a rejected op keeps the original turn id.

In Amaterasu this is `turn_{sessionID}:{messageID}`.

### 6.3 Undo is a new turn

`POST /docs/{doc_id}/turns/{turn_id}/undo`:

1. Server loads the turn's applied op log entries in `seq` order.
2. Server concatenates their `inverse` arrays, reversed.
3. Server submits them as a **new turn** with:
   - a fresh `turn_id` (`turn_undo_{ulid}`);
   - `undoes: "turn_..."` on the turn record;
   - `actor` = the human who requested the undo;
   - `rationale` = `"undo of {turn_id}"`.
4. The browser applies them like any other ops and acks.
5. The original turn is marked `undone_by: "turn_undo_..."`.

Consequences:

- The log is append-only; nothing is rewritten.
- Undo is itself auditable and reversible. Redo is an undo of the undo turn.
- A second undo of an already-undone turn is rejected with `already_undone`.
- If an inverse op is rejected, the undo turn is partially applied and the ack says so. The UI
  MUST surface that rather than claiming the turn was reverted.

### 6.4 Inverses are the adapter's responsibility

The adapter that applies an op MUST return an `inverse` in the ack. The server stores it and
replays it later; it never derives domain semantics itself.

This is what keeps the server domain-neutral while still making every op reversible.

---

## 7. Idempotency

- The key is `(doc_id, idempotency_key)`, unique for 30 days.
- A replay with the same key returns the stored ack with `replayed: true`; it MUST NOT re-apply.
- A different payload with the same key is rejected with `idempotency_conflict`.
- Rejected attempts are **not** cached. The client corrects the request and retries with the same turn
  id; only applied acks are replayed.
- Recommended derivation: `{turn_id}:{seq}`.
- The cache survives restarts; it is part of the op log, not a separate side table.

---

## 8. Capabilities

### 8.1 Token format

```text
tn1.<base64url(claims_json)>.<base64url(ed25519_signature)>
```

The signature covers `tn1.` plus the encoded claims. The token is transported in the
`X-Tenon-Capability` header. The envelope's `capability` field carries only the `cap_id`, so the
token is not duplicated into every audit entry.

### 8.2 Claims

```json
{
  "v": 1,
  "cap_id": "cap_01J9Z4",
  "iss": "tenon-local",
  "sub": { "actor_id": "chart-analyst", "session": "ses_9f2" },
  "documents": ["doc_reliance_1d"],
  "op_types": ["chart.shape.*", "chart.series.*", "chart.view.set"],
  "permissions": ["read", "apply", "undo"],
  "approval": { "mode": "human", "op_types": ["chart.shape.delete", "chart.series.delete"] },
  "issued_at": "2026-10-20T09:00:00Z",
  "expires_at": "2026-10-20T10:00:00Z"
}
```

### 8.3 Rules

- `documents` and `op_types` support a trailing `*` wildcard on one segment only.
- Permissions: `read`, `propose`, `apply`, `undo`, `export`.
  - `propose` may submit ops that are journaled but not applied (approval queue).
  - `apply` may apply directly.
  - `undo` may call the turn undo endpoint.
  - `export` may read the audit log.
- The token MUST be rejected when expired, when `sub` does not match the envelope actor, or when
  neither `apply` nor `propose` is present.
- Capabilities are minted by the local server for local use. In hosted mode the issuer is the
  workspace server; the client verifies with the issuer's public key.

### 8.4 Approval

- `approval.mode = "auto"`: ops in scope apply immediately.
- `approval.mode = "human"`: ops whose type matches `approval.op_types` are rejected with
  `approval_required` and `suggestion: {approval_id}`. The UI shows the pending op; on approval it
  returns a **one-shot** `approval_id` (bound to `doc_id`, `op_type`, `cap_id`, 5-minute TTL).
  The agent retries the same envelope with `approval: "<id>"`.
- Deletes and clears are always `human` in v0, regardless of the capability.

---

## 9. Anchors

An anchor is a domain-space reference. The chart adapter's anchor is:

```ts
{ t: number, p: number, liOffset?: number }
```

- `t` is a canonical epoch second of a real bar.
- `liOffset` is a fractional bar offset for whitespace or projection beyond the last bar.
- Anchors are the only persisted geometry. Pixels never enter the document.

Resolution is the adapter's job, applied identically on intake, render, and validation:

1. `t` is an exact bar → exact.
2. `t` inside the loaded window → nearest bar plus residual in `liOffset`; warn.
3. `t` beyond the last bar → `lastBar` plus offset from the nominal bar duration; warn.
4. `t` outside the loaded window → reject `anchor_out_of_range` with the nearest available
   timestamp in `suggestion`.

Requirements:

- The same anchor MUST resolve to the same pixel under identical viewport and data, and MUST
  resolve to the corresponding data point after zoom or pan.
- Agent ops MUST be viewport-independent: identical input produces identical normalized output at
  any zoom level.
- The server MUST NOT resolve anchors and MUST NOT reject on anchor grounds. Such rejections come
  from the adapter with `rejected_by: "adapter"`.

---

## 10. Audit

### 10.1 Entry

```json
{
  "v": 1,
  "doc_id": "doc_reliance_1d",
  "seq": 7,
  "revision": 42,
  "op_id": "op_01J9Z4K3T7",
  "turn_id": "turn_ses_9f2:msg_41",
  "status": "applied",
  "actor": { "kind": "agent", "id": "chart-analyst", "session": "ses_9f2" },
  "capability": "cap_01J9Z4",
  "type": "chart.shape.create",
  "target": { "kind": "chart.shape", "id": "sh_01J9Z4" },
  "rationale": "Higher low at the 20-SMA; invalidation below 1276.",
  "created_at": "2026-10-20T09:41:02Z",
  "prev_hash": "blake3:9f0c...",
  "hash": "blake3:4a71..."
}
```

### 10.2 Chain

- One chain per document, ordered by `seq` (1-based, gapless).
- `hash = blake3(utf8(prev_hash) || 0x0a || utf8(canonical_json(entry_without_hash)))`.
- `entry_without_hash` is the entry with `hash` **and** `prev_hash` removed; the previous hash
  contributes as the prefix, not the body.
- `prev_hash` for `seq = 1` is `blake3:` followed by 64 zeros.
- Canonical JSON: object keys sorted by codepoint, no insignificant whitespace, UTF-8, `undefined`
  omitted.
- **Rejections are journaled too**, with `status: "rejected"` and `revision` unchanged. Attempts
  are evidence.
- Verification recomputes every hash and checks linkage. Export is JSONL, one entry per line.
- Optional Merkle root signing is out of scope for v0.

---

## 11. Rejection codes

| Code | Owner | Retryable | Meaning |
|---|---|---|---|
| `invalid_op` | either | no | Envelope or payload failed schema validation (server: envelope; adapter: domain payload) |
| `unknown_op_type` | server | no | No adapter registered for `type` |
| `unknown_target` | either | no | Target id does not exist (server: document; adapter: object) |
| `duplicate_object_id` | adapter | no | Create reused an existing id |
| `revision_conflict` | server | yes | `expected_revision` did not match |
| `idempotency_conflict` | server | no | Same key, different payload |
| `capability_denied` | server | no | Scope, permission, or audience mismatch |
| `capability_expired` | server | yes | Token past `expires_at` |
| `approval_required` | server | yes | Human approval needed; retry with `approval` |
| `approval_invalid` | server | no | Approval expired, used, or bound elsewhere |
| `anchor_out_of_range` | adapter | yes | Anchor outside the loaded window |
| `object_limit` | adapter | no | Cap reached (500 shapes, 12 series) |
| `payload_too_large` | server | no | Over 1 MiB |
| `already_undone` | server | no | Turn was already undone |
| `internal` | either | yes | Unexpected failure; safe to retry once |

Rejection `message` is one sentence. `suggestion` is structured and MUST NOT contain prose that
the client is expected to parse.

---

## 12. Transport

v0: HTTP + SSE.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/docs` | POST | Create a document |
| `/api/docs/{doc_id}` | GET | Snapshot: revision, objects, unresolved |
| `/api/docs/{doc_id}/ops` | POST | Submit a batch; returns acks and blocks until the adapter acks |
| `/api/docs/{doc_id}/records` | POST | Record already-applied adapter edits (human path) |
| `/api/docs/{doc_id}/turns/{turn_id}/undo` | POST | Forward-only undo |
| `/api/docs/{doc_id}/ops?after={seq}` | GET | Read the log |
| `/api/docs/{doc_id}/audit` | GET | Audit entries (JSONL with `Accept: application/x-ndjson`) |

- The batch response returns only after the adapter acks, with a default timeout of 10 s. On
  timeout the op is journaled as `rejected` with `code: "internal"` and `retryable: true`.
- The adapter receives pending ops over SSE (`op.request`) and posts acks to
  `/api/docs/{doc_id}/acks`.
- WebSocket is a v2 concern; it MUST preserve the same envelope and ack semantics.

---

## 13. Conformance

`spec/conformance/cases/*.json` holds language-agnostic fixtures. A target passes v0 when:

1. `anchor_survival` — anchors project identically across zoom/pan and round-trip.
2. `undo_redo` — undo restores prior state as a new audited turn; redo is an undo of the undo.
3. `idempotent_retry` — same key returns the original ack exactly once applied.
4. `capability_denial` — out-of-scope ops are rejected and the document is unchanged.
5. `malformed_op` — bad envelope, unknown type, and bad payload are rejected with the right codes.
6. `audit_chain` — chain verifies; tampering is detected at the right index.

The runner lives in `packages/canvas-conformance`. A target implements `ConformanceTarget`; the
same fixtures MUST be runnable by a Rust harness without changing the JSON.

---

## 14. Versioning

- `v` is the protocol version. v1 clients MUST reject unknown major versions.
- Adding envelope fields is a minor change; receivers preserve them.
- Adding op types is a minor change; unknown types are rejected until an adapter registers them.
- Changing payload semantics for an existing op type is a major change.
- The audit entry shape is append-only; fields may be added, never repurposed.

---

## 15. Deviations from `TENON.md`

Recorded deliberately so the design of record and the implementation do not drift.

1. **Server authority is split.** §9 shows `tenon-server` owning the document store, op log, and undo.
   v0: the server owns ids, revisions, the log, idempotency, capabilities, and audit; the client
   adapter owns projection, anchor resolution, and inverse computation. Undo replays adapter-supplied
   inverses (§6.4).
2. **Undo is a new turn, not a snapshot revert.** §8.3 rule 3 says undo is per-turn; it does not say
   the log is rewritten. v0 makes the log strictly append-only (§6.3).
3. **Object ids are client-generated.** §8.1 shows the server assigning `sh_...`. v0 accepts
   client ULIDs so a batch needs one round trip and local mode works; the server rejects duplicates.
4. **One repository, hard package boundaries.** §10 calls for a separate monorepo consuming
   published packages. Deferred to open-source launch; the packages are structured so extraction is
   mechanical.
5. **Anchor resolution is explicitly client-side.** §8.3 rule 1 says agent ops are data-space, which
   implies this, but the protocol now states that the server MUST NOT reject on anchor grounds.
6. **Approval can be applied by the UI.** §8.4 has the agent retry with the approval id. v0 adds
   `POST /api/docs/{id}/approvals/{id}` so the human can replay the stored rejected envelope without
   another model turn. The agent still receives the suggestion and may retry itself.

---

## 16. Open questions

1. Does `chart.view.set` belong in the op log at all, or only in presence/telemetry? v0 journals it
   without a revision bump.
2. Should `propose` ops be visible to the user before approval, or only after? v0 journals the
   rejected attempt.
3. Is a capability token worth the signature machinery for a single-user local install? v0 keeps it
   because the shape is cheap and hosted mode needs it.
4. What is the exact boundary of "adapter-supplied inverse" for compound ops (e.g. a channel whose
   third point is derived)? v0 treats the whole object as one unit.

---

## 17. Implementation status (Phase 1a–1c)

The reference server (`server/src/journal.rs`, `server/src/capability.rs`) implements §4–§9 for the
chart bridge:

- SQLite tables for document metadata, ops, turns, and audit entries.
- Server-assigned `op_id` and `seq`, per-document revision, applied-key idempotency, and
  rejected-attempt audit entries that do not cache the key. A same-key/different-payload retry is
  journaled as an `idempotency_conflict` rejection; a malformed envelope gets a typed `invalid_op`
  ack without an audit row.
- `blake3` audit chain with genesis, verification, and first-break reporting.
- Adapter-supplied inverses, reverse-ordered undo planning, and `undone_by` linkage. Undo attempts
  for unknown or already-undone turns are journaled as typed rejections.
- Human edits are recorded through `POST /api/docs/{id}/records` after the adapter applies them:
  the server assigns ids/revisions, stores the inverse and snapshot, and audits
  `actor.kind = "human"`. One gesture is one turn; local snapshot undo remains unjournaled in v1.
- Applied acks may carry an opaque adapter snapshot. The server persists the latest snapshot with
  its revision and serves it from `GET /api/docs/{id}/snapshot`; the browser falls back to it when
  no workspace snapshot exists.
- Adapter rejections may carry a structured `suggestion`. The chart adapter suggests the first
  loaded bar time for an anchor before the window; the ack preserves it for agent self-correction.
- A local capability registry with typed denials for unknown, expired, mis-bound, out-of-scope,
  and read-only capabilities. Every attempt is journaled, including denials.
- One-shot human approvals for destructive agent ops. A rejected attempt carries
  `approval_required` and `suggestion.approval_id`; `POST /api/docs/{id}/approvals/{id}` re-submits
  the stored envelope with `approved_by` and the approval id, and the registry consumes it.
- `expected_revision` optimistic concurrency. A stale value is journaled as a retryable
  `revision_conflict` and does not bump the revision.
- `POST /api/docs/{doc_id}/ops` journals, dispatches `doc.op.request`, and waits for
  `POST /api/docs/{doc_id}/acks`; unacknowledged ops expire as retryable `internal` rejections.
- The OpenCode chart plugin submits through `POST /api/chart/op`, which journals and checks the
  capability before dispatching `doc.op.request`; the plugin waits for the browser ack. The legacy
  bridge RPC path remains as a fallback and journals at dispatch time.
- A Journal tab groups server ops by turn, shows typed rejections and audit verification, and
  drives undo and approval.
- The six language-agnostic fixtures pass against two targets: the TypeScript `MemoryTarget` and
  the Rust journal harness in `server/tests/conformance.rs` with a minimal 2D adapter.
- `packages/canvas-mcp` exposes `doc_get`, `op_apply`, `turn_undo`, and `state_query` over stdio,
  backed by the HTTP journal and the adapter snapshot.
- Ed25519 `tn1.<claims>.<signature>` capability tokens, a persisted issuer key, and
  `X-Tenon-Capability` on all write endpoints. Local mint/token endpoints are loopback-only.
- A ten-shape turn undo test, an `expected_revision`/idempotency conflict test, a structured
  reject → retry → ack test, and a journal replay helper (`packages/canvas-chart/src/replay.ts`).
- Reload restore order: workspace snapshot, then the journal snapshot, then replay of applied
  envelopes with stable draw ids.
- A second product adapter in Weave: `graph.node.create/update/delete`,
  `graph.edge.create/update/delete`, `graph.merge`, and `graph.view.set` over SSE, with
  node/edge inverses and a `cap_graph` capability bound to `weave-agent`.
- A p95 journal ack benchmark (`server/tests/latency.rs`); the local measurement is ~0.5 ms.

Not yet enforced or implemented:

- A hosted issuer with key rotation/revocation and a public key distribution policy. v0 persists
  one local key and mints tokens for seeded capabilities.
- Token enforcement on reads and on the legacy bridge RPC fallback. Writes over HTTP require a
  token; local reads and the compatibility path remain trusted.
- A published client SDK for pre-application submit beyond the chart plugin and MCP client.
- Replay-on-reload as the primary restore path. The browser uses the workspace snapshot first and
  falls back to the journal snapshot/replay; the workspace remains authoritative for human edits.
- An HTTP/SSE conformance adapter. The Rust harness drives the journal directly and the HTTP
  endpoints have separate integration tests; a target that speaks the wire protocol end to end is
  still open. The Weave bridge is a product adapter, not a fixture target.
- Weave note-ingestion deltas are not yet journaled; manual graph edits are.
- Local snapshot undo is not journaled; use the Journal's forward-only undo for journaled turns.

Known inverse limitation in the chart adapter: `update` merges style keys, so an inverse cannot
remove a key that the original update introduced. `draw` now accepts an explicit id, so re-creating
a deleted shape preserves its identity.
