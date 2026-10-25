import { describe, expect, it } from "vitest"
import type { Annotation, DocPayload, Series } from "./schema.ts"
import { inverseOf } from "./inverse.ts"

function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    kind: "trendline",
    points: [
      { t: 1, p: 10 },
      { t: 2, p: 20 },
    ],
    style: { color: "#ff0000" },
    z: 0,
    hidden: false,
    locked: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function series(overrides: Partial<Series> = {}): Series {
  return {
    id: "s1",
    name: "SMA 20",
    points: [
      { t: 1, v: 10 },
      { t: 2, v: 20 },
    ],
    style: { color: "#00ff00" },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function doc(annotations: Annotation[], lines: Series[] = []): DocPayload {
  return { v: 1, annotations, series: lines }
}

describe("inverseOf", () => {
  it("returns no inverses for an unchanged document or a view-only change", () => {
    const base = doc([annotation()], [series()])
    expect(inverseOf(base, structuredClone(base))).toEqual([])
  })

  it("removes a created shape and restores a deleted one", () => {
    const created = inverseOf(doc([]), doc([annotation()]))
    expect(created).toHaveLength(1)
    expect(created[0]!.type).toBe("chart.shape.delete")
    expect(created[0]!.target).toEqual({ kind: "chart.shape", id: "a1" })
    expect(created[0]!.payload.op).toEqual({ op: "remove", id: "a1" })

    const deleted = inverseOf(doc([annotation()]), doc([]))
    expect(deleted).toHaveLength(1)
    expect(deleted[0]!.type).toBe("chart.shape.create")
    const op = deleted[0]!.payload.op
    expect(op.op).toBe("draw")
    if (op.op === "draw") {
      expect(op.id).toBe("a1")
      expect(op.kind).toBe("trendline")
      expect(op.points).toEqual(annotation().points)
      expect(op.style).toEqual({ color: "#ff0000" })
    }
  })

  it("updates a changed shape back to its previous geometry", () => {
    const before = annotation()
    const after = annotation({
      points: [
        { t: 3, p: 30 },
        { t: 4, p: 40 },
      ],
      updatedAt: 2,
    })
    const inverse = inverseOf(doc([before]), doc([after]))[0]!
    expect(inverse.type).toBe("chart.shape.update")
    expect(inverse.target).toEqual({ kind: "chart.shape", id: "a1" })
    const op = inverse.payload.op
    expect(op.op).toBe("update")
    if (op.op === "update") {
      expect(op.points).toEqual(before.points)
      expect(op.style).toEqual(before.style)
      expect(op.hidden).toBe(false)
      expect(op.locked).toBe(false)
    }
  })

  it("restores deleted series and removes created ones", () => {
    const restored = inverseOf(doc([], [series()]), doc([]))
    expect(restored).toHaveLength(1)
    expect(restored[0]!.type).toBe("chart.series.upsert")
    const op = restored[0]!.payload.op
    expect(op.op).toBe("add_series")
    if (op.op === "add_series") {
      expect(op.id).toBe("s1")
      expect(op.points).toEqual(series().points)
    }

    const removed = inverseOf(doc([], []), doc([], [series()]))
    expect(removed).toHaveLength(1)
    expect(removed[0]!.type).toBe("chart.series.delete")
    expect(removed[0]!.payload.op).toEqual({ op: "remove_series", id: "s1" })
  })

  it("restores a changed series with an upsert", () => {
    const before = series()
    const after = series({ points: [{ t: 3, v: 30 }, { t: 4, v: 40 }], updatedAt: 2 })
    const inverse = inverseOf(doc([], [before]), doc([], [after]))[0]!
    expect(inverse.type).toBe("chart.series.upsert")
    const op = inverse.payload.op
    expect(op.op).toBe("add_series")
    if (op.op === "add_series") expect(op.points).toEqual(before.points)
  })

  it("handles a mixed batch in one diff", () => {
    const removed = annotation({ id: "a1" })
    const created = annotation({ id: "a2" })
    const inverses = inverseOf(doc([removed], [series()]), doc([created], []))
    expect(inverses.map((inverse) => inverse.type).sort()).toEqual([
      "chart.series.upsert",
      "chart.shape.create",
      "chart.shape.delete",
    ])
  })
})
