import type { DocPayload, InverseOp, Op, OpResult } from "@tenon-protocol/chart"
import { inverseOf } from "@tenon-protocol/chart"
import { docs } from "@/lib/api/docs"
import type { HumanOpEvent } from "@/lib/chart/ChartController"

export interface HumanJournalRecord {
  envelope: Record<string, unknown>
  result: OpResult
  inverse: InverseOp[]
  snapshot: DocPayload
}

type RecordFn = (docId: string, records: HumanJournalRecord[]) => Promise<unknown>

export interface HumanJournalOptions {
  docId: string
  onRecorded?: () => void
  onError?: (message: string) => void
  /** Injectable for tests. */
  recordFn?: RecordFn
  flushDelayMs?: number
  retryDelayMs?: number
}

function describe(op: Op): { type: string; target: { kind: string; id?: string } } {
  switch (op.op) {
    case "draw":
      return { type: "chart.shape.create", target: { kind: "chart.shape" } }
    case "update":
      return { type: "chart.shape.update", target: { kind: "chart.shape", id: op.id } }
    case "remove":
      return { type: "chart.shape.delete", target: { kind: "chart.shape", id: op.id } }
    case "clear":
      return { type: "chart.shape.clear", target: { kind: "chart.shape" } }
    case "add_series":
      return { type: "chart.series.upsert", target: { kind: "chart.series", id: op.id } }
    case "remove_series":
      return { type: "chart.series.delete", target: { kind: "chart.series", id: op.id } }
    case "set_view":
      return { type: "chart.view.set", target: { kind: "chart.view" } }
  }
}

/**
 * Records human edits after the adapter has applied them locally. The queue is retried with the
 * same idempotency keys; the server never dispatches these back to the browser.
 */
export class HumanJournalRecorder {
  private readonly queue: HumanJournalRecord[] = []
  private readonly docId: string
  private readonly onRecorded?: () => void
  private readonly onError?: (message: string) => void
  private readonly recordFn: RecordFn
  private readonly flushDelayMs: number
  private readonly retryDelayMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false

  constructor(options: HumanJournalOptions) {
    this.docId = options.docId
    this.onRecorded = options.onRecorded
    this.onError = options.onError
    this.recordFn = options.recordFn ?? ((docId, records) => docs.record(docId, records))
    this.flushDelayMs = options.flushDelayMs ?? 150
    this.retryDelayMs = options.retryDelayMs ?? 2000
  }

  record(event: HumanOpEvent): void {
    if (!event.result.ok || event.op.op === "set_view") return
    const { type, target } = describe(event.op)
    this.queue.push({
      envelope: {
        v: 1,
        doc_id: this.docId,
        turn_id: event.turnId,
        seq: 0,
        actor: { kind: "human", id: "local" },
        capability: "cap_human",
        type,
        target,
        payload: { op: event.op },
        rationale: "human edit",
        idempotency_key: `human_${crypto.randomUUID()}`,
        created_at: new Date().toISOString(),
      },
      result: event.result,
      inverse: inverseOf(event.before, event.after),
      snapshot: event.after,
    })
    this.schedule()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.flush()
  }

  private schedule(delay = this.flushDelayMs): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delay)
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    const batch = this.queue.splice(0, this.queue.length)
    try {
      await this.recordFn(this.docId, batch)
      this.onRecorded?.()
    } catch (cause) {
      this.queue.unshift(...batch)
      this.onError?.((cause as Error).message)
      this.schedule(this.retryDelayMs)
    } finally {
      this.flushing = false
      if (this.queue.length > 0 && !this.timer) this.schedule()
    }
  }
}
