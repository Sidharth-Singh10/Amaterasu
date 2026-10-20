import { z } from "zod"

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
})
export type GraphNode = z.infer<typeof GraphNodeSchema>

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.string().min(1).max(120),
})
export type GraphEdge = z.infer<typeof GraphEdgeSchema>

export const GraphDocSchema = z.object({
  v: z.literal(1),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
})
export type GraphDoc = z.infer<typeof GraphDocSchema>

const nodeCreate = z.object({
  op: z.literal("node.create"),
  id: z.string().min(1),
  label: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
})
const nodeUpdate = z.object({
  op: z.literal("node.update"),
  id: z.string().min(1),
  label: z.string().min(1).max(200).optional(),
  kind: z.string().min(1).max(64).optional(),
})
const nodeDelete = z.object({ op: z.literal("node.delete"), id: z.string().min(1) })
const edgeCreate = z.object({
  op: z.literal("edge.create"),
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  relation: z.string().min(1).max(120),
})
const edgeUpdate = z.object({
  op: z.literal("edge.update"),
  id: z.string().min(1),
  source: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  relation: z.string().min(1).max(120).optional(),
})
const edgeDelete = z.object({ op: z.literal("edge.delete"), id: z.string().min(1) })
const merge = z.object({
  op: z.literal("merge"),
  from: z.string().min(1),
  into: z.string().min(1),
})
const viewSet = z.object({
  op: z.literal("view.set"),
  selectedNodeId: z.string().optional(),
  semanticZoom: z.enum(["overview", "category", "entity", "detail"]).optional(),
})

export const GraphOpSchema = z.discriminatedUnion("op", [
  nodeCreate,
  nodeUpdate,
  nodeDelete,
  edgeCreate,
  edgeUpdate,
  edgeDelete,
  merge,
  viewSet,
])
export type GraphOp = z.infer<typeof GraphOpSchema>

export const GraphResultSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  suggestion: z.record(z.string(), z.unknown()).optional(),
})
export type GraphResult = z.infer<typeof GraphResultSchema>
