# @common-ground/canvas-graph

Graph adapter for **Common Ground**. A second domain proves the protocol is not chart-specific:
nodes, edges, merges, and view state go through the same envelope, ack, turn, undo, and audit
machinery as the chart adapter.

## Install

```sh
npm install @common-ground/canvas-graph zod
```

## Quick start

```ts
import { GraphStore, inverseOf } from "@common-ground/canvas-graph"

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

- [`@common-ground/canvas-core`](../canvas-core) — envelopes, acks, capabilities, audit
- [`@common-ground/canvas-chart`](../canvas-chart) — the chart adapter
- [`@common-ground/canvas-conformance`](../canvas-conformance) — fixtures and runner

MIT licensed.
