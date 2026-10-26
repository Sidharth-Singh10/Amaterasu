import { DocStore } from "@tenon-protocol/chart"

const DAY = 86_400
const start = 1_700_000_000

/**
 * A real adapter resolves anchors against the candles currently loaded in the chart. This example
 * accepts the first 30 days and returns a nearby valid anchor for anything outside the window.
 */
const store = new DocStore({
  checkAnchor: (anchor) =>
    anchor.t >= start && anchor.t <= start + 30 * DAY
      ? { ok: true, warnings: [] }
      : {
          ok: false,
          reason: `t=${anchor.t} is outside the loaded window`,
          warnings: [],
          suggestion: { t: start, p: anchor.p },
        },
})

store.beginTurn()

const trend = store.applyOp({
  op: "draw",
  kind: "trendline",
  points: [
    { t: start, p: 2400 },
    { t: start + 10 * DAY, p: 2485 },
  ],
  style: { color: "#5d91e9", width: 2 },
  source: { sessionID: "ses_example", messageID: "msg_example" },
})

const range = store.applyOp({
  op: "draw",
  kind: "rect",
  points: [
    { t: start + 12 * DAY, p: 2420 },
    { t: start + 20 * DAY, p: 2520 },
  ],
  style: { color: "#e6ad33", fill: "#e6ad33", fillOpacity: 0.08 },
  label: "supply",
})

const sma = store.applyOp({
  op: "add_series",
  id: "sma_5",
  name: "SMA(5)",
  points: [
    { t: start, v: 2412 },
    { t: start + DAY, v: 2418 },
    { t: start + 2 * DAY, v: 2429 },
  ],
  style: { color: "#26a69a", width: 1.5 },
})

store.commitTurn()

console.log("applied:", { trend: trend.ok, range: range.ok, sma: sma.ok })
console.log("annotations:", store.annotations.length, "series:", store.series.length)
console.log("canUndo:", store.canUndo)

store.undo()

console.log("after undo — annotations:", store.annotations.length, "series:", store.series.length)
console.log("canRedo:", store.canRedo)

store.redo()

console.log("after redo — annotations:", store.annotations.length, "series:", store.series.length)
console.log("document:", JSON.stringify(store.exportDoc(), null, 2))
