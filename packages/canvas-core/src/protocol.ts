import { z } from "zod"

/**
 * Tenon protocol v1 schemas.
 *
 * These are the executable form of `spec/protocol.md`. JSON Schemas in `spec/schemas/`
 * are generated from this file (`npm run schemas`), so the document and the code cannot
 * drift.
 *
 * Two rules shape the schemas:
 *  - the envelope is loose (unknown fields are preserved for forward compatibility);
 *  - domain payloads are opaque here and strict in the adapter (closed enums, no raw HTML).
 */

export const PROTOCOL_VERSION = 1

const Id = z.string().min(1).max(128)
const IsoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/, "expected an RFC 3339 UTC timestamp")

/** `<domain>.<object>.<verb>`, e.g. `chart.shape.create`. */
export const OpTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){2,}$/, "expected <domain>.<object>.<verb>")
export type OpType = z.infer<typeof OpTypeSchema>

export const ACTOR_KINDS = ["human", "agent", "system"] as const
export const ActorSchema = z.looseObject({
  kind: z.enum(ACTOR_KINDS),
  id: Id,
  model: z.string().min(1).max(128).optional(),
  session: z.string().min(1).max(128).optional(),
})
export type Actor = z.infer<typeof ActorSchema>

export const TargetSchema = z.strictObject({
  kind: z.string().min(1).max(64),
  id: Id.optional(),
})
export type Target = z.infer<typeof TargetSchema>

// ── Envelope ─────────────────────────────────────────────────────────────────

const EnvelopeObject = z.looseObject({
  v: z.literal(PROTOCOL_VERSION),
  /** Server-assigned on accept; clients must omit it. */
  op_id: Id.optional(),
  doc_id: Id,
  turn_id: Id,
  seq: z.number().int().positive(),
  actor: ActorSchema,
  capability: Id,
  type: OpTypeSchema,
  target: TargetSchema,
  anchor_space: z.string().min(1).max(64).optional(),
  payload: z.record(z.string(), z.unknown()),
  rationale: z.string().max(500).optional(),
  idempotency_key: z.string().min(1).max(256),
  expected_revision: z.number().int().nonnegative().optional(),
  approval: Id.optional(),
  created_at: IsoUtc,
})

/** Last segment of an op type: `chart.shape.create` → `create`. */
export function opVerb(type: string): string {
  const index = type.lastIndexOf(".")
  return index < 0 ? type : type.slice(index + 1)
}

const VERBS_WITHOUT_TARGET_ID = new Set(["create", "set", "upsert"])
const VERBS_REQUIRING_TARGET_ID = new Set(["update", "delete", "patch"])

export const EnvelopeSchema = EnvelopeObject.superRefine((env, ctx) => {
  const verb = opVerb(env.type)
  if (VERBS_WITHOUT_TARGET_ID.has(verb) && env.target.id !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["target", "id"],
      message: `${verb} ops must not carry a target id`,
    })
  }
  if (VERBS_REQUIRING_TARGET_ID.has(verb) && env.target.id === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["target", "id"],
      message: `${verb} ops require a target id`,
    })
  }
})
export type Envelope = z.infer<typeof EnvelopeSchema>

/** Base (unrefined) schema, used for JSON Schema generation. */
export const EnvelopeBaseSchema = EnvelopeObject

/** A batch of envelopes, applied in order (spec §3.3). */
export const BatchSchema = z.object({
  ops: z.array(EnvelopeSchema).min(1).max(200),
})
export type Batch = z.infer<typeof BatchSchema>

// ── Ack ──────────────────────────────────────────────────────────────────────

export const ACK_STATUSES = ["applied", "rejected"] as const
export const AckStatusSchema = z.enum(ACK_STATUSES)

export const REJECTION_CODES = [
  "invalid_op",
  "unknown_op_type",
  "unknown_target",
  "duplicate_object_id",
  "revision_conflict",
  "idempotency_conflict",
  "capability_denied",
  "capability_expired",
  "approval_required",
  "approval_invalid",
  "anchor_out_of_range",
  "object_limit",
  "payload_too_large",
  "already_undone",
  "internal",
] as const
export const RejectionCodeSchema = z.enum(REJECTION_CODES)
export type RejectionCode = z.infer<typeof RejectionCodeSchema>

const AckObject = z.looseObject({
  v: z.literal(PROTOCOL_VERSION),
  op_id: Id,
  turn_id: Id,
  seq: z.number().int().positive(),
  status: AckStatusSchema,
  revision: z.number().int().nonnegative(),
  replayed: z.boolean().optional(),
  rejected_by: z.enum(["server", "adapter"]).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  /** Domain ops (no envelope) that undo this op, in reverse application order. */
  inverse: z.array(z.record(z.string(), z.unknown())).optional(),
  code: RejectionCodeSchema.optional(),
  message: z.string().min(1).max(500).optional(),
  retryable: z.boolean().optional(),
  suggestion: z.record(z.string(), z.unknown()).optional(),
})

export const AckSchema = AckObject.superRefine((ack, ctx) => {
  if (ack.status === "applied") {
    if (ack.code !== undefined) {
      ctx.addIssue({ code: "custom", path: ["code"], message: "applied acks must not carry a code" })
    }
    return
  }
  for (const field of ["rejected_by", "code", "message", "retryable"] as const) {
    if (ack[field] === undefined) {
      ctx.addIssue({ code: "custom", path: [field], message: `rejected acks require ${field}` })
    }
  }
})
export type Ack = z.infer<typeof AckSchema>

/** Base (unrefined) schema, used for JSON Schema generation. */
export const AckBaseSchema = AckObject

export const AckResponseSchema = z.object({ acks: z.array(AckSchema) })
export type AckResponse = z.infer<typeof AckResponseSchema>

// ── Turns ────────────────────────────────────────────────────────────────────

export const TurnSchema = z.looseObject({
  turn_id: Id,
  doc_id: Id,
  actor: ActorSchema,
  started_at: IsoUtc,
  ended_at: IsoUtc.optional(),
  op_ids: z.array(Id),
  /** Set when this turn is an undo of another turn. */
  undoes: Id.optional(),
  /** Set when another turn undid this one. */
  undone_by: Id.optional(),
})
export type Turn = z.infer<typeof TurnSchema>

// ── Capabilities ─────────────────────────────────────────────────────────────

export const PERMISSIONS = ["read", "propose", "apply", "undo", "export"] as const
export const PermissionSchema = z.enum(PERMISSIONS)

export const CapabilityClaimsSchema = z.looseObject({
  v: z.literal(PROTOCOL_VERSION),
  cap_id: Id,
  iss: Id,
  sub: z.strictObject({
    actor_id: Id,
    session: Id.optional(),
  }),
  documents: z.array(z.string().min(1)).min(1),
  op_types: z.array(z.string().min(1)).min(1),
  permissions: z.array(PermissionSchema).min(1),
  approval: z
    .strictObject({
      mode: z.enum(["auto", "human"]),
      op_types: z.array(z.string().min(1)).default([]),
    })
    .default({ mode: "auto", op_types: [] }),
  issued_at: IsoUtc,
  expires_at: IsoUtc,
})
export type CapabilityClaims = z.infer<typeof CapabilityClaimsSchema>

/** `*` matches exactly one dotted segment; a segment may also end in `*` (e.g. `doc_*`). */
export function matchesPattern(pattern: string, value: string): boolean {
  const p = pattern.split(".")
  const v = value.split(".")
  if (p.length !== v.length) return false
  return p.every((segment, index) => segmentMatches(segment, v[index]!))
}

function segmentMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1))
  return pattern === value
}

// ── Audit ────────────────────────────────────────────────────────────────────

export const AUDIT_STATUSES = ["applied", "rejected"] as const

export const AuditEntrySchema = z.looseObject({
  v: z.literal(PROTOCOL_VERSION),
  doc_id: Id,
  /** 1-based, gapless. */
  seq: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  op_id: Id,
  turn_id: Id,
  status: z.enum(AUDIT_STATUSES),
  actor: ActorSchema,
  capability: Id,
  type: OpTypeSchema,
  target: TargetSchema,
  rationale: z.string().max(500).optional(),
  created_at: IsoUtc,
  prev_hash: z.string().regex(/^[a-z0-9]+:[0-9a-f]{64}$/),
  hash: z.string().regex(/^[a-z0-9]+:[0-9a-f]{64}$/),
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>

// ── Undo ─────────────────────────────────────────────────────────────────────

export const UndoRequestSchema = z.object({
  /** Actor performing the undo (usually the human, not the original agent). */
  actor: ActorSchema,
  rationale: z.string().max(500).optional(),
})
export type UndoRequest = z.infer<typeof UndoRequestSchema>

export const UndoResponseSchema = z.object({
  turn: TurnSchema,
  acks: z.array(AckSchema),
})
export type UndoResponse = z.infer<typeof UndoResponseSchema>
