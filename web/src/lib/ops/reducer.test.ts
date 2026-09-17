import { describe, expect, it, vi } from "vitest"
import { CAPS, type OpResult, type SetViewOp } from "@amaterasu/chart-dsl"
import { DocStore } from "./reducer"

const IN_WINDOW = (t: number) => t >= 1000 && t <= 5000

function makeStore(onView?: (op: SetViewOp) => OpResult) {
  let id = 0
  let now = 1_000_000
  return new DocStore({
    checkAnchor: (anchor) =>
      IN_WINDOW(anchor.t)
        ? { ok: true, warnings: [] }
        : { ok: false, reason: "before-loaded-window", warnings: ["outside window"] },
    onView,
    newId: () => `a${++id}`,
    now: () => now++,
  })
}

const trendline = (t1 = 1000, t2 = 5000) => ({
  op: "draw",
  kind: "trendline",
  points: [
    { t: t1, p: 10 },
    { t: t2, p: 20 },
  ],
})

describe("DocStore", () => {
  it("draws and returns the annotation id", () => {
    const store = makeStore()
    const result = store.applyOp(trendline())
    expect(result.ok).toBe(true)
    expect(result.id).toBe("a1")
    expect(store.annotations).toHaveLength(1)
  })

  it("rejects invalid ops at the schema boundary", () => {
    const store = makeStore()
    const result = store.applyOp({ op: "draw" })
    expect(result.ok).toBe(false)
    expect(result.warnings?.[0]).toContain("invalid op")
    expect(store.annotations).toHaveLength(0)
  })

  it("rejects unresolved anchors", () => {
    const store = makeStore()
    const result = store.applyOp({
      op: "draw",
      kind: "hline",
      points: [{ t: 500, p: 10 }],
    })
    expect(result.ok).toBe(false)
    expect(result.unresolved).toEqual(["before-loaded-window"])
  })

  it("enforces the per-kind minimum point count", () => {
    const store = makeStore()
    const result = store.applyOp({ op: "draw", kind: "trendline", points: [{ t: 1000, p: 10 }] })
    expect(result.ok).toBe(false)
    expect(result.warnings?.[0]).toContain("at least 2")
  })

  it("enforces the annotation cap", () => {
    const store = makeStore()
    for (let i = 0; i < CAPS.maxAnnotations; i++) {
      const result = store.applyOp({ op: "draw", kind: "hline", points: [{ t: 1000, p: 10 }] })
      expect(result.ok).toBe(true)
    }
    const overflow = store.applyOp({ op: "draw", kind: "hline", points: [{ t: 1000, p: 10 }] })
    expect(overflow.ok).toBe(false)
    expect(overflow.warnings?.[0]).toContain("cap")
  })

  it("protects locked annotations and allows unlocking", () => {
    const store = makeStore()
    store.applyOp(trendline())
    const id = store.annotations[0].id

    expect(store.applyOp({ op: "update", id, locked: true }).ok).toBe(true)
    const blocked = store.applyOp({ op: "update", id, points: [{ t: 1000, p: 99 }, { t: 2000, p: 99 }] })
    expect(blocked.ok).toBe(false)
    expect(store.applyOp({ op: "remove", id }).ok).toBe(false)
    expect(store.applyOp({ op: "update", id, locked: false }).ok).toBe(true)
    expect(store.applyOp({ op: "update", id, points: [{ t: 1000, p: 99 }, { t: 2000, p: 99 }] }).ok).toBe(true)
    expect(store.applyOp({ op: "remove", id }).ok).toBe(true)
    expect(store.annotations).toHaveLength(0)
  })

  it("clears by source message id", () => {
    const store = makeStore()
    store.applyOp({ ...trendline(), source: { sessionID: "s", messageID: "m1" } })
    store.applyOp({ ...trendline(), source: { sessionID: "s", messageID: "m1" } })
    store.applyOp({ ...trendline(), source: { sessionID: "s", messageID: "m2" } })

    const result = store.applyOp({ op: "clear", sourceMessageID: "m1" })
    expect(result.ok).toBe(true)
    expect(store.annotations).toHaveLength(1)
    expect(store.annotations[0].source?.messageID).toBe("m2")
  })

  it("requires a filter for clear", () => {
    const store = makeStore()
    const result = store.applyOp({ op: "clear" })
    expect(result.ok).toBe(false)
  })

  it("undoes and redoes single ops", () => {
    const store = makeStore()
    store.applyOp(trendline())
    store.applyOp(trendline())
    expect(store.annotations).toHaveLength(2)

    expect(store.undo()).toBe(true)
    expect(store.annotations).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(store.annotations).toHaveLength(0)
    expect(store.undo()).toBe(false)

    expect(store.redo()).toBe(true)
    expect(store.annotations).toHaveLength(1)
  })

  it("groups a whole turn into one undo step", () => {
    const store = makeStore()
    store.beginTurn()
    store.applyOp(trendline())
    store.applyOp(trendline())
    store.commitTurn()
    expect(store.annotations).toHaveLength(2)
    expect(store.undo()).toBe(true)
    expect(store.annotations).toHaveLength(0)
    expect(store.redo()).toBe(true)
    expect(store.annotations).toHaveLength(2)
  })

  it("aborts a turn without leaving an undo step", () => {
    const store = makeStore()
    store.applyOp(trendline())
    store.beginTurn()
    store.applyOp(trendline())
    store.abortTurn()
    expect(store.annotations).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(store.annotations).toHaveLength(0)
  })

  it("refuses nested turns", () => {
    const store = makeStore()
    store.beginTurn()
    expect(() => store.beginTurn()).toThrow()
    store.abortTurn()
  })

  it("does not leave history entries for failed ops", () => {
    const store = makeStore()
    store.applyOp(trendline())
    store.applyOp({ op: "draw", kind: "hline", points: [{ t: 500, p: 10 }] })
    expect(store.undo()).toBe(true)
    expect(store.annotations).toHaveLength(0)
    expect(store.undo()).toBe(false)
  })

  it("routes view ops to the view controller", () => {
    const onView = vi.fn((_op: SetViewOp): OpResult => ({ ok: true }))
    const store = makeStore(onView)
    const result = store.applyOp({ op: "set_view", bars: 60 })
    expect(result.ok).toBe(true)
    expect(onView).toHaveBeenCalledWith({ op: "set_view", bars: 60 })
  })

  it("fails view ops without a controller", () => {
    const store = makeStore()
    const result = store.applyOp({ op: "set_view", bars: 60 })
    expect(result.ok).toBe(false)
  })
})

describe("DocStore computed series", () => {
  const line = (id = "s1", v = 10) => ({
    op: "add_series",
    id,
    name: "SMA 20",
    points: [
      { t: 1000, v },
      { t: 2000, v: v + 1 },
    ],
  })

  it("adds a series and upserts by id", () => {
    const store = makeStore()
    expect(store.applyOp(line()).ok).toBe(true)
    expect(store.series).toHaveLength(1)
    expect(store.applyOp(line("s1", 20)).ok).toBe(true)
    expect(store.series).toHaveLength(1)
    expect(store.series[0].points[0].v).toBe(20)
  })

  it("removes a series and rejects unknown ids", () => {
    const store = makeStore()
    store.applyOp(line())
    expect(store.applyOp({ op: "remove_series", id: "s1" }).ok).toBe(true)
    expect(store.series).toHaveLength(0)
    expect(store.applyOp({ op: "remove_series", id: "nope" }).ok).toBe(false)
  })

  it("caps the number of series", () => {
    const store = makeStore()
    for (let i = 0; i < CAPS.maxSeries; i++) {
      expect(store.applyOp(line(`s${i}`)).ok).toBe(true)
    }
    const overflow = store.applyOp(line("overflow"))
    expect(overflow.ok).toBe(false)
    expect(overflow.warnings?.[0]).toContain("cap")
  })

  it("undoes and redoes series changes", () => {
    const store = makeStore()
    store.applyOp(line())
    expect(store.undo()).toBe(true)
    expect(store.series).toHaveLength(0)
    expect(store.redo()).toBe(true)
    expect(store.series).toHaveLength(1)
  })
})
