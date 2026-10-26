# Changelog

All notable changes to the Tenon SDK and reference app are recorded here. Tenon was
formerly called Common Ground.

## 0.1.0 — 2026-10-26

First public SDK release.

### Added

- `@tenon-protocol/core` — protocol v1 envelopes, acks, turns, capability claims, audit
  schemas, and audit-chain helpers.
- `@tenon-protocol/chart` — chart adapter with zod schemas, `DocStore`, snapshot turns,
  inverses, and journal replay.
- `@tenon-protocol/graph` — graph adapter with nodes, edges, merge, view state, and
  inverses.
- `@tenon-protocol/conformance` — six language-agnostic fixtures, the reference
  `MemoryTarget`, and a runner for external targets.
- `@tenon-protocol/mcp` — stdio MCP server exposing `doc_get`, `op_apply`, `turn_undo`, and
  `state_query`.
- Tenon spec v0.1, generated JSON Schemas, and the extraction audit.
- Amaterasu reference app: chart shell, overlay engine, agent bridge, journal, approvals, and the
  human-edit record endpoint.

### Protocol

- Envelope, ack, turn, capability, and audit schemas are generated from the same zod definitions
  the runtime uses.
- Chart coordinates are data-space `(time, price)` anchors, never pixels.
- Capability tokens use Ed25519; the reference audit chain uses blake3.
- Destructive agent ops can require a one-shot human approval.
- Human edits are journaled after local application with their own inverse and snapshot.

### Known limitations

- `0.x`: the protocol version is stable at `1`, but package APIs may change in minor releases.
- The MCP server needs a running Tenon journal and a connected adapter; it does not host
  state itself.
- The public live demo uses deterministic sample data and has the agent disabled.
- No CRDT or multi-tenant hosted service yet.
