import { bridge, onStreamEvent, type ChartSyncPayload } from "@/lib/api/bridge"
import { inverseOf } from "@common-ground/canvas-chart"
import type { ChartController } from "./ChartController"

export interface BridgeWiringOptions {
  controller: ChartController
  chartId: string
  /** False in demo mode: no attach, no sync, no op handling. */
  enabled: () => boolean
  context: () => { symbol: string; interval: string } | null
  onAgentError?: (message: string) => void
  /** Called after an op ack is finalized on the server, so history can refetch. */
  onJournalChange?: () => void
}

/**
 * Connects the browser to the chart-bridge plugin through the Rust service:
 *  - attach on start, debounced context sync (symbol/interval/visible range)
 *  - `op.request` → apply through the DocStore → `opAck`
 *  - `state.request` → answer with the chart snapshot → `stateAck`
 *  - ops from one agent message are grouped into one undo turn (committed when the
 *    agent's execution ends)
 */
export function startChartBridge(opts: BridgeWiringOptions) {
  let activeTurnMessage: string | null = null
  let syncTimer: number | undefined

  function journalChanged(): void {
    opts.onJournalChange?.()
  }

  function endTurn(): void {
    if (activeTurnMessage) {
      opts.controller.store.commitTurn()
      activeTurnMessage = null
    }
  }

  const unsubscribe = onStreamEvent((event) => {
    if (!opts.enabled()) return
    const data = event.data as Record<string, unknown> | undefined

    if (event.type === "rpc.chart.op.request") {
      if (data?.chartId !== opts.chartId) return
      const op = data.op as Record<string, unknown> | undefined
      const requestId = data.requestId as string | undefined
      if (!op || !requestId) return
      const messageID = (op.source as { messageID?: string } | undefined)?.messageID ?? null
      if (messageID && messageID !== activeTurnMessage) {
        if (activeTurnMessage) opts.controller.store.commitTurn()
        opts.controller.store.beginTurn()
        activeTurnMessage = messageID
      }
      const before = opts.controller.exportDoc()
      const result = opts.controller.applyOp(op, "agent op")
      const inverse = result.ok ? inverseOf(before, opts.controller.exportDoc()) : []
      void bridge.opAck(requestId, { ...result, inverse }).then(journalChanged, journalChanged)
      return
    }

    if (event.type === "doc.op.request") {
      if (data?.docId !== opts.chartId) return
      const opId = data.opId as string | undefined
      const envelope = data.envelope as { payload?: { op?: unknown } } | undefined
      const op = envelope?.payload?.op
      if (!op || !opId) return

      const before = opts.controller.exportDoc()
      const result = opts.controller.applyOp(op, "journal op")
      const inverse = result.ok ? inverseOf(before, opts.controller.exportDoc()) : []
      const ack: Record<string, unknown> = {
        op_id: opId,
        status: result.ok ? "applied" : "rejected",
        result,
        inverse,
      }
      if (!result.ok) {
        ack.rejected_by = "adapter"
        ack.code = result.unresolved?.length ? "anchor_out_of_range" : "invalid_op"
        ack.message = result.warnings?.join("; ") || "the chart adapter rejected the op"
        ack.retryable = false
      }
      void bridge.docAck(opts.chartId, [ack]).then(journalChanged, journalChanged)
      return
    }

    if (event.type === "rpc.chart.state.request") {
      if (data?.chartId !== opts.chartId) return
      const requestId = data?.requestId as string | undefined
      if (!requestId) return
      const snapshot = opts.controller.getSnapshot() as unknown as Record<string, unknown>
      void bridge.stateAck(requestId, snapshot)
      return
    }

    if (event.type === "session.execution.failed") {
      const message = (data?.error as { message?: string } | undefined)?.message
      if (message) opts.onAgentError?.(message)
      endTurn()
      return
    }

    if (event.type === "session.execution.succeeded") {
      endTurn()
    }
  })

  async function pushNow(): Promise<void> {
    if (!opts.enabled()) return
    const context = opts.context()
    if (!context) return
    const snapshot = opts.controller.getSnapshot()
    const visible = snapshot.visible as { from?: number; to?: number } | null
    const payload: ChartSyncPayload = {
      chartId: opts.chartId,
      symbol: context.symbol,
      interval: context.interval,
      from: visible?.from,
      to: visible?.to,
    }
    await bridge.sync(payload).catch(() => {})
  }

  async function attach(): Promise<void> {
    if (!opts.enabled()) return
    await bridge.attach(opts.chartId).catch(() => {})
    await pushNow()
  }

  function scheduleSync(): void {
    if (!opts.enabled()) return
    window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => void pushNow(), 300)
  }

  return {
    attach,
    scheduleSync,
    dispose(): void {
      unsubscribe()
      window.clearTimeout(syncTimer)
      endTurn()
    },
  }
}
