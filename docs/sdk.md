# Tenon SDK

The Tenon SDK is a small set of packages for building a shared workspace that humans and
AI agents can edit safely. An agent sends a typed operation; an adapter validates and applies it
against domain state; the server journals it, checks the capability, and records it in a
hash-chained audit log. Every accepted turn can be undone.

The protocol is transport-neutral. The SDK ships schemas, adapters, a conformance corpus, and an
MCP bridge; the Rust service in this repository is one implementation of the journal.

> **Release status:** the `0.1.0` packages are built, packed, and validated. npm publication is
> intentionally paused. Until the release, use the workspace source in `packages/` or the tarballs
> produced by `npm run build:packages`; the install commands below describe the published build.

## Packages

| Package | Use it for |
|---|---|
| [`@tenon-protocol/core`](https://www.npmjs.com/package/@tenon-protocol/core) | Envelopes, acks, turns, capabilities, audit helpers |
| [`@tenon-protocol/chart`](https://www.npmjs.com/package/@tenon-protocol/chart) | Chart annotations, computed series, `DocStore`, replay |
| [`@tenon-protocol/graph`](https://www.npmjs.com/package/@tenon-protocol/graph) | Nodes, edges, merges, graph inverses |
| [`@tenon-protocol/conformance`](https://www.npmjs.com/package/@tenon-protocol/conformance) | Six fixtures and a runner for your own target |
| [`@tenon-protocol/mcp`](https://www.npmjs.com/package/@tenon-protocol/mcp) | MCP stdio server: `doc_get`, `op_apply`, `turn_undo`, `state_query` |

All packages are ESM, require Node 20 or newer, and are MIT licensed.
`@tenon-protocol/core` and the adapters depend on zod 4.

## Install

```sh
# Protocol only
npm install @tenon-protocol/core zod

# Chart adapter
npm install @tenon-protocol/chart zod

# MCP server
npm install -g @tenon-protocol/mcp
```

## The shape of an operation

```json
{
  "v": 1,
  "doc_id": "doc_reliance",
  "turn_id": "turn_42",
  "seq": 1,
  "actor": { "kind": "agent", "id": "chart-analyst", "model": "deepseek-v4.1-flash" },
  "capability": "cap_agent",
  "type": "chart.shape.create",
  "target": { "kind": "annotation" },
  "payload": { "op": "draw", "kind": "trendline", "points": [] },
  "rationale": "Mark the higher-low sequence",
  "idempotency_key": "turn_42:1",
  "created_at": "2026-10-25T10:00:00Z"
}
```

The envelope is validated by `@tenon-protocol/core`; the payload is validated by the adapter.
The server assigns `op_id` and the revision, then returns an ack:

```json
{
  "v": 1,
  "op_id": "op_123",
  "turn_id": "turn_42",
  "seq": 1,
  "status": "applied",
  "revision": 17,
  "result": { "id": "an_9" },
  "inverse": [{ "op": "remove", "id": "an_9" }]
}
```

A rejected ack carries `code`, `message`, `retryable`, and optionally a `suggestion` with a nearby
valid anchor. Agents can retry with the suggestion instead of guessing.

## Add a chart adapter

The chart package is the reference domain. A chart adapter owns three things:

1. **Anchor resolution.** `DocStore` calls `checkAnchor(anchor)` before a draw or update. Return
   `ok: false` with a `suggestion` when the time/price is outside the loaded data.
2. **Projection.** The adapter renders the document's annotations in `(time, price)` space. Pixels
   never enter the document.
3. **Inverses.** When the browser applies an op, it sends the ack result and the domain inverse back
   to the server. The server journals the inverse; the adapter does not replay history to undo.

```ts
import { DocStore } from "@tenon-protocol/chart"

const store = new DocStore({ checkAnchor })
const result = store.applyOp({ op: "draw", kind: "hline", points: [{ t, p }] })
```

The full op list and turn semantics are in the
[package README](../packages/canvas-chart/README.md).

## Add a new adapter

The protocol is domain-neutral. To add a domain:

1. Define object schemas and a discriminated union of ops. Ops use `<domain>.<object>.<verb>`.
2. Implement a store with one write path. It returns `{ ok, id, warnings, suggestion? }`.
3. Compute an inverse for every applied op from the before state.
4. Implement `ConformanceTarget` and run the six fixtures.
5. Expose the ops to an agent, usually through the MCP server.

The graph adapter is a compact example: nodes, edges, merge, and view state in about 160 lines.

## Capabilities and approval

`CapabilityClaimsSchema` describes a scoped, expiring grant:

```ts
import { CapabilityClaimsSchema } from "@tenon-protocol/core"

const claims = CapabilityClaimsSchema.parse({
  v: 1,
  cap_id: "cap_agent",
  iss: "cg_server",
  sub: { actor_id: "chart-analyst", session: "ses_1" },
  documents: ["doc_*"],
  op_types: ["chart.shape.*", "chart.series.*"],
  permissions: ["read", "apply"],
  approval: { mode: "human", op_types: ["chart.shape.delete"] },
  issued_at: "2026-10-25T10:00:00Z",
  expires_at: "2026-10-25T11:00:00Z",
})
```

The reference server signs claims as an Ed25519 `tn1.…` token. Destructive ops can require a
one-shot human approval, which the browser surfaces before the op is applied.

## Audit

Every attempt, applied or rejected, gets an audit entry. The chain links each entry to the previous
one:

```
hash = H(prev_hash || "\n" || canonical_json(entry without hash/prev_hash))
```

`verifyAuditChain(entries, hash, alg)` checks gapless sequencing, document identity, linkage, and
every digest. The reference server uses blake3; the helper takes the hash function so another
target can use SHA-256 or whatever it already has.

## MCP

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

The MCP server is a thin client over a running journal. It does not store state itself.

## Conformance

```ts
import { MemoryTarget, loadFixtures, runSuite } from "@tenon-protocol/conformance"

const results = await runSuite(new MemoryTarget(), loadFixtures())
```

The published package includes the fixtures. Pass a directory to run a different corpus. The same
six cases also run against the Rust journal in `server/tests/conformance.rs`.

## Versioning

The protocol version is `1` and is carried in every envelope as `v`. Package versions are separate
from the protocol version. During `0.x`, minor releases may add fields; unknown envelope fields are
preserved, and adapters reject unknown ops rather than guessing.

## Repository

- [Protocol specification](../spec/protocol.md)
- [Conformance fixtures](../spec/conformance)
- [Examples](../examples)
- [Source](https://github.com/Sidharth-Singh10/Amaterasu)
