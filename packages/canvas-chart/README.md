# @tenon-protocol/chart

Chart adapter for **Tenon**. It turns agent and human intent into validated, data-space
annotations and computed series, with snapshot undo and replay.

Coordinates are always `(t, p)`: canonical epoch seconds of a real bar plus price. Pixels never
appear in the document, so drawings survive pan, zoom, and interval changes.

## Install

```sh
npm install @tenon-protocol/chart zod
```

## Quick start

```ts
import { DocStore } from "@tenon-protocol/chart"

const store = new DocStore({
  // Resolve anchors against the candles currently loaded in your chart.
  checkAnchor: (anchor) =>
    anchor.t >= 1_700_000_000
      ? { ok: true, warnings: [] }
      : { ok: false, reason: "outside the loaded window", warnings: [], suggestion: { t: 1_700_000_000, p: anchor.p } },
})

store.beginTurn()
const result = store.applyOp({
  op: "draw",
  kind: "trendline",
  points: [
    { t: 1_700_000_000, p: 2400 },
    { t: 1_700_086_400, p: 2485 },
  ],
  style: { color: "#5d91e9", width: 2 },
  source: { sessionID: "ses_1", messageID: "msg_1" },
})
store.commitTurn()

console.log(result) // { ok: true, id: "…", normalizedPoints: [...] }
console.log(store.exportDoc()) // { v: 1, annotations: [...], series: [] }

store.undo() // one turn disappears
```

## Ops

`draw`, `update`, `remove`, `clear`, `set_view`, `add_series`, and `remove_series`.

Supported kinds: `trendline`, `ray`, `hline`, `vline`, `rect`, `hzone`, `vzone`, `marker`,
`measure`, `fib`, `channel`, `label`.

The store enforces minimum anchors per kind, document caps, locked annotations, and anchor
resolution. A rejected op can carry a `suggestion` so an agent can retry with a nearby valid anchor
instead of failing blind.

## Turns and undo

```ts
store.beginTurn()
store.applyOp({ op: "draw", kind: "hline", points: [{ t: 1_700_000_000, p: 2450 }] })
store.applyOp({ op: "draw", kind: "rect", points: [/* … */] })
store.commitTurn()

store.undo() // removes both shapes as one step
store.redo()
```

`beginTurn()` / `commitTurn()` groups agent ops into one undo step. `abortTurn()` restores the
pre-turn state. Without an explicit turn, every op is its own undo step.

## Replay

```ts
import { replayApplied } from "@tenon-protocol/chart"

const { doc, applied, skipped } = replayApplied(journalOps)
store.replaceDoc(doc)
```

`replayApplied` reads journaled ops in sequence order, skips rejected and pending attempts, and
hydrates draw ops with the ids returned in their original acks. Use it when the workspace snapshot
is missing.

## Related packages

- [`@tenon-protocol/core`](../canvas-core) — envelopes, acks, capabilities, audit
- [`@tenon-protocol/graph`](../canvas-graph) — the same protocol over a knowledge graph
- [`@tenon-protocol/conformance`](../canvas-conformance) — fixtures and runner

MIT licensed.
