import { describe, expect, it } from "vitest"
import { GraphStore } from "./graph-store.ts"
import { inverseOf } from "./inverse.ts"

const node = (id: string, label = id, kind = "concept") => ({ op: "node.create" as const, id, label, kind })
const edge = (id: string, source: string, target: string, relation = "related to") => ({
  op: "edge.create" as const,
  id,
  source,
  target,
  relation,
})

describe("GraphStore", () => {
  it("creates nodes and edges and rejects dangling edges", () => {
    const store = new GraphStore()
    expect(store.applyOp(node("a", "Alpha")).ok).toBe(true)
    expect(store.applyOp(node("b", "Beta")).ok).toBe(true)
    expect(store.applyOp(edge("e1", "a", "b", "supports")).ok).toBe(true)
    expect(store.applyOp(edge("e2", "a", "missing")).ok).toBe(false)
    expect(store.exportDoc()).toMatchObject({
      v: 1,
      nodes: [{ id: "a", label: "Alpha", kind: "concept" }, { id: "b" }],
      edges: [{ id: "e1", source: "a", target: "b", relation: "supports" }],
    })
  })

  it("deletes incident edges with a node", () => {
    const store = new GraphStore()
    store.applyOp(node("a"))
    store.applyOp(node("b"))
    store.applyOp(edge("e1", "a", "b"))
    expect(store.applyOp({ op: "node.delete", id: "a" }).ok).toBe(true)
    expect(store.nodes).toHaveLength(1)
    expect(store.edges).toHaveLength(0)
  })

  it("merges a duplicate node and repoints/dedupes edges", () => {
    const store = new GraphStore()
    for (const id of ["a", "b", "c"]) store.applyOp(node(id))
    store.applyOp(edge("ab", "a", "b", "supports"))
    store.applyOp(edge("cb", "c", "b", "mentions"))
    store.applyOp(edge("ca", "c", "a", "mentions"))
    const result = store.applyOp({ op: "merge", from: "a", into: "c" })
    expect(result).toMatchObject({ ok: true, id: "c" })
    expect(store.nodes.map((n) => n.id).sort()).toEqual(["b", "c"])
    expect(store.edges.map((e) => e.id).sort()).toEqual(["ab", "cb"])
    expect(store.edges.find((e) => e.id === "ab")?.source).toBe("c")
  })

  it("undoes a merge from the inverse diff", () => {
    const store = new GraphStore()
    for (const id of ["a", "b", "c"]) store.applyOp(node(id))
    store.applyOp(edge("ab", "a", "b"))
    const before = store.exportDoc()
    store.applyOp({ op: "merge", from: "a", into: "c" })
    const after = store.exportDoc()
    const restored = new GraphStore()
    restored.replaceDoc(after)
    for (const op of [...inverseOf(before, after)].reverse()) {
      expect(restored.applyOp(op).ok).toBe(true)
    }
    expect(restored.exportDoc()).toEqual(before)
  })

  it("treats view ops as ephemeral successes", () => {
    const store = new GraphStore()
    expect(store.applyOp({ op: "view.set", semanticZoom: "overview" }).ok).toBe(true)
    expect(store.exportDoc()).toEqual({ v: 1, nodes: [], edges: [] })
  })
})
