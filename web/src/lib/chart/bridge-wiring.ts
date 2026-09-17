import { bridge, onStreamEvent, type ChartSyncPayload } from "@/lib/api/bridge"
import type { ChartController } from "./ChartController"

export interface BridgeWiringOptions {
  controller: ChartController
  chartId: string
  /** False in demo mode: no attach, no sync, no op handling. */
  enabled: () => boolean
  context: () => { symbol: string; interval: string } | null
  onAgentError?: (message: string) => void
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
      const result = opts.controller.applyOp(op, "agent op")
      void bridge.opAck(requestId, result)
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
