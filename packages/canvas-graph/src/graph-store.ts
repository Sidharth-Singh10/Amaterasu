import {
  GraphDocSchema,
  GraphOpSchema,
  type GraphDoc,
  type GraphEdge,
  type GraphNode,
  type GraphOp,
  type GraphResult,
} from "./schema.ts"

/** Single write path for graph agents and imports. Positions/view are adapter concerns. */
export class GraphStore {
  private state: GraphDoc = { v: 1, nodes: [], edges: [] }

  get nodes(): readonly GraphNode[] {
    return this.state.nodes
  }

  get edges(): readonly GraphEdge[] {
    return this.state.edges
  }

  exportDoc(): GraphDoc {
    return {
      v: 1,
      nodes: structuredClone(this.state.nodes).sort((a, b) => a.id.localeCompare(b.id)),
      edges: structuredClone(this.state.edges).sort((a, b) => a.id.localeCompare(b.id)),
    }
  }

  replaceDoc(raw: unknown): { ok: boolean; warnings: string[] } {
    const parsed = GraphDocSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        warnings: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
      }
    }
    this.state = {
      v: 1,
      nodes: parsed.data.nodes
        .map((node) => ({ ...node }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: parsed.data.edges
        .map((edge) => ({ ...edge }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }
    return { ok: true, warnings: [] }
  }

  applyOp(raw: unknown): GraphResult {
    const parsed = GraphOpSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        warnings: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
      }
    }
    return this.dispatch(parsed.data)
  }

  private dispatch(op: GraphOp): GraphResult {
    switch (op.op) {
      case "node.create": {
        if (this.state.nodes.some((node) => node.id === op.id)) {
          return { ok: false, warnings: [`node ${op.id} already exists`] }
        }
        this.state.nodes.push({ id: op.id, label: op.label, kind: op.kind })
        return { ok: true, id: op.id }
      }
      case "node.update": {
        const node = this.state.nodes.find((candidate) => candidate.id === op.id)
        if (!node) return { ok: false, warnings: [`no node ${op.id}`] }
        if (op.label !== undefined) node.label = op.label
        if (op.kind !== undefined) node.kind = op.kind
        return { ok: true, id: node.id }
      }
      case "node.delete": {
        const index = this.state.nodes.findIndex((node) => node.id === op.id)
        if (index < 0) return { ok: false, warnings: [`no node ${op.id}`] }
        this.state.nodes.splice(index, 1)
        this.state.edges = this.state.edges.filter(
          (edge) => edge.source !== op.id && edge.target !== op.id,
        )
        return { ok: true, id: op.id }
      }
      case "edge.create": {
        if (op.source === op.target) {
          return { ok: false, warnings: ["an edge needs two different nodes"] }
        }
        if (this.state.edges.some((edge) => edge.id === op.id)) {
          return { ok: false, warnings: [`edge ${op.id} already exists`] }
        }
        if (!this.hasNode(op.source) || !this.hasNode(op.target)) {
          return { ok: false, warnings: ["edge endpoints must exist"] }
        }
        this.state.edges.push({
          id: op.id,
          source: op.source,
          target: op.target,
          relation: op.relation,
        })
        return { ok: true, id: op.id }
      }
      case "edge.update": {
        const edge = this.state.edges.find((candidate) => candidate.id === op.id)
        if (!edge) return { ok: false, warnings: [`no edge ${op.id}`] }
        const source = op.source ?? edge.source
        const target = op.target ?? edge.target
        if (source === target) {
          return { ok: false, warnings: ["an edge needs two different nodes"] }
        }
        if (!this.hasNode(source) || !this.hasNode(target)) {
          return { ok: false, warnings: ["edge endpoints must exist"] }
        }
        edge.source = source
        edge.target = target
        if (op.relation !== undefined) edge.relation = op.relation
        return { ok: true, id: edge.id }
      }
      case "edge.delete": {
        const index = this.state.edges.findIndex((edge) => edge.id === op.id)
        if (index < 0) return { ok: false, warnings: [`no edge ${op.id}`] }
        this.state.edges.splice(index, 1)
        return { ok: true, id: op.id }
      }
      case "merge": {
        if (op.from === op.into) {
          return { ok: false, warnings: ["cannot merge a node into itself"] }
        }
        const from = this.state.nodes.find((node) => node.id === op.from)
        const into = this.state.nodes.find((node) => node.id === op.into)
        if (!from || !into) return { ok: false, warnings: ["merge endpoints must exist"] }
        this.state.nodes = this.state.nodes.filter((node) => node.id !== op.from)
        const seen = new Set<string>()
        this.state.edges = this.state.edges
          .map((edge) => ({
            ...edge,
            source: edge.source === op.from ? op.into : edge.source,
            target: edge.target === op.from ? op.into : edge.target,
          }))
          .filter((edge) => {
            if (edge.source === edge.target) return false
            const key = `${edge.source}|${edge.target}|${edge.relation}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
        return { ok: true, id: op.into }
      }
      case "view.set":
        return { ok: true }
    }
  }

  private hasNode(id: string): boolean {
    return this.state.nodes.some((node) => node.id === id)
  }
}
