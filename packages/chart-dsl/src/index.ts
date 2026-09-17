import { z } from "zod"

/**
 * Chart op/state DSL — the single contract shared by the overlay engine (browser), the
 * OpenCode chart-bridge plugin (tool schemas), and persistence. Coordinates are always
 * data-space: `t` (canonical epoch seconds of a real bar) + `p` (price), with an optional
 * fractional `liOffset` for whitespace/projection placement. Pixels never appear here.
 */

export const DSL_VERSION = 1

// ── Geometry ─────────────────────────────────────────────────────────────────

export const AnchorSchema = z.object({
  t: z.number().finite(),
  p: z.number().finite(),
  liOffset: z.number().finite().optional(),
})
export type Anchor = z.infer<typeof AnchorSchema>

/**
 * Shapes implemented by the overlay engine. Phase 3 adds fib/channel later in the phase.
 */
export const KINDS = [
  "trendline",
  "ray",
  "hline",
  "vline",
  "rect",
  "hzone",
  "vzone",
  "marker",
  "measure",
  "fib",
  "channel",
  "label",
] as const
export const KindSchema = z.enum(KINDS)
export type Kind = z.infer<typeof KindSchema>

/** Minimum anchors a kind needs before it can be drawn. */
export const MIN_POINTS: Record<Kind, number> = {
  trendline: 2,
  ray: 2,
  hline: 1,
  vline: 1,
  rect: 2,
  hzone: 2,
  vzone: 2,
  marker: 1,
  measure: 2,
  fib: 2,
  channel: 3,
  label: 1,
}

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

export const StyleSchema = z.object({
  color: z.string().regex(HEX).optional(),
  width: z.number().min(0.5).max(8).optional(),
  dash: z.boolean().optional(),
  fill: z.string().regex(HEX).optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  fontSize: z.number().min(8).max(32).optional(),
  /** Marker glyph. */
  shape: z.enum(["circle", "arrowUp", "arrowDown"]).optional(),
})
export type Style = z.infer<typeof StyleSchema>

export const SourceSchema = z.object({
  sessionID: z.string().min(1),
  messageID: z.string().min(1),
  reason: z.string().max(500).optional(),
})
export type Source = z.infer<typeof SourceSchema>

export const CAPS = {
  maxAnnotations: 500,
  maxPoints: 64,
  maxLabel: 256,
  maxSeries: 12,
  maxSeriesPoints: 2500,
} as const

// ── Annotations ──────────────────────────────────────────────────────────────

export const AnnotationSchema = z.object({
  id: z.string().min(1),
  kind: KindSchema,
  points: z.array(AnchorSchema).min(1).max(CAPS.maxPoints),
  style: StyleSchema,
  label: z.string().max(CAPS.maxLabel).optional(),
  z: z.number().int(),
  hidden: z.boolean(),
  locked: z.boolean(),
  source: SourceSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Annotation = z.infer<typeof AnnotationSchema>

// ── Series (agent-computed lines: SMA/EMA/custom) ─────────────────────────────

export const SeriesPointSchema = z.object({
  t: z.number().finite(),
  v: z.number().finite(),
})
export type SeriesPoint = z.infer<typeof SeriesPointSchema>

export const SeriesStyleSchema = z.object({
  color: z.string().regex(HEX).optional(),
  width: z.number().min(0.5).max(8).optional(),
  dash: z.boolean().optional(),
})
export type SeriesStyle = z.infer<typeof SeriesStyleSchema>

export const SeriesSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  points: z.array(SeriesPointSchema).min(2).max(CAPS.maxSeriesPoints),
  style: SeriesStyleSchema,
  source: SourceSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Series = z.infer<typeof SeriesSchema>

// ── Ops ──────────────────────────────────────────────────────────────────────

export const DrawOpSchema = z.object({
  op: z.literal("draw"),
  kind: KindSchema,
  points: z.array(AnchorSchema).min(1).max(CAPS.maxPoints),
  style: StyleSchema.optional(),
  label: z.string().max(CAPS.maxLabel).optional(),
  z: z.number().int().optional(),
  /** Snap mode for the op intake; "none" (default) places points exactly as given. */
  snap: z.enum(["none", "ohlc", "swing", "level"]).optional(),
  source: SourceSchema.optional(),
})
export type DrawOp = z.infer<typeof DrawOpSchema>

export const UpdateOpSchema = z.object({
  op: z.literal("update"),
  id: z.string().min(1),
  points: z.array(AnchorSchema).min(1).max(CAPS.maxPoints).optional(),
  style: StyleSchema.optional(),
  label: z.string().max(CAPS.maxLabel).optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
})
export type UpdateOp = z.infer<typeof UpdateOpSchema>

export const RemoveOpSchema = z.object({
  op: z.literal("remove"),
  id: z.string().min(1),
})
export type RemoveOp = z.infer<typeof RemoveOpSchema>

export const ClearOpSchema = z.object({
  op: z.literal("clear"),
  ids: z.array(z.string().min(1)).optional(),
  kind: KindSchema.optional(),
  sourceMessageID: z.string().min(1).optional(),
})
export type ClearOp = z.infer<typeof ClearOpSchema>

export const SetViewOpSchema = z.object({
  op: z.literal("set_view"),
  from: z.number().optional(),
  to: z.number().optional(),
  bars: z.number().int().positive().max(2000).optional(),
  priceMin: z.number().finite().optional(),
  priceMax: z.number().finite().optional(),
  priceAuto: z.boolean().optional(),
})
export type SetViewOp = z.infer<typeof SetViewOpSchema>

/**
 * Adds or replaces a computed line series by id (upsert: re-adding the same id updates it,
 * which is how the agent refreshes an indicator).
 */
export const AddSeriesOpSchema = z.object({
  op: z.literal("add_series"),
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  points: z.array(SeriesPointSchema).min(2).max(CAPS.maxSeriesPoints),
  style: SeriesStyleSchema.optional(),
  source: SourceSchema.optional(),
})
export type AddSeriesOp = z.infer<typeof AddSeriesOpSchema>

export const RemoveSeriesOpSchema = z.object({
  op: z.literal("remove_series"),
  id: z.string().min(1),
})
export type RemoveSeriesOp = z.infer<typeof RemoveSeriesOpSchema>

export const OpSchema = z.discriminatedUnion("op", [
  DrawOpSchema,
  UpdateOpSchema,
  RemoveOpSchema,
  ClearOpSchema,
  SetViewOpSchema,
  AddSeriesOpSchema,
  RemoveSeriesOpSchema,
])
export type Op = z.infer<typeof OpSchema>

export const OpResultSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  normalizedPoints: z.array(AnchorSchema).optional(),
  snappedTo: z.array(z.string()).optional(),
  clamped: z.boolean().optional(),
  visible: z.boolean().optional(),
  unresolved: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
})
export type OpResult = z.infer<typeof OpResultSchema>
