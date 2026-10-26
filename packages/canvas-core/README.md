# @tenon-protocol/core

Protocol primitives for **Tenon**: typed operations that humans and AI agents apply to the
same visual document, with acknowledgements, capabilities, turns, undo, and a hash-chained audit
log.

This package is the executable form of [`spec/protocol.md`](../../spec/protocol.md). The JSON
Schemas in [`spec/schemas/`](../../spec/schemas/) are generated from these zod definitions.

## Install

```sh
npm install @tenon-protocol/core zod
```

## What is in the box

| Export | Purpose |
|---|---|
| `EnvelopeSchema` / `Envelope` | One typed mutation: actor, turn, capability, target, payload, idempotency key |
| `BatchSchema` | Up to 200 envelopes applied in order |
| `AckSchema` / `Ack` | Applied or rejected, with normalized result, inverse, or a self-correction hint |
| `TurnSchema` / `Turn` | A group of ops that can be undone atomically |
| `CapabilityClaimsSchema` | Scoped, expiring grant for a document and op types |
| `AuditEntrySchema` | Append-only, hash-chained record of every attempt |
| `opVerb` | Last segment of an op type (`chart.shape.create` → `create`) |
| `matchesPattern` | Wildcard matching for capability patterns |
| `canonicalJson` | Deterministic JSON used by the audit hash |
| `hashAuditEntry` / `verifyAuditChain` | Build and verify the audit chain with an injected hash function |

The envelope is deliberately loose: unknown fields survive a round trip so newer peers can add
metadata without breaking older ones. Domain payloads are validated by the adapter.

## Validate an envelope

```ts
import { EnvelopeSchema } from "@tenon-protocol/core"

const parsed = EnvelopeSchema.safeParse({
  v: 1,
  doc_id: "doc_reliance",
  turn_id: "turn_42",
  seq: 1,
  actor: { kind: "agent", id: "chart-analyst", model: "deepseek-v4.1-flash" },
  capability: "cap_agent",
  type: "chart.shape.create",
  target: { kind: "annotation" },
  payload: { op: "draw" },
  idempotency_key: "turn_42:1",
  created_at: "2026-10-25T10:00:00Z",
})

if (!parsed.success) {
  console.error(parsed.error.issues)
}
```

`create`, `set`, and `upsert` ops must not carry `target.id`; `update`, `delete`, and `patch` ops
must carry one.

## Verify an audit chain

```ts
import { verifyAuditChain, type HashFn } from "@tenon-protocol/core"
import { createHash } from "node:crypto"

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex")
const result = verifyAuditChain(entries, sha256, "sha256")

if (!result.ok) console.error(result.reason, result.brokenAt)
```

The server uses blake3; the verifier takes the hash function so a target can use whatever primitive
it already has.

## Related packages

- [`@tenon-protocol/chart`](../canvas-chart) — chart adapter and `DocStore`
- [`@tenon-protocol/graph`](../canvas-graph) — graph adapter
- [`@tenon-protocol/mcp`](../canvas-mcp) — MCP server over a Tenon journal
- [`@tenon-protocol/conformance`](../canvas-conformance) — fixtures and runner

MIT licensed.
