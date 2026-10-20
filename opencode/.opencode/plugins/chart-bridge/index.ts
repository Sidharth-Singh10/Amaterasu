import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

/**
 * Amaterasu chart bridge.
 *
 * Registers the `chart_*` agent tools plus a `chart` RPC that the webapp bridge (the Rust
 * service) calls: the browser attaches a chart, keeps the plugin's context in sync, and
 * answers op/state requests. Every browser round trip is request → event → ack, because
 * annotations and candle state live in the browser (the DocStore is canonical there).
 *
 * Events (plugin → bridge):
 *   op.request    { requestId, chartId, op }        apply an op through the reducer
 *   state.request { requestId, chartId }            read the chart snapshot
 * Methods (bridge → plugin):
 *   attach / detach / syncContext / opAck / stateAck
 */

const str = { type: "string" } as const
const num = { type: "number" } as const
const bool = { type: "boolean" } as const
const object = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const
const looseObject = { type: "object" } as const

const SERVER_URL = (
  (typeof process !== "undefined" ? process.env?.AMATERASU_URL : undefined) ?? "http://127.0.0.1:8787"
).replace(/\/+$/, "")
const OP_TIMEOUT_MS = 10_000
const STATE_TIMEOUT_MS = 15_000

const chartRpc = Rpc.define({
  id: "chart",
  methods: {
    attach: {
      input: object({ chartId: str }, ["chartId"]),
      output: object({ ok: bool, activeChartId: str }, ["ok", "activeChartId"]),
    },
    detach: {
      input: object({ chartId: str }, ["chartId"]),
      output: object({ ok: bool }, ["ok"]),
    },
    syncContext: {
      input: object({ chartId: str, symbol: str, interval: str, from: num, to: num }, [
        "chartId",
        "symbol",
        "interval",
      ]),
      output: object({ ok: bool }, ["ok"]),
    },
    opAck: {
      input: object({ requestId: str, result: looseObject }, ["requestId", "result"]),
      output: object({ ok: bool }, ["ok"]),
    },
    stateAck: {
      input: object({ requestId: str, result: looseObject }, ["requestId", "result"]),
      output: object({ ok: bool }, ["ok"]),
    },
  },
  events: {
    "op.request": {
      schema: object({ requestId: str, chartId: str, op: looseObject }, ["requestId", "chartId", "op"]),
    },
    "state.request": {
      schema: object({ requestId: str, chartId: str }, ["requestId", "chartId"]),
    },
  },
})

interface ChartContext {
  chartId: string
  symbol: string
  interval: string
  from?: number
  to?: number
  lastSeen: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ToolContextLike {
  progress?: (input: { status: string }) => Promise<void>
  sessionID?: string
  messageID?: string
}

interface OpSource {
  sessionID: string
  messageID: string
}

export default Plugin.define({
  id: "amaterasu.chart-bridge",
  async setup(ctx) {
    const debug = typeof process !== "undefined" && process.env?.CHART_BRIDGE_DEBUG === "1"
    const charts = new Map<string, ChartContext>()
    let activeChartId: string | null = null
    const pendingOps = new Map<string, Pending>()
    const pendingStates = new Map<string, Pending>()
    let toolContextLogged = false

    const settle = (map: Map<string, Pending>, requestId: string, value: unknown): boolean => {
      const pending = map.get(requestId)
      if (!pending) return false
      clearTimeout(pending.timer)
      map.delete(requestId)
      pending.resolve(value)
      return true
    }

    const registration = await ctx.rpc.register(chartRpc, {
      attach: async (input) => {
        const { chartId } = input as { chartId: string }
        charts.set(chartId, { chartId, symbol: "unknown", interval: "unknown", lastSeen: Date.now() })
        activeChartId = chartId
        return { ok: true, activeChartId: chartId }
      },
      detach: async (input) => {
        const { chartId } = input as { chartId: string }
        charts.delete(chartId)
        if (activeChartId === chartId) {
          const remaining = [...charts.keys()]
          activeChartId = remaining.length > 0 ? remaining[remaining.length - 1] : null
        }
        return { ok: true }
      },
      syncContext: async (input) => {
        const payload = input as { chartId: string; symbol: string; interval: string; from?: number; to?: number }
        charts.set(payload.chartId, { ...payload, lastSeen: Date.now() })
        activeChartId = payload.chartId
        return { ok: true }
      },
      opAck: async (input) => {
        const { requestId, result } = input as { requestId: string; result: unknown }
        settle(pendingOps, requestId, result)
        return { ok: true }
      },
      stateAck: async (input) => {
        const { requestId, result } = input as { requestId: string; result: unknown }
        settle(pendingStates, requestId, result)
        return { ok: true }
      },
    })

    const activeChart = (): ChartContext | null =>
      activeChartId ? (charts.get(activeChartId) ?? null) : null

    const request = (
      map: Map<string, Pending>,
      kind: "op.request" | "state.request",
      payload: Record<string, unknown>,
      timeoutMs: number,
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const chart = activeChart()
        if (!chart) {
          reject(new Error("no chart is attached — ask the user to open the chart app"))
          return
        }
        const requestId = crypto.randomUUID()
        const timer = setTimeout(() => {
          map.delete(requestId)
          reject(new Error(`the chart did not answer ${kind} within ${timeoutMs}ms`))
        }, timeoutMs)
        map.set(requestId, { resolve, reject, timer })
        void Promise.resolve(registration.events.emit(kind, { requestId, chartId: chart.chartId, ...payload })).catch(
          (error: unknown) => {
            if (map.delete(requestId)) {
              clearTimeout(timer)
              reject(error instanceof Error ? error : new Error(String(error)))
            }
          },
        )
      })

    /** Unwraps the journal ack into the OpResult shape the tools already return. */
    const opResult = (ack: unknown): unknown => {
      const record = (ack ?? {}) as Record<string, unknown>
      if (record.status === "applied") return record.result ?? { ok: true }
      if (record.status === "rejected") {
        return {
          ok: false,
          code: record.code,
          message: record.message,
          retryable: record.retryable,
          suggestion: record.suggestion,
          revision: record.revision,
        }
      }
      return record
    }

    /**
     * Pre-application submit: the journal assigns ids, checks the capability, and dispatches the
     * op to the browser as `doc.request`; the response arrives after the browser acks. Falls back
     * to the legacy RPC path if the service does not expose the endpoint.
     */
    const submitOp = async (op: Record<string, unknown>): Promise<unknown> => {
      const chart = activeChart()
      if (!chart) throw new Error("no chart is attached — ask the user to open the chart app")
      try {
        const response = await fetch(`${SERVER_URL}/api/chart/op`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chartId: chart.chartId, requestId: crypto.randomUUID(), op }),
          signal: AbortSignal.timeout(OP_TIMEOUT_MS + 10_000),
        })
        if (!response.ok) throw new Error(`the chart service returned HTTP ${response.status}`)
        const payload = (await response.json()) as { ack?: unknown }
        return opResult(payload.ack)
      } catch (error) {
        // A timeout may mean the server applied the op and lost the response. Do not fall back
        // and risk applying it twice; surface the timeout instead.
        if ((error as { name?: string }).name === "TimeoutError") throw error
        if (debug) console.warn("[chart-bridge] HTTP submit failed; falling back to RPC", error)
        return request(pendingOps, "op.request", { op }, OP_TIMEOUT_MS)
      }
    }

    const applyOp = (op: Record<string, unknown>): Promise<unknown> =>
      submitOp(op).catch((error) => ({ ok: false, error: (error as Error).message }))

    const content = (value: unknown) => ({ content: JSON.stringify(value) })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "chart",
        description: "Read the attached chart and draw annotations on it",
      })

      const add = (tool: {
        name: string
        description: string
        input: Record<string, unknown>
        execute: (input: unknown, toolContext: ToolContextLike, source?: OpSource) => Promise<{ content: string }>
      }) => {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input as never,
          options: { namespace: "chart" },
          execute: async (input, toolContext) => {
            const context = (toolContext ?? {}) as ToolContextLike
            if (debug && !toolContextLogged) {
              toolContextLogged = true
              console.log("[chart-bridge] tool context keys:", Object.keys(toolContext ?? {}))
            }
            // Traceability: the tool context carries the calling turn, so every op the
            // agent draws can be stamped with its real originating session/message.
            const source =
              context.sessionID && context.messageID
                ? { sessionID: context.sessionID, messageID: context.messageID }
                : undefined
            return (await tool.execute(input, context, source)) as never
          },
        })
      }

      add({
        name: "get_state",
        description:
          "Read the chart the user is looking at: instrument, interval, recent candles (time in Unix seconds with OHLCV), the visible time and price range, and the annotations already drawn. Call this before any analysis.",
        input: object({}, []),
        execute: async (_input, tool) => {
          await tool.progress?.({ status: "reading chart state" })
          try {
            return content(await request(pendingStates, "state.request", {}, STATE_TIMEOUT_MS))
          } catch (error) {
            return content({ ok: false, error: (error as Error).message })
          }
        },
      })

      add({
        name: "draw",
        description:
          "Draw annotations on the chart. Points are data coordinates { t: bar time in Unix seconds, p: price }. Kinds: trendline (2 points), ray (2 points), hline (1 point, price level), vline (1 point, time), rect (2 points), hzone (2 points, price band across the chart — supply/demand), vzone (2 points, time band), marker (1 point, event glyph), measure (2 points, Δ badge), fib (2 points — a real retracement shape with 7 labelled levels; never compose one from hlines), channel (3 points — parallel rails: 0-1 is the first rail, 2 sets the offset; never compose one from two trendlines), label (1 point, text). Set `snap` (\"ohlc\" | \"swing\" | \"level\") to place points on structure instead of exact values. Returns the created annotation ids.",
        input: object(
          {
            shapes: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: object(
                {
                  kind: {
                    type: "string",
                    enum: [
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
                    ],
                  },
                  points: {
                    type: "array",
                    minItems: 1,
                    maxItems:  64,
                    items: object({ t: num, p: num, liOffset: num }, ["t", "p"]),
                  },
                  label: str,
                  color: str,
                  width: num,
                  dash: bool,
                  snap: { type: "string", enum: ["none", "ohlc", "swing", "level"] },
                },
                ["kind", "points"],
              ),
            },
          },
          ["shapes"],
        ),
        execute: async (input, tool, source) => {
          await tool.progress?.({ status: "drawing on the chart" })
          const { shapes } = input as { shapes: Array<Record<string, unknown>> }
          const results: unknown[] = []
          for (const shape of shapes) {
            const { label, color, width, dash, ...rest } = shape
            const style: Record<string, unknown> = {}
            if (color) style.color = color
            if (width) style.width = width
            if (dash) style.dash = dash
            const op = {
              op: "draw",
              ...rest,
              ...(label ? { label } : {}),
              ...(Object.keys(style).length > 0 ? { style } : {}),
              ...(source ? { source } : {}),
            }
            results.push(
              await applyOp(op),
            )
          }
          return content({ ok: results.every((result) => (result as { ok?: boolean }).ok === true), results })
        },
      })

      add({
        name: "update",
        description: "Update an existing annotation by id (points, style, label, hidden, locked).",
        input: object(
          {
            id: str,
            points: {
              type: "array",
              minItems: 1,
              maxItems:  64,
              items: object({ t: num, p: num, liOffset: num }, ["t", "p"]),
            },
            label: str,
            hidden: bool,
            locked: bool,
          },
          ["id"],
        ),
        execute: async (input, _tool, source) =>
          content(
            await applyOp({ op: "update", ...(input as object), ...(source ? { source } : {}) }),
          ),
      })

      add({
        name: "remove",
        description:
          "Remove one annotation by id. Destructive ops need human approval; if the result says approval_required, tell the user to approve it in the Journal tab.",
        input: object({ id: str }, ["id"]),
        execute: async (input, _tool, source) =>
          content(
            await applyOp({
              op: "remove",
              id: (input as { id: string }).id,
              ...(source ? { source } : {}),
            }),
          ),
      })

      add({
        name: "clear",
        description:
          "Remove annotations by id list or by kind. Use only when the user asks for it. Destructive ops need human approval; if the result says approval_required, tell the user to approve it in the Journal tab.",
        input: object({ ids: { type: "array", items: str }, kind: str }, []),
        execute: async (input, _tool, source) =>
          content(
            await applyOp({ op: "clear", ...(input as object), ...(source ? { source } : {}) }),
          ),
      })

      add({
        name: "set_view",
        description:
          "Move the chart viewport: `bars` (show the last N bars), or `from`/`to` bar times, or pin the price range with priceMin/priceMax (priceAuto: true restores automatic scaling).",
        input: object({ bars: num, from: num, to: num, priceMin: num, priceMax: num, priceAuto: bool }, []),
        execute: async (input) =>
          content(
            await applyOp({ op: "set_view", ...(input as object) }),
          ),
      })

      add({
        name: "add_series",
        description:
          "Plot a computed line series on the chart (e.g. an SMA/EMA you calculate in Code Mode from chart_get_state bars). Re-adding the same id updates the series in place. Up to 12 series, 2500 points each; points are { t: bar time in Unix seconds, v: value }.",
        input: object(
          {
            id: str,
            name: str,
            points: {
              type: "array",
              minItems: 2,
              maxItems: 2500,
              items: object({ t: num, v: num }, ["t", "v"]),
            },
            color: str,
            width: num,
            dash: bool,
          },
          ["id", "name", "points"],
        ),
        execute: async (input, tool, source) => {
          await tool.progress?.({ status: "plotting a series" })
          const { id, name, points, color, width, dash } = input as {
            id: string
            name: string
            points: unknown[]
            color?: string
            width?: number
            dash?: boolean
          }
          const style: Record<string, unknown> = {}
          if (color) style.color = color
          if (width) style.width = width
          if (dash) style.dash = dash
          const op = {
            op: "add_series",
            id,
            name,
            points,
            ...(Object.keys(style).length > 0 ? { style } : {}),
            ...(source ? { source } : {}),
          }
          return content(
            await applyOp(op),
          )
        },
      })

      add({
        name: "remove_series",
        description:
          "Remove a computed series by id. Destructive ops need human approval; if the result says approval_required, tell the user to approve it in the Journal tab.",
        input: object({ id: str }, ["id"]),
        execute: async (input) =>
          content(
            await applyOp({ op: "remove_series", id: (input as { id: string }).id }),
          ),
      })
    })
  },
})
