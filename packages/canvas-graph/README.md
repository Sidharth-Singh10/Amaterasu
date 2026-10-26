# @tenon-protocol/graph

Graph adapter for **Tenon**. A second domain proves the protocol is not chart-specific:
nodes, edges, merges, and view state go through the same envelope, ack, turn, undo, and audit
machinery as the chart adapter.

## Install

```sh
npm install @tenon-protocol/graph zod
```

## Quick start

```ts
import { GraphStore, inverseOf } from "@tenon-protocol/graph"

const store = new GraphStore()

store.applyOp({ op: "node.create", id: "n_react", label: "React", kind: "tool" })
store.applyOp({ op: "node.create", id: "n_svelte", label: "Svelte", kind: "tool" })
store.applyOp({
  op: "edge.create",
  id: "e_1",
  source: "n_react",
  target: "n_svelte",
  relation: "alternative-to",
})

const before = store.exportDoc()
const result = store.applyOp({ op: "merge", from: "n_react", into: "n_svelte" })
const inverse = inverseOf(before, store.exportDoc())

console.log(result) // { ok: true, id: "n_svelte" }
console.log(inverse) // the ops that restore the merged node and its edges
```

## Ops

`node.create`, `node.update`, `node.delete`, `edge.create`, `edge.update`, `edge.delete`, `merge`,
and `view.set`.

The store rejects edges with missing endpoints or identical endpoints, refuses to merge a node into
itself, and removes orphaned or duplicate edges after a merge. `GraphStore` owns document state
only; layout and viewport are adapter concerns.

## Inverses

`inverseOf(op, before)` returns domain ops that restore `before`. The server journals those
inverses so a turn can be undone without replaying the whole document.

## Related packages

- [`@tenon-protocol/core`](../canvas-core) — envelopes, acks, capabilities, audit
- [`@tenon-protocol/chart`](../canvas-chart) — the chart adapter
- [`@tenon-protocol/conformance`](../canvas-conformance) — fixtures and runner

MIT licensed.
