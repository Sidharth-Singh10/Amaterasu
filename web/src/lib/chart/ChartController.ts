import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineWidth,
  type Logical,
  type UTCTimestamp,
} from "lightweight-charts"
import type { Anchor, Kind, Op, OpResult, SetViewOp } from "@amaterasu/chart-dsl"
import { Transform } from "@/lib/chart/transform"
import { demoCandles, type Candle } from "@/lib/data/mock"
import { diffCandles } from "@/lib/data/diff"
import { DocStore, type AnchorCheck } from "@/lib/ops/reducer"
import { OverlaySurface, type EphemeralShape } from "@/lib/overlays/surface"
import { registerBuiltinRenderers } from "@/lib/overlays/renderers"
import { resolvePoints } from "@/lib/overlays/renderers/common"
import { getRenderer } from "@/lib/overlays/registry"
import { SnapEngine, type SnapKind, type SnapResult } from "@/lib/overlays/snap"
import type { Point } from "@/lib/overlays/painter"

export type Tool = "select" | Kind

export interface LogEntry {
  label: string
  result: OpResult
}

export interface ControllerSummary {
  count: number
  selected: string[]
  tool: Tool
  canUndo: boolean
  canRedo: boolean
}

export interface ControllerListeners {
  onChange?: () => void
  onLog?: (entry: LogEntry) => void
  /** Fired when the visible range changes (pan/zoom/resize) — used for context sync. */
  onViewportChange?: () => void
}

export interface ControllerElements {
  host: HTMLElement
  annotationCanvas: HTMLCanvasElement
  ephemeralCanvas: HTMLCanvasElement
  labelsHost: HTMLElement
}

interface DrawingState {
  kind: Kind
  start: Anchor
  startPx: Point
  moved: boolean
}

interface DraggingState {
  id: string
  startPx: Point
  draft: Anchor[] | null
}

/**
 * Owns the chart, the annotation document, the overlay surface, and pointer interaction.
 * Framework-free: the React shell constructs it and reads summaries back through listeners.
 */
export class ChartController {
  readonly store: DocStore
  private readonly chart: IChartApi
  private readonly candleSeries: ISeriesApi<"Candlestick">
  private readonly volumeSeries: ISeriesApi<"Histogram">
  private readonly surface: OverlaySurface
  private readonly lineSeries = new Map<string, ISeriesApi<"Line">>()
  private readonly seriesSignature = new Map<string, number>()
  private bars: Candle[]
  private readonly host: HTMLElement
  private readonly resizeObserver: ResizeObserver
  private readonly listeners: ControllerListeners
  private pane = { width: 0, height: 0, dpr: 1 }
  private tool: Tool = "select"
  private selected = new Set<string>()
  private hovered: string | null = null
  private drawing: DrawingState | null = null
  private dragging: DraggingState | null = null
  private resizing: { id: string; handleIndex: number; draft: Anchor[] } | null = null
  private readonly snap = new SnapEngine()
  private meta = { symbol: "unknown", interval: "1day" }
  private disposed = false

  constructor(elements: ControllerElements, opts?: { candles?: Candle[]; listeners?: ControllerListeners }) {
    registerBuiltinRenderers()
    this.host = elements.host
    this.listeners = opts?.listeners ?? {}
    this.bars = opts?.candles ?? demoCandles()

    this.chart = createChart(elements.host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0f14" },
        textColor: "#8b98a9",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(139,152,169,.10)" },
        horzLines: { color: "rgba(139,152,169,.10)" },
      },
      rightPriceScale: { borderColor: "rgba(139,152,169,.25)" },
      timeScale: { borderColor: "rgba(139,152,169,.25)", timeVisible: false, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    })

    this.volumeSeries = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    })
    this.volumeSeries.setData([])
    this.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    this.candleSeries = this.chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      borderVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.05 },
    })
    this.candleSeries.setData([])

    this.store = new DocStore({
      checkAnchor: (anchor) => this.checkAnchor(anchor),
      onView: (op) => this.applyView(op),
    })

    this.surface = new OverlaySurface({
      annotationCanvas: elements.annotationCanvas,
      ephemeralCanvas: elements.ephemeralCanvas,
      labelsHost: elements.labelsHost,
      getTransform: () => this.transform(),
      getState: () => ({ annotations: this.store.annotations, selected: this.selected, hovered: this.hovered }),
    })

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.handleViewportChange)
    this.resizeObserver = new ResizeObserver(() => this.layout())
    this.resizeObserver.observe(elements.host)
    // Capture phase on the chart host: we see events before lightweight-charts and consume
    // only the gestures we own — drawing, or dragging an annotation. Everything else passes
    // through, so pan, zoom, and the crosshair keep working. LWC listens to mouse/touch
    // events, so we drive our gestures from pointer events and suppress the compat mouse
    // events while we own one. Touch is left to the chart in Phase 0.
    elements.host.addEventListener("pointerdown", this.onPointerDown, true)
    elements.host.addEventListener("pointermove", this.onPointerMove, true)
    elements.host.addEventListener("pointerup", this.onPointerUp, true)
    elements.host.addEventListener("pointercancel", this.onPointerCancel, true)
    elements.host.addEventListener("pointerleave", this.onPointerLeave, true)
    elements.host.addEventListener("mousedown", this.onMouseCompat, true)
    elements.host.addEventListener("mousemove", this.onMouseCompat, true)
    elements.host.addEventListener("mouseup", this.onMouseCompat, true)
    window.addEventListener("keydown", this.onKeyDown)
    this.applyCandles(this.bars)
    this.layout()
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get summary(): ControllerSummary {
    return {
      count: this.store.annotations.length,
      selected: [...this.selected],
      tool: this.tool,
      canUndo: this.store.canUndo,
      canRedo: this.store.canRedo,
    }
  }

  setTool(tool: Tool): void {
    this.cancelPendingGesture()
    this.tool = tool
    this.host.style.cursor = tool === "select" ? "default" : "crosshair"
    this.emitChange()
  }

  applyOp(raw: unknown, label?: string): OpResult {
    const { op, snappedTo } = this.withDataSnap(raw)
    const result = this.store.applyOp(op)
    if (result.ok && snappedTo.length > 0) result.snappedTo = snappedTo
    this.syncSeries()
    this.surface.invalidate("all")
    this.listeners.onLog?.({ label: label ?? describeOp(raw), result })
    this.emitChange()
    return result
  }

  /**
   * Mirrors the document's computed series onto the chart. Cheap to call on every
   * mutation: series are only pushed to lightweight-charts when their `updatedAt` changed.
   */
  private syncSeries(): void {
    const seen = new Set<string>()
    for (const series of this.store.series) {
      seen.add(series.id)
      if (this.seriesSignature.get(series.id) === series.updatedAt) continue
      const options = {
        color: series.style.color ?? "#f0b429",
        lineWidth: Math.min(4, Math.max(1, Math.round(series.style.width ?? 1.5))) as LineWidth,
        lineStyle: series.style.dash ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }
      const points = series.points.map((point) => ({ time: point.t as UTCTimestamp, value: point.v }))
      const existing = this.lineSeries.get(series.id)
      if (existing) {
        existing.applyOptions(options)
        existing.setData(points)
      } else {
        const created = this.chart.addSeries(LineSeries, options)
        created.setData(points)
        this.lineSeries.set(series.id, created)
      }
      this.seriesSignature.set(series.id, series.updatedAt)
    }
    for (const [id, series] of this.lineSeries) {
      if (seen.has(id)) continue
      this.chart.removeSeries(series)
      this.lineSeries.delete(id)
      this.seriesSignature.delete(id)
    }
  }

  /**
   * Agent-op snapping (§6.3.7): data-space tolerance so the same op resolves identically
   * at any zoom. `snap: "ohlc" | "swing" | "level"` snaps each anchor to the nearest
   * structural value (and its bar time); "none"/absent leaves points untouched.
   */
  private withDataSnap(raw: unknown): { op: unknown; snappedTo: string[] } {
    if (typeof raw !== "object" || raw === null) return { op: raw, snappedTo: [] }
    const candidate = raw as { op?: string; snap?: string; points?: Anchor[] }
    if (candidate.op !== "draw" || !candidate.snap || candidate.snap === "none" || !Array.isArray(candidate.points)) {
      return { op: raw, snappedTo: [] }
    }
    const kinds: SnapKind[] =
      candidate.snap === "ohlc" ? ["ohlc"] : candidate.snap === "swing" ? ["swing"] : ["round"]
    const snappedTo: string[] = []
    const points = candidate.points.map((anchor) => {
      const result = this.snap.snapPrice(anchor.p, this.snapTolerance(anchor.p), kinds)
      if (!result) return anchor
      snappedTo.push(result.label)
      return result.time !== undefined ? { t: result.time, p: result.price } : { ...anchor, p: result.price }
    })
    return { op: { ...raw, points, snap: "none" }, snappedTo }
  }

  /** min(0.1% of price, 0.25 × ATR14) — viewport-independent agent tolerance. */
  private snapTolerance(price: number): number {
    const atr = this.snap.atr(14)
    return Math.min(Math.abs(price) * 0.001, atr ? atr * 0.25 : Number.POSITIVE_INFINITY)
  }

  undo(): void {
    if (!this.store.undo()) return
    this.syncSeries()
    this.surface.invalidate("all")
    this.listeners.onLog?.({ label: "undo", result: { ok: true } })
    this.emitChange()
  }

  redo(): void {
    if (!this.store.redo()) return
    this.syncSeries()
    this.surface.invalidate("all")
    this.listeners.onLog?.({ label: "redo", result: { ok: true } })
    this.emitChange()
  }

  clearAll(): void {
    const ids = this.store.annotations.map((a) => a.id)
    if (ids.length === 0) return
    this.applyOp({ op: "clear", ids }, `clear ${ids.length} annotation(s)`)
  }

  /** Valid sample op for the dev console, built from the currently loaded bars. */
  exampleOp(kind: Kind): Op | null {
    const bars = this.bars
    if (bars.length < 3) return null
    const last = bars[bars.length - 1]
    const first = bars[Math.max(0, bars.length - 61)]
    switch (kind) {
      case "hzone": {
        const window = bars.slice(-20)
        const low = Math.min(...window.map((c) => c.low))
        const high = Math.max(...window.map((c) => c.high))
        return {
          op: "draw",
          kind,
          points: [
            { t: last.time, p: low },
            { t: last.time, p: high },
          ],
          label: "band",
        }
      }
      case "fib": {
        const window = bars.slice(-60)
        const lowest = window.reduce((a, b) => (b.low < a.low ? b : a), window[0])
        const highest = window.reduce((a, b) => (b.high > a.high ? b : a), window[0])
        return {
          op: "draw",
          kind,
          points: [
            { t: lowest.time, p: lowest.low },
            { t: highest.time, p: highest.high },
          ],
          label: "fib",
        }
      }
      case "channel": {
        const window = bars.slice(-40)
        const start = window[0]
        return {
          op: "draw",
          kind,
          points: [
            { t: start.time, p: start.low },
            { t: last.time, p: last.low },
            { t: start.time, p: start.high },
          ],
          label: "channel",
        }
      }
      case "marker": {
        const window = bars.slice(-30)
        const lowest = window.reduce((a, b) => (b.low < a.low ? b : a), window[0])
        return {
          op: "draw",
          kind,
          points: [{ t: lowest.time, p: lowest.low }],
          label: "swing low",
          style: { shape: "arrowUp", color: "#26a69a" },
        }
      }
      case "measure": {
        const window = bars.slice(-60)
        const lowest = window.reduce((a, b) => (b.low < a.low ? b : a), window[0])
        const highest = window.reduce((a, b) => (b.high > a.high ? b : a), window[0])
        return {
          op: "draw",
          kind,
          points: [
            { t: lowest.time, p: lowest.low },
            { t: highest.time, p: highest.high },
          ],
        }
      }
      case "hline":
        return { op: "draw", kind, points: [{ t: last.time, p: last.close }], label: `close ${last.close.toFixed(2)}` }
      case "vline":
        return { op: "draw", kind, points: [{ t: last.time, p: last.close }], label: "now" }
      case "label":
        return { op: "draw", kind, points: [{ t: last.time, p: last.close }], label: `close ${last.close.toFixed(2)}` }
      case "ray":
        return { op: "draw", kind, points: [{ t: first.time, p: first.low }, { t: last.time, p: last.low }], label: "ray" }
      case "rect":
        return {
          op: "draw",
          kind,
          points: [
            { t: first.time, p: Math.min(...bars.slice(-61).map((c) => c.low)) },
            { t: last.time, p: Math.max(...bars.slice(-61).map((c) => c.high)) },
          ],
          label: "range",
        }
      case "trendline":
      default:
        return {
          op: "draw",
          kind: "trendline",
          points: [{ t: first.time, p: first.low }, { t: last.time, p: last.low }],
          label: "trendline",
        }
    }
  }

  /** Resolved pane pixels for an annotation's anchors (null when unresolvable). */
  pixelsOf(annotationId: string): Array<{ x: number; y: number }> | null {
    const t = this.transform()
    if (!t) return null
    const annotation = this.store.annotations.find((a) => a.id === annotationId)
    if (!annotation) return null
    const points: Array<{ x: number; y: number }> = []
    for (const anchor of annotation.points) {
      const resolved = t.resolve(anchor)
      if (!resolved.ok) return null
      points.push({ x: resolved.x, y: resolved.y })
    }
    return points
  }

  /**
   * Replaces the series data. `preserveView` keeps the current logical range (refresh);
   * otherwise the chart fits the new content (symbol/interval change).
   */
  applyCandles(candles: Candle[], opts?: { preserveView?: boolean }): void {
    const previous = this.bars
    this.bars = candles
    this.snap.setBars(candles)
    const diff = diffCandles(previous, candles)
    if (diff.mode === "update") {
      for (const candle of diff.candles) {
        const time = candle.time as UTCTimestamp
        this.candleSeries.update({
          time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })
        this.volumeSeries.update({
          time,
          value: candle.volume,
          color: candle.close >= candle.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)",
        })
      }
    } else {
      this.candleSeries.setData(
        candles.map((candle) => ({
          time: candle.time as UTCTimestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
      )
      this.volumeSeries.setData(
        candles.map((candle) => ({
          time: candle.time as UTCTimestamp,
          value: candle.volume,
          color: candle.close >= candle.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)",
        })),
      )
    }
    if (!opts?.preserveView) {
      this.chart.timeScale().fitContent()
    }
    this.layout()
    this.surface.invalidate("all")
  }

  /** Surgical undo for one agent turn: removes that turn's shapes and computed series. */
  undoTurnBySource(messageID: string): void {
    this.applyOp({ op: "clear", sourceMessageID: messageID }, "undo agent turn")
    for (const series of this.store.series) {
      if (series.source?.messageID === messageID) {
        this.applyOp({ op: "remove_series", id: series.id }, "undo agent series")
      }
    }
  }

  /** Current visible logical range, for persistence across reloads. */
  getViewport(): { from: number; to: number } | null {
    const range = this.chart.timeScale().getVisibleLogicalRange()
    return range ? { from: range.from, to: range.to } : null
  }

  setViewport(range: { from: number; to: number }): void {
    this.chart.timeScale().setVisibleLogicalRange(range)
    this.surface.invalidate("all")
  }

  /** Display identity of the loaded data; used by `getSnapshot` (and Phase 2's agent state). */
  setSymbolMeta(meta: { symbol: string; interval: string }): void {
    this.meta = meta
  }

  /** Compact chart state for the dev console and (Phase 2) the agent bridge. */
  getSnapshot(meta?: { symbol?: string; interval?: string }) {
    const t = this.transform()
    const visibleRange = this.chart.timeScale().getVisibleRange()
    const priceRange = t?.visiblePriceRange() ?? null
    const logicalRange = t?.visibleLogicalRange() ?? null
    return {
      symbol: meta?.symbol ?? this.meta.symbol,
      interval: meta?.interval ?? this.meta.interval,
      bars: this.bars.slice(-250),
      visible: visibleRange
        ? {
            from: visibleRange.from as number,
            to: visibleRange.to as number,
            priceMin: priceRange?.min,
            priceMax: priceRange?.max,
            logicalRange,
          }
        : null,
      annotations: this.store.annotations,
      series: this.store.series.map((series) => ({
        id: series.id,
        name: series.name,
        points: series.points.length,
        lastValue: series.points[series.points.length - 1]?.v ?? null,
      })),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resizeObserver.disconnect()
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.handleViewportChange)
    this.host.removeEventListener("pointerdown", this.onPointerDown, true)
    this.host.removeEventListener("pointermove", this.onPointerMove, true)
    this.host.removeEventListener("pointerup", this.onPointerUp, true)
    this.host.removeEventListener("pointercancel", this.onPointerCancel, true)
    this.host.removeEventListener("pointerleave", this.onPointerLeave, true)
    this.host.removeEventListener("mousedown", this.onMouseCompat, true)
    this.host.removeEventListener("mousemove", this.onMouseCompat, true)
    this.host.removeEventListener("mouseup", this.onMouseCompat, true)
    window.removeEventListener("keydown", this.onKeyDown)
    this.surface.dispose()
    this.chart.remove()
  }

  // ── Chart plumbing ────────────────────────────────────────────────────────

  private transform(): Transform | null {
    if (this.pane.width <= 0 || this.pane.height <= 0) return null
    const scale = this.chart.timeScale()
    const series = this.candleSeries
    return new Transform({
      scale: {
        timeToCoordinate: (time) => scale.timeToCoordinate(time as UTCTimestamp) as number | null,
        coordinateToTime: (x) => scale.coordinateToTime(x) as number | null,
        logicalToCoordinate: (li) => scale.logicalToCoordinate(li as Logical) as number | null,
        coordinateToLogical: (x) => scale.coordinateToLogical(x) as number | null,
        timeToIndex: (time, findNearest) => scale.timeToIndex(time as UTCTimestamp, findNearest) as number | null,
        visibleLogicalRange: () => {
          const range = scale.getVisibleLogicalRange()
          return range ? { from: range.from, to: range.to } : null
        },
      },
      price: {
        priceToCoordinate: (price) => series.priceToCoordinate(price) as number | null,
        coordinateToPrice: (y) => series.coordinateToPrice(y) as number | null,
      },
      bars: this.bars.map((c) => c.time),
      cssWidth: this.pane.width,
      cssHeight: this.pane.height,
      dpr: this.pane.dpr,
    })
  }

  private checkAnchor(anchor: Anchor): AnchorCheck {
    const t = this.transform()
    if (!t) return { ok: false, reason: "no-data", warnings: [] }
    const resolved = t.resolve(anchor)
    return resolved.ok
      ? { ok: true, warnings: resolved.warnings }
      : { ok: false, reason: resolved.reason, warnings: resolved.warnings }
  }

  private applyView(op: SetViewOp): OpResult {
    const timeScale = this.chart.timeScale()
    const warnings: string[] = []
    if (op.bars != null) {
      const to = this.bars.length - 1 + 2
      timeScale.setVisibleLogicalRange({ from: Math.max(0, to - op.bars), to })
    } else if (op.from != null || op.to != null) {
      const current = timeScale.getVisibleRange()
      const from = op.from ?? (current ? (current.from as number) : null)
      const to = op.to ?? (current ? (current.to as number) : null)
      if (from != null && to != null && from < to) {
        timeScale.setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp })
      } else {
        warnings.push("set_view needs a valid from/to pair")
      }
    }
    if (op.priceAuto) {
      this.chart.priceScale("right").setAutoScale(true)
    } else if (op.priceMin != null && op.priceMax != null && op.priceMin < op.priceMax) {
      this.chart.priceScale("right").setAutoScale(false)
      this.chart.priceScale("right").setVisibleRange({ from: op.priceMin, to: op.priceMax })
    }
    this.layout()
    return { ok: true, warnings }
  }

  private layout(): void {
    if (this.disposed) return
    const width = this.host.clientWidth - this.chart.priceScale("right").width()
    const height = this.host.clientHeight - this.chart.timeScale().height()
    if (width <= 0 || height <= 0) return
    const dpr = window.devicePixelRatio || 1
    if (this.pane.width !== width || this.pane.height !== height || this.pane.dpr !== dpr) {
      this.pane = { width, height, dpr }
      this.surface.resize(width, height, dpr)
    }
  }

  private handleViewportChange = (): void => {
    this.layout()
    this.surface.invalidate("all")
    this.listeners.onViewportChange?.()
  }

  // ── Pointer interaction ───────────────────────────────────────────────────

  /** True while we own the gesture; compat mouse events are suppressed then. */
  private ownGesture = false

  private consume(event: PointerEvent): void {
    event.stopPropagation()
    this.ownGesture = true
    this.host.setPointerCapture(event.pointerId)
  }

  /** lightweight-charts listens to mouse events; block them while we own the gesture. */
  private onMouseCompat = (event: MouseEvent): void => {
    if (!this.ownGesture) return
    event.stopPropagation()
    event.preventDefault()
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return
    const pt = this.localPoint(event)

    if (this.tool === "select") {
      const t = this.transform()
      const handle = t ? this.handleAt(pt, t) : null
      if (handle) {
        const annotation = this.store.annotations.find((a) => a.id === handle.id)
        if (annotation) {
          this.selected = new Set([handle.id])
          this.resizing = {
            id: handle.id,
            handleIndex: handle.index,
            draft: annotation.points.map((point) => ({ ...point })),
          }
          this.consume(event)
          this.emitChange()
          this.surface.invalidate("all")
          return
        }
      }
      const hit = this.surface.hitTest(pt, 6)
      if (hit) {
        const annotation = this.store.annotations.find((a) => a.id === hit.id)
        this.selected = new Set([hit.id])
        if (annotation && !annotation.locked) {
          this.dragging = { id: hit.id, startPx: pt, draft: null }
          this.consume(event)
        }
      } else if (this.selected.size > 0) {
        this.selected = new Set()
      }
      this.emitChange()
      this.surface.invalidate("all")
      return
    }

    this.consume(event)
    const t = this.transform()
    if (!t) return
    const { anchor } = this.anchorWithSnap(pt, t)
    if (!anchor) return

    if (this.tool === "hline" || this.tool === "vline" || this.tool === "label") {
      const label = this.tool === "label" ? `close ${anchor.p.toFixed(2)}` : undefined
      this.applyOp({ op: "draw", kind: this.tool, points: [anchor], label }, `draw ${this.tool}`)
      this.ownGesture = false
      this.setTool("select")
      return
    }

    if (!this.drawing) {
      this.drawing = { kind: this.tool, start: anchor, startPx: pt, moved: false }
      this.surface.setEphemeral([{ kind: "point", points: [pt] }])
      return
    }
    const { anchor: end } = this.anchorWithSnap(pt, t)
    if (end) this.finishDrawing(this.drawing, end)
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return
    const pt = this.localPoint(event)

    if (this.resizing) {
      event.stopPropagation()
      const t = this.transform()
      if (!t) return
      const annotation = this.store.annotations.find((a) => a.id === this.resizing?.id)
      if (!annotation) return
      const { anchor, snap } = this.anchorWithSnap(pt, t)
      if (!anchor) return
      const draft = [...this.resizing.draft]
      draft[this.resizing.handleIndex] = anchor
      this.resizing.draft = draft
      const shapes = this.shapesFor(annotation.kind, draft, t, true)
      this.surface.setEphemeral(
        snap ? [...shapes, { kind: "point", points: [{ x: snap.x, y: snap.y }], label: snap.label }] : shapes,
      )
      return
    }

    if (this.dragging) {
      event.stopPropagation()
      const t = this.transform()
      if (!t) return
      const annotation = this.store.annotations.find((a) => a.id === this.dragging?.id)
      if (!annotation) return
      const dx = pt.x - this.dragging.startPx.x
      const dy = pt.y - this.dragging.startPx.y
      const draft = annotation.points.map((anchor) => this.translateAnchor(anchor, dx, dy, t))
      if (draft.some((a) => a == null)) return
      this.dragging.draft = draft as Anchor[]
      this.surface.setEphemeral(this.shapesFor(annotation.kind, draft as Anchor[], t, true))
      return
    }

    if (this.drawing) {
      event.stopPropagation()
      if (Math.hypot(pt.x - this.drawing.startPx.x, pt.y - this.drawing.startPx.y) > 4) {
        this.drawing.moved = true
      }
      const t = this.transform()
      const snap = t ? this.snap.snapPoint(pt, t, { tolPx: 8 }) : null
      const preview = this.previewShapes(this.drawing.kind, this.drawing.startPx, pt)
      this.surface.setEphemeral(
        snap ? [...preview, { kind: "point", points: [{ x: snap.x, y: snap.y }], label: snap.label }] : preview,
      )
      return
    }

    const hit = this.surface.hitTest(pt, 6)
    const hovered = hit?.id ?? null
    if (hovered !== this.hovered) {
      this.hovered = hovered
      this.host.style.cursor = hovered ? "pointer" : this.tool === "select" ? "default" : "crosshair"
      this.surface.invalidate("annotations")
    }
  }

  private onPointerUp = (event: PointerEvent): void => {
    this.ownGesture = false
    if (this.resizing) {
      event.stopPropagation()
      const { id, draft } = this.resizing
      this.resizing = null
      this.surface.setEphemeral([])
      this.applyOp({ op: "update", id, points: draft }, "resize annotation")
      return
    }
    if (this.dragging) {
      event.stopPropagation()
      const { id, draft } = this.dragging
      this.dragging = null
      this.surface.setEphemeral([])
      if (draft) this.applyOp({ op: "update", id, points: draft }, "move annotation")
      return
    }
    if (this.drawing && this.drawing.moved) {
      event.stopPropagation()
      const t = this.transform()
      if (t) {
        const pt = this.localPoint(event)
        const { anchor: end } = this.anchorWithSnap(pt, t)
        if (end) this.finishDrawing(this.drawing, end)
      }
      this.drawing = null
      this.surface.setEphemeral([])
    }
  }

  private onPointerCancel = (): void => {
    this.ownGesture = false
    this.cancelPendingGesture()
  }

  private onPointerLeave = (): void => {
    if (this.hovered !== null) {
      this.hovered = null
      this.surface.invalidate("annotations")
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
    ) {
      return
    }
    if (event.key === "Escape") {
      this.cancelPendingGesture()
      if (this.selected.size > 0) {
        this.selected = new Set()
        this.surface.invalidate("all")
        this.emitChange()
      }
      return
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (this.selected.size === 0) return
      event.preventDefault()
      const ids = [...this.selected]
      this.selected = new Set()
      for (const id of ids) this.applyOp({ op: "remove", id }, "delete annotation")
    }
  }

  // ── Gesture helpers ───────────────────────────────────────────────────────

  private finishDrawing(drawing: DrawingState, end: Anchor): void {
    this.drawing = null
    this.surface.setEphemeral([])
    this.applyOp({ op: "draw", kind: drawing.kind, points: [drawing.start, end] }, `draw ${drawing.kind}`)
    this.setTool("select")
  }

  private cancelPendingGesture(): void {
    this.drawing = null
    this.dragging = null
    this.resizing = null
    this.ownGesture = false
    this.surface.setEphemeral([])
  }

  /** Selected annotations' anchor handles are grabbed before anything else. */
  private handleAt(pt: Point, t: Transform): { id: string; index: number } | null {
    for (const id of this.selected) {
      const annotation = this.store.annotations.find((a) => a.id === id)
      if (!annotation || annotation.locked) continue
      if (!getRenderer(annotation.kind)?.handles) continue
      const points = resolvePoints(annotation, t)
      if (!points) continue
      for (let index = 0; index < points.length; index++) {
        const handle = points[index]
        if (Math.hypot(pt.x - handle.x, pt.y - handle.y) <= 10) return { id, index }
      }
    }
    return null
  }

  /** Pointer → anchor with structure snapping applied (human input path). */
  private anchorWithSnap(pt: Point, t: Transform): { anchor: Anchor | null; snap: SnapResult | null } {
    const anchor = t.anchorAt(pt.x, pt.y)
    if (!anchor) return { anchor: null, snap: null }
    const snap = this.snap.snapPoint(pt, t, { tolPx: 8 })
    if (!snap) return { anchor, snap: null }
    const snappedAnchor = t.anchorAt(snap.x, snap.y)
    return { anchor: snappedAnchor ?? anchor, snap }
  }

  private translateAnchor(anchor: Anchor, dx: number, dy: number, t: Transform): Anchor | null {
    const resolved = t.resolve(anchor)
    if (!resolved.ok) return null
    const li = resolved.li + dx * t.logicalPerPixel()
    const price = t.priceOfY(resolved.y + dy)
    if (price == null) return null
    return t.anchorFromLogical(li, price)
  }

  private previewShapes(kind: Kind, a: Point, b: Point): EphemeralShape[] {
    if (kind === "trendline" || kind === "ray") return [{ kind: "line", points: [a, b] }]
    if (kind === "rect") return [{ kind: "rect", points: [a, b] }]
    return []
  }

  private shapesFor(kind: Kind, anchors: Anchor[], t: Transform, dashed: boolean): EphemeralShape[] {
    const points: Point[] = []
    for (const anchor of anchors) {
      const resolved = t.resolve(anchor)
      if (!resolved.ok) return []
      points.push({ x: resolved.x, y: resolved.y })
    }
    if (kind === "rect" && points.length >= 2) return [{ kind: "rect", points, dash: dashed }]
    if (points.length >= 2) return [{ kind: "line", points, dash: dashed }]
    if (points.length === 1) return [{ kind: "point", points }]
    return []
  }

  private localPoint(event: { clientX: number; clientY: number }): Point {
    const rect = this.host.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private emitChange(): void {
    this.listeners.onChange?.()
  }
}

function describeOp(raw: unknown): string {
  if (raw && typeof raw === "object" && "op" in raw) {
    const op = (raw as { op?: unknown }).op
    const kind = "kind" in raw ? ` ${String((raw as { kind?: unknown }).kind ?? "")}` : ""
    return `${String(op)}${kind}`
  }
  return "op"
}
