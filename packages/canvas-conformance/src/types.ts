import type {
  Ack,
  Actor,
  AuditEntry,
  AuditVerification,
  CapabilityClaims,
  Turn,
} from "@tenon-protocol/core"

/** Document-space point. The conformance domain is a minimal 2D object model. */
export interface Point {
  x: number
  y: number
}

/** Linear viewport: `screen = point * scale + pan`. */
export interface Viewport {
  scaleX: number
  scaleY: number
  panX: number
  panY: number
}

export interface SeedObject {
  id: string
  type: string
  data: Point
}

export interface DocSeed {
  objects?: SeedObject[]
  capabilities?: CapabilityClaims[]
}

export interface DocSnapshot {
  revision: number
  objects: SeedObject[]
}

/**
 * What an implementation must provide to be conformance-tested. The same six fixtures can be
 * driven by a Rust harness that implements this shape.
 *
 * The target is responsible for the protocol spine (ids, revisions, idempotency, capabilities,
 * audit) *and* the minimal domain used by the fixtures (`obj.point.create/update/delete`, `obj.viewport.set`).
 */
export interface ConformanceTarget {
  reset(seed: DocSeed): Promise<void> | void
  apply(envelope: unknown): Promise<Ack> | Ack
  undo(turnId: string, actor: Actor, capability: string): Promise<{ turn?: Turn; acks: Ack[] }> | { turn?: Turn; acks: Ack[] }
  snapshot(): DocSnapshot
  project(point: Point, viewport: Viewport): Point
  unproject(screen: Point, viewport: Viewport): Point
  audit(): readonly AuditEntry[]
  verifyAudit(): AuditVerification
  /** Test-only hook: deliberately corrupt one audit entry to prove tamper detection. */
  tamperAudit?(index: number, patch: Record<string, unknown>): void
}

export type CaseKind =
  | "anchor_survival"
  | "undo_redo"
  | "idempotent_retry"
  | "capability_denial"
  | "malformed_op"
  | "audit_chain"

export interface OpShorthand {
  type: string
  target?: { kind: string; id?: string }
  payload?: Record<string, unknown>
  /** Defaults to the step index, e.g. `turn_1`. */
  turn?: string
  /** Defaults to 1. */
  seq?: number
  capability?: string
  actor?: Actor
  approval?: string
  rationale?: string
  /** Defaults to `${turn}:${seq}`. Set explicitly to test key collisions. */
  idempotency_key?: string
}

export interface ApplyExpectation {
  status: "applied" | "rejected"
  code?: string
  revision?: number
  replayed?: boolean
  objectId?: string
}

export type Step =
  | { kind: "apply"; op: OpShorthand; expect: ApplyExpectation }
  | { kind: "apply_raw"; envelope: Record<string, unknown>; expect: ApplyExpectation }
  | {
      kind: "snapshot"
      expect: { revision?: number; objectCount?: number; objectIds?: string[]; data?: Record<string, Point> }
    }
  | { kind: "undo"; turn: string; expect: { status: "applied" | "rejected"; code?: string; revision?: number } }
  | { kind: "verify_audit"; expect: { ok: boolean; brokenAt?: number; length?: number } }
  | { kind: "tamper_audit"; index: number; patch: Record<string, unknown> }
  | { kind: "project"; point: Point; viewport: Viewport; expect: Point }
  | { kind: "unproject"; screen: Point; viewport: Viewport; expect: Point }

export interface Fixture {
  id: string
  kind: CaseKind
  title: string
  description?: string
  docId?: string
  setup?: DocSeed
  actor?: Actor
  capability?: string
  /** Capability used for undo steps; defaults to `capability`. Human undo usually needs its own. */
  undoCapability?: string
  steps: Step[]
}

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

export interface CaseResult {
  id: string
  kind: CaseKind
  title: string
  ok: boolean
  checks: Check[]
}
