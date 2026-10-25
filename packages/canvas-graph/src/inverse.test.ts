import { describe, expect, it } from "vitest"
import { inverseOf } from "./inverse.ts"
import type { GraphDoc } from "./schema.ts"

const doc = (): GraphDoc => ({
  v: 1,
  nodes: [
    { id: "a", label: "A", kind: "concept" },
    { id: "b", label: "B", kind: "concept" },
  ],
  edges: [{ id: "e1", source: "a", target: "b", relation: "supports" }],
})

describe("graph inverseOf", () => {
  it("restores created, deleted, and changed nodes and edges", () => {
    const before = doc()
    const after: GraphDoc = {
      v: 1,
      nodes: [
        { id: "a", label: "A2", kind: "topic" },
        { id: "c", label: "C", kind: "concept" },
      ],
      edges: [{ id: "e2", source: "a", target: "c", relation: "mentions" }],
    }
    const ops = inverseOf(before, after)
    expect(ops).toEqual(
      expect.arrayContaining([
        { op: "node.update", id: "a", label: "A", kind: "concept" },
        { op: "node.create", id: "b", label: "B", kind: "concept" },
        { op: "node.delete", id: "c" },
        { op: "edge.create", id: "e1", source: "a", target: "b", relation: "supports" },
        { op: "edge.delete", id: "e2" },
      ]),
    )
  })

  it("returns no ops for unchanged documents", () => {
    expect(inverseOf(doc(), structuredClone(doc()))).toEqual([])
  })
})
