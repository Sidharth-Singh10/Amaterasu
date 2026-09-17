import {
  CAPS,
  MIN_POINTS,
  OpSchema,
  type AddSeriesOp,
  type Anchor,
  type Annotation,
  type ClearOp,
  type DrawOp,
  type Op,
  type OpResult,
  type RemoveSeriesOp,
  type Series,
  type SetViewOp,
  type UpdateOp,
} from "@amaterasu/chart-dsl"

/**
 * Single write path for mouse input, agent ops, and imports. Snapshot-based undo:
 * the document is a few KB of JSON, so whole-state snapshots beat inverse ops and make
 * "undo one agent turn" trivial (beginTurn / commitTurn / abortTurn).
 */

export interface DocState {
  v: 1
  annotations: Annotation[]
  series: Series[]
}

export interface AnchorCheck {
  ok: boolean
  reason?: string
  warnings: string[]
}

export interface DocDeps {
  /** Resolvability check against the currently loaded data window. */
  checkAnchor: (a: Anchor) => AnchorCheck
  /** Handler for view ops; the chart layer owns the actual scale mutations. */
  onView?: (op: SetViewOp) => OpResult
  now?: () => number
  newId?: () => string
}

type MutatingOp = Exclude<Op, { op: "set_view" }>

export class DocStore {
  private state: DocState = { v: 1, annotations: [], series: [] }
  private undoStack: DocState[] = []
  private redoStack: DocState[] = []
  private turn: { snapshot: DocState } | null = null
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly deps: DocDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  get annotations(): readonly Annotation[] {
    return this.state.annotations
  }

  get series(): readonly Series[] {
    return this.state.series
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  beginTurn(): void {
    if (this.turn) throw new Error("a turn is already open")
    this.turn = { snapshot: structuredClone(this.state) }
  }

  /** Ends the turn: the pre-turn snapshot becomes one undo step. */
  commitTurn(): void {
    if (!this.turn) return
    this.undoStack.push(this.turn.snapshot)
    this.turn = null
    this.redoStack = []
  }

  /** Ends the turn without keeping an undo step. */
  abortTurn(): void {
    if (!this.turn) return
    this.state = this.turn.snapshot
    this.turn = null
  }

  undo(): boolean {
    const prev = this.undoStack.pop()
    if (!prev) return false
    this.redoStack.push(structuredClone(this.state))
    this.state = prev
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push(structuredClone(this.state))
    this.state = next
    return true
  }

  applyOp(raw: unknown): OpResult {
    const parsed = OpSchema.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")
      return { ok: false, warnings: [`invalid op: ${detail}`] }
    }
    const op = parsed.data
    if (op.op === "set_view") {
      return this.deps.onView ? this.deps.onView(op) : { ok: false, warnings: ["no view controller attached"] }
    }

    const autoTurn = this.turn == null
    if (autoTurn) this.undoStack.push(structuredClone(this.state))
    const result = this.mutate(op)
    if (result.ok) {
      this.redoStack = []
    } else if (autoTurn) {
      this.undoStack.pop() // no mutation happened; keep history clean
    }
    return result
  }

  private mutate(op: MutatingOp): OpResult {
    switch (op.op) {
      case "draw":
        return this.draw(op)
      case "update":
        return this.update(op)
      case "remove":
        return this.remove(op)
      case "clear":
        return this.clear(op)
      case "add_series":
        return this.addSeries(op)
      case "remove_series":
        return this.removeSeries(op)
    }
  }

  private checkAnchors(points: readonly Anchor[]): { unresolved: string[]; warnings: string[] } {
    const unresolved: string[] = []
    const warnings: string[] = []
    for (const anchor of points) {
      const check = this.deps.checkAnchor(anchor)
      if (!check.ok) unresolved.push(check.reason ?? "unresolved")
      warnings.push(...check.warnings)
    }
    return { unresolved, warnings }
  }

  private addSeries(op: AddSeriesOp): OpResult {
    const existing = this.state.series.find((series) => series.id === op.id)
    if (!existing && this.state.series.length >= CAPS.maxSeries) {
      return { ok: false, warnings: [`series cap (${CAPS.maxSeries}) reached`] }
    }
    const now = this.now()
    if (existing) {
      existing.name = op.name
      existing.points = op.points.map((point) => ({ ...point }))
      if (op.style) existing.style = { ...op.style }
      if (op.source) existing.source = op.source
      existing.updatedAt = now
      return { ok: true, id: existing.id }
    }
    const created: Series = {
      id: op.id,
      name: op.name,
      points: op.points.map((point) => ({ ...point })),
      style: op.style ? { ...op.style } : {},
      source: op.source,
      createdAt: now,
      updatedAt: now,
    }
    this.state.series.push(created)
    return { ok: true, id: created.id }
  }

  private removeSeries(op: RemoveSeriesOp): OpResult {
    const index = this.state.series.findIndex((series) => series.id === op.id)
    if (index < 0) return { ok: false, warnings: [`no series with id ${op.id}`] }
    this.state.series.splice(index, 1)
    return { ok: true, id: op.id }
  }

  private draw(op: DrawOp): OpResult {
    if (this.state.annotations.length >= CAPS.maxAnnotations) {
      return { ok: false, warnings: [`annotation cap (${CAPS.maxAnnotations}) reached`] }
    }
    const min = MIN_POINTS[op.kind]
    if (op.points.length < min) {
      return { ok: false, warnings: [`${op.kind} needs at least ${min} anchor(s)`] }
    }
    const { unresolved, warnings } = this.checkAnchors(op.points)
    if (unresolved.length > 0) return { ok: false, unresolved, warnings }

    const now = this.now()
    const annotation: Annotation = {
      id: this.newId(),
      kind: op.kind,
      points: op.points.map((p) => ({ ...p })),
      style: op.style ? { ...op.style } : {},
      label: op.label,
      z: op.z ?? 0,
      hidden: false,
      locked: false,
      source: op.source,
      createdAt: now,
      updatedAt: now,
    }
    this.state.annotations.push(annotation)
    return { ok: true, id: annotation.id, normalizedPoints: annotation.points, snappedTo: [], warnings }
  }

  private update(op: UpdateOp): OpResult {
    const annotation = this.state.annotations.find((a) => a.id === op.id)
    if (!annotation) return { ok: false, warnings: [`no annotation with id ${op.id}`] }

    const editsGeometry = op.points !== undefined || op.style !== undefined || op.label !== undefined
    const relocks = op.locked === true
    if (annotation.locked && (editsGeometry || op.hidden !== undefined || relocks)) {
      return { ok: false, warnings: ["annotation is locked (set locked: false to unlock first)"] }
    }

    const warnings: string[] = []
    if (op.points) {
      const min = MIN_POINTS[annotation.kind]
      if (op.points.length < min) {
        return { ok: false, warnings: [`${annotation.kind} needs at least ${min} anchor(s)`] }
      }
      const check = this.checkAnchors(op.points)
      if (check.unresolved.length > 0) return { ok: false, unresolved: check.unresolved, warnings: check.warnings }
      annotation.points = op.points.map((p) => ({ ...p }))
      warnings.push(...check.warnings)
    }
    if (op.style) annotation.style = { ...annotation.style, ...op.style }
    if (op.label !== undefined) annotation.label = op.label
    if (op.hidden !== undefined) annotation.hidden = op.hidden
    if (op.locked !== undefined) annotation.locked = op.locked
    annotation.updatedAt = this.now()
    return { ok: true, id: annotation.id, normalizedPoints: annotation.points, warnings }
  }

  private remove(op: { id: string }): OpResult {
    const index = this.state.annotations.findIndex((a) => a.id === op.id)
    if (index < 0) return { ok: false, warnings: [`no annotation with id ${op.id}`] }
    if (this.state.annotations[index].locked) {
      return { ok: false, warnings: ["annotation is locked (set locked: false to unlock first)"] }
    }
    this.state.annotations.splice(index, 1)
    return { ok: true, id: op.id }
  }

  private clear(op: ClearOp): OpResult {
    if (!op.ids && !op.kind && !op.sourceMessageID) {
      return { ok: false, warnings: ["clear requires ids, kind, or sourceMessageID"] }
    }
    const before = this.state.annotations.length
    this.state.annotations = this.state.annotations.filter((a) => {
      if (a.locked) return true
      if (op.ids && !op.ids.includes(a.id)) return true
      if (op.kind && a.kind !== op.kind) return true
      if (op.sourceMessageID && a.source?.messageID !== op.sourceMessageID) return true
      return false
    })
    const removed = before - this.state.annotations.length
    return { ok: true, warnings: removed > 0 ? [] : ["nothing matched the clear filters"] }
  }
}
