import { createHash } from "node:crypto"
import {
  EnvelopeSchema,
  GENESIS_HASH,
  canonicalJson,
  hashAuditEntry,
  matchesPattern,
  verifyAuditChain,
  type Ack,
  type Actor,
  type AuditEntry,
  type AuditVerification,
  type CapabilityClaims,
  type Envelope,
  type HashFn,
  type Turn,
} from "@tenon-protocol/core"
import type { ConformanceTarget, DocSeed, DocSnapshot, Point, SeedObject, Viewport } from "./types.ts"

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex")
const ALG = "sha256"

interface LoggedOp {
  opId: string
  turnId: string
  seq: number
  inverse: Array<Record<string, unknown>>
}

interface Rejection {
  code: Ack["code"]
  message: string
  retryable: boolean
  rejectedBy: "server" | "adapter"
  suggestion?: Record<string, unknown>
}

/**
 * The executable form of the protocol, used to run the conformance fixtures.
 *
 * It is deliberately small: a 2D object model (`obj.point.create/update/delete`) plus `obj.viewport.set`.
 * The chart adapter maps its own vocabulary onto the same protocol spine. This target is not
 * the production server; it exists so the spec can be tested before `tenon-server` exists.
 */
export class MemoryTarget implements ConformanceTarget {
  private docId = "doc_conformance"
  private revision = 0
  private objects = new Map<string, SeedObject>()
  private capabilities = new Map<string, CapabilityClaims>()
  private idempotency = new Map<string, { fingerprint: string; ack: Ack }>()
  private auditEntries: AuditEntry[] = []
  private turns = new Map<string, Turn>()
  private log: LoggedOp[] = []
  private counter = 0
  private undoCounter = 0
  private viewport: Viewport = { scaleX: 1, scaleY: 1, panX: 0, panY: 0 }
  private readonly now: () => Date
  private readonly hash: HashFn

  constructor(options: { now?: () => Date; hash?: HashFn } = {}) {
    this.now = options.now ?? (() => new Date())
    this.hash = options.hash ?? sha256
  }

  reset(seed: DocSeed = {}): void {
    this.revision = 0
    this.objects = new Map((seed.objects ?? []).map((object) => [object.id, { ...object, data: { ...object.data } }]))
    this.capabilities = new Map((seed.capabilities ?? []).map((claims) => [claims.cap_id, claims]))
    this.idempotency.clear()
    this.auditEntries = []
    this.turns.clear()
    this.log = []
    this.counter = 0
    this.undoCounter = 0
    this.viewport = { scaleX: 1, scaleY: 1, panX: 0, panY: 0 }
  }

  apply(raw: unknown): Ack {
    const parsed = EnvelopeSchema.safeParse(raw)
    if (!parsed.success) {
      return this.invalidAck(raw, parsed.error.issues.map((issue) => issue.message).join("; "))
    }
    const envelope = parsed.data

    if (envelope.doc_id !== this.docId) {
      return this.reject(envelope, {
        code: "unknown_target",
        message: `unknown document ${envelope.doc_id}`,
        retryable: false,
        rejectedBy: "server",
      })
    }

    const capabilityRejection = this.checkCapability(envelope)
    if (capabilityRejection) return this.reject(envelope, capabilityRejection)

    const fingerprint = canonicalJson({ ...envelope, op_id: undefined })
    const cached = this.idempotency.get(envelope.idempotency_key)
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        return this.reject(envelope, {
          code: "idempotency_conflict",
          message: "the idempotency key was already used with a different payload",
          retryable: false,
          rejectedBy: "server",
        })
      }
      return { ...cached.ack, replayed: true }
    }

    const outcome = this.dispatch(envelope)
    if ("code" in outcome) return this.reject(envelope, outcome)

    const opId = `op_${++this.counter}`
    const bumps = envelope.type !== "obj.viewport.set"
    if (bumps) this.revision += 1
    const ack: Ack = {
      v: 1,
      op_id: opId,
      turn_id: envelope.turn_id,
      seq: envelope.seq,
      status: "applied",
      revision: this.revision,
      result: outcome.result,
      inverse: outcome.inverse,
    }

    this.journal(envelope, opId, "applied")
    this.recordTurn(envelope, opId)
    this.log.push({ opId, turnId: envelope.turn_id, seq: envelope.seq, inverse: outcome.inverse })
    this.idempotency.set(envelope.idempotency_key, { fingerprint, ack })
    return ack
  }

  undo(turnId: string, actor: Actor, capability: string): { turn?: Turn; acks: Ack[] } {
    const turn = this.turns.get(turnId)
    if (!turn) {
      return {
        acks: [this.undoRejection(turnId, actor, capability, "unknown_target", `no turn ${turnId}`)],
      }
    }
    if (turn.undone_by) {
      return {
        acks: [
          this.undoRejection(
            turnId,
            actor,
            capability,
            "already_undone",
            `turn ${turnId} was already undone by ${turn.undone_by}`,
          ),
        ],
      }
    }

    const inverses = this.log
      .filter((entry) => entry.turnId === turnId)
      .sort((a, b) => a.seq - b.seq)
      .flatMap((entry) => [...entry.inverse].reverse())
      .reverse()

    const undoTurnId = `turn_undo_${++this.undoCounter}`
    const createdAt = this.now().toISOString().replace(/\.\d{3}Z$/, "Z")
    const acks: Ack[] = []
    inverses.forEach((inverse, index) => {
      const envelope = {
        v: 1,
        doc_id: this.docId,
        turn_id: undoTurnId,
        seq: index + 1,
        actor,
        capability,
        type: inverse.type,
        target: inverse.target,
        payload: inverse.payload ?? {},
        rationale: `undo of ${turnId}`,
        idempotency_key: `${undoTurnId}:${index + 1}`,
        created_at: createdAt,
      }
      acks.push(this.apply(envelope))
    })

    const undoTurn = this.turns.get(undoTurnId)
    if (undoTurn) undoTurn.undoes = turnId
    if (acks.every((ack) => ack.status === "applied")) turn.undone_by = undoTurnId
    return { turn: undoTurn, acks }
  }

  snapshot(): DocSnapshot {
    return {
      revision: this.revision,
      objects: [...this.objects.values()]
        .map((object) => ({ ...object, data: { ...object.data } }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }
  }

  project(point: Point, viewport: Viewport): Point {
    return { x: point.x * viewport.scaleX + viewport.panX, y: point.y * viewport.scaleY + viewport.panY }
  }

  unproject(screen: Point, viewport: Viewport): Point {
    return { x: (screen.x - viewport.panX) / viewport.scaleX, y: (screen.y - viewport.panY) / viewport.scaleY }
  }

  audit(): readonly AuditEntry[] {
    return this.auditEntries
  }

  verifyAudit(): AuditVerification {
    return verifyAuditChain(this.auditEntries, this.hash, ALG)
  }

  tamperAudit(index: number, patch: Record<string, unknown>): void {
    const entry = this.auditEntries[index]
    if (!entry) throw new Error(`no audit entry at ${index}`)
    this.auditEntries[index] = { ...entry, ...patch } as AuditEntry
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private dispatch(
    envelope: Envelope,
  ):
    | { result: Record<string, unknown>; inverse: Array<Record<string, unknown>> }
    | Rejection {
    switch (envelope.type) {
      case "obj.point.create": {
        const id = envelope.payload.id
        const data = envelope.payload.data
        if (typeof id !== "string" || id.length === 0) {
          return { code: "invalid_op", message: "obj.point.create requires payload.id", retryable: false, rejectedBy: "adapter" }
        }
        if (!isPoint(data)) {
          return { code: "invalid_op", message: "obj.point.create requires payload.data {x,y}", retryable: false, rejectedBy: "adapter" }
        }
        if (this.objects.has(id)) {
          return { code: "duplicate_object_id", message: `object ${id} already exists`, retryable: false, rejectedBy: "adapter" }
        }
        this.objects.set(id, { id, type: envelope.target.kind, data: { ...data } })
        return {
          result: { object_id: id },
          inverse: [{ type: "obj.point.delete", target: { kind: envelope.target.kind, id }, payload: {} }],
        }
      }
      case "obj.point.update": {
        const id = envelope.target.id!
        const existing = this.objects.get(id)
        if (!existing) {
          return { code: "unknown_target", message: `no object ${id}`, retryable: false, rejectedBy: "adapter" }
        }
        const data = envelope.payload.data
        if (!isPoint(data)) {
          return { code: "invalid_op", message: "obj.point.update requires payload.data {x,y}", retryable: false, rejectedBy: "adapter" }
        }
        const previous = { ...existing.data }
        existing.data = { ...data }
        return {
          result: { object_id: id },
          inverse: [{ type: "obj.point.update", target: { kind: existing.type, id }, payload: { data: previous } }],
        }
      }
      case "obj.point.delete": {
        const id = envelope.target.id!
        const existing = this.objects.get(id)
        if (!existing) {
          return { code: "unknown_target", message: `no object ${id}`, retryable: false, rejectedBy: "adapter" }
        }
        this.objects.delete(id)
        return {
          result: { object_id: id },
          inverse: [{ type: "obj.point.create", target: { kind: existing.type }, payload: { id, data: existing.data } }],
        }
      }
      case "obj.viewport.set": {
        const view = envelope.payload.viewport
        if (!isViewport(view)) {
          return { code: "invalid_op", message: "obj.viewport.set requires payload.viewport", retryable: false, rejectedBy: "adapter" }
        }
        this.viewport = { ...view }
        return { result: { viewport: this.viewport }, inverse: [] }
      }
      default:
        return {
          code: "unknown_op_type",
          message: `no handler for ${envelope.type}`,
          retryable: false,
          rejectedBy: "server",
        }
    }
  }

  private checkCapability(envelope: Envelope): Rejection | null {
    const claims = this.capabilities.get(envelope.capability)
    if (!claims) {
      return { code: "capability_denied", message: "unknown capability", retryable: false, rejectedBy: "server" }
    }
    if (new Date(claims.expires_at).getTime() <= this.now().getTime()) {
      return { code: "capability_expired", message: "capability expired", retryable: true, rejectedBy: "server" }
    }
    if (claims.sub.actor_id !== envelope.actor.id) {
      return { code: "capability_denied", message: "capability is bound to another actor", retryable: false, rejectedBy: "server" }
    }
    if (claims.sub.session && envelope.actor.session && claims.sub.session !== envelope.actor.session) {
      return { code: "capability_denied", message: "capability is bound to another session", retryable: false, rejectedBy: "server" }
    }
    if (!claims.documents.some((pattern) => matchesPattern(pattern, envelope.doc_id))) {
      return { code: "capability_denied", message: "document is outside the capability scope", retryable: false, rejectedBy: "server" }
    }
    if (!claims.op_types.some((pattern) => matchesPattern(pattern, envelope.type))) {
      return { code: "capability_denied", message: "op type is outside the capability scope", retryable: false, rejectedBy: "server" }
    }
    if (!claims.permissions.includes("apply")) {
      if (claims.permissions.includes("propose")) {
        return {
          code: "approval_required",
          message: "this capability may propose but not apply",
          retryable: true,
          rejectedBy: "server",
          suggestion: { approval_id: `appr_${envelope.op_id ?? envelope.idempotency_key}` },
        }
      }
      return { code: "capability_denied", message: "capability has no apply permission", retryable: false, rejectedBy: "server" }
    }
    if (claims.approval.mode === "human" && claims.approval.op_types.some((pattern) => matchesPattern(pattern, envelope.type))) {
      if (!envelope.approval) {
        return {
          code: "approval_required",
          message: "this op needs human approval",
          retryable: true,
          rejectedBy: "server",
          suggestion: { approval_id: `appr_${envelope.idempotency_key}` },
        }
      }
      if (envelope.approval !== `appr_${envelope.idempotency_key}`) {
        return { code: "approval_invalid", message: "approval does not match this op", retryable: false, rejectedBy: "server" }
      }
    }
    return null
  }

  private undoRejection(
    turnId: string,
    actor: Actor,
    capability: string,
    code: Ack["code"],
    message: string,
  ): Ack {
    const envelope: Envelope = {
      v: 1,
      doc_id: this.docId,
      turn_id: turnId,
      seq: 1,
      actor,
      capability,
      type: "obj.point.undo",
      target: { kind: "turn", id: turnId },
      payload: {},
      idempotency_key: `undo:${turnId}:${++this.counter}`,
      created_at: this.now().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }
    return this.reject(envelope, { code, message, retryable: false, rejectedBy: "server" })
  }

  private reject(envelope: Envelope, rejection: Rejection): Ack {
    const opId = `op_${++this.counter}`
    this.journal(envelope, opId, "rejected")
    return {
      v: 1,
      op_id: opId,
      turn_id: envelope.turn_id,
      seq: envelope.seq,
      status: "rejected",
      revision: this.revision,
      rejected_by: rejection.rejectedBy,
      code: rejection.code,
      message: rejection.message,
      retryable: rejection.retryable,
      ...(rejection.suggestion ? { suggestion: rejection.suggestion } : {}),
    }
  }

  private invalidAck(raw: unknown, message: string): Ack {
    const record = (raw ?? {}) as Record<string, unknown>
    return {
      v: 1,
      op_id: `op_invalid_${++this.counter}`,
      turn_id: typeof record.turn_id === "string" ? record.turn_id : "turn_invalid",
      seq: typeof record.seq === "number" ? record.seq : 1,
      status: "rejected",
      revision: this.revision,
      rejected_by: "server",
      code: "invalid_op",
      message: message || "invalid envelope",
      retryable: false,
    }
  }

  private journal(envelope: Envelope, opId: string, status: "applied" | "rejected"): void {
    const previous = this.auditEntries[this.auditEntries.length - 1]?.hash ?? GENESIS_HASH
    const body = {
      v: 1 as const,
      doc_id: envelope.doc_id,
      seq: this.auditEntries.length + 1,
      revision: this.revision,
      op_id: opId,
      turn_id: envelope.turn_id,
      status,
      actor: envelope.actor,
      capability: envelope.capability,
      type: envelope.type,
      target: envelope.target,
      ...(envelope.rationale ? { rationale: envelope.rationale } : {}),
      created_at: envelope.created_at,
    }
    const hash = hashAuditEntry(previous, body, this.hash, ALG)
    this.auditEntries.push({ ...body, prev_hash: previous, hash })
  }

  private recordTurn(envelope: Envelope, opId: string): void {
    let turn = this.turns.get(envelope.turn_id)
    if (!turn) {
      turn = {
        turn_id: envelope.turn_id,
        doc_id: envelope.doc_id,
        actor: envelope.actor,
        started_at: envelope.created_at,
        op_ids: [],
      }
      this.turns.set(envelope.turn_id, turn)
    }
    turn.op_ids.push(opId)
    turn.ended_at = envelope.created_at
  }
}

function isPoint(value: unknown): value is Point {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as Point).x) &&
    Number.isFinite((value as Point).y)
  )
}

function isViewport(value: unknown): value is Viewport {
  if (typeof value !== "object" || value === null) return false
  const view = value as Viewport
  return [view.scaleX, view.scaleY, view.panX, view.panY].every((n) => Number.isFinite(n)) && view.scaleX !== 0 && view.scaleY !== 0
}
