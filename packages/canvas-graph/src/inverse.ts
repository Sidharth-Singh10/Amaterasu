import type { GraphDoc, GraphOp } from "./schema.ts"

/** Diffs two graph documents into the ops that restore the "before" state. */
export function inverseOf(before: GraphDoc, after: GraphDoc): GraphOp[] {
  const inverses: GraphOp[] = []
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]))
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]))
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]))
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]))

  // The server reverses this array. Order it so the reverse is dependency-safe:
  // restore nodes, restore edges, update nodes, update edges, delete edges, delete nodes.
  for (const node of after.nodes) {
    if (!beforeNodes.has(node.id)) inverses.push({ op: "node.delete", id: node.id })
  }
  for (const edge of after.edges) {
    if (!beforeEdges.has(edge.id)) inverses.push({ op: "edge.delete", id: edge.id })
  }
  for (const edge of before.edges) {
    const next = afterEdges.get(edge.id)
    if (
      next &&
      (next.source !== edge.source ||
        next.target !== edge.target ||
        next.relation !== edge.relation)
    ) {
      inverses.push({
        op: "edge.update",
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
      })
    }
  }
  for (const node of before.nodes) {
    const next = afterNodes.get(node.id)
    if (next && (next.label !== node.label || next.kind !== node.kind)) {
      inverses.push({ op: "node.update", id: node.id, label: node.label, kind: node.kind })
    }
  }
  for (const edge of before.edges) {
    if (!afterEdges.has(edge.id)) {
      inverses.push({
        op: "edge.create",
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
      })
    }
  }
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) {
      inverses.push({ op: "node.create", id: node.id, label: node.label, kind: node.kind })
    }
  }
  return inverses
}
