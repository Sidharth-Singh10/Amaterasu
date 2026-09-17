export interface Point {
  x: number
  y: number
}

export interface LineStyle {
  color: string
  width: number
  dash?: number[]
}

export interface FillStyle {
  color: string
  opacity?: number
}

export interface MarkerStyle {
  color: string
  size?: number
}

export interface TextStyle {
  color: string
  fontSize: number
  align?: CanvasTextAlign
  baseline?: CanvasTextBaseline
  font?: string
}

/**
 * Draw-primitive kit in CSS-pixel space. DPR handling lives entirely in begin()/end();
 * snapping is opt-in per primitive because snapping diagonals independently bends them.
 */
export interface Painter {
  readonly dpr: number
  begin(): void
  end(): void
  snap(v: number): number
  snapCenter(v: number): number
  line(x1: number, y1: number, x2: number, y2: number, s: LineStyle): void
  dashedLine(x1: number, y1: number, x2: number, y2: number, s: LineStyle): void
  polygon(points: readonly Point[], s: FillStyle): void
  rect(x: number, y: number, w: number, h: number, fill: FillStyle, stroke?: LineStyle): void
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, s: FillStyle): void
  arrow(from: Point, to: Point, s: LineStyle): void
  markerIcon(shape: "circle" | "arrowUp" | "arrowDown", at: Point, s: MarkerStyle): void
  text(x: number, y: number, str: string, s: TextStyle): void
  /** Flushes queued text (measure calls are the per-frame hazard we avoid). */
  textPass(): void
}

const DEFAULT_FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif"
const DEFAULT_DASH = [6, 4]

export class CanvasPainter implements Painter {
  private readonly dashCache = new Map<string, number[]>()
  private textQueue: Array<{ x: number; y: number; str: string; s: TextStyle }> = []

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    readonly dpr: number,
  ) {}

  begin(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textQueue = []
  }

  end(): void {
    this.ctx.resetTransform()
  }

  snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr
  }

  snapCenter(v: number): number {
    return this.snap(v) - 0.5 / this.dpr
  }

  line(x1: number, y1: number, x2: number, y2: number, s: LineStyle): void {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.width
    ctx.lineCap = "round"
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.restore()
  }

  dashedLine(x1: number, y1: number, x2: number, y2: number, s: LineStyle): void {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.width
    ctx.lineCap = "butt"
    ctx.setLineDash(this.dashArray(s.dash))
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.restore()
  }

  polygon(points: readonly Point[], s: FillStyle): void {
    if (points.length < 3) return
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = s.opacity ?? 1
    ctx.fillStyle = s.color
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  rect(x: number, y: number, w: number, h: number, fill: FillStyle, stroke?: LineStyle): void {
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = fill.opacity ?? 1
    ctx.fillStyle = fill.color
    ctx.fillRect(x, y, w, h)
    ctx.restore()
    if (stroke) {
      ctx.save()
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = stroke.width
      ctx.setLineDash(stroke.dash ? this.dashArray(stroke.dash) : [])
      ctx.strokeRect(this.snapCenter(x), this.snapCenter(y), w, h)
      ctx.restore()
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, s: FillStyle): void {
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = s.opacity ?? 1
    ctx.fillStyle = s.color
    ctx.beginPath()
    ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), rot, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  arrow(from: Point, to: Point, s: LineStyle): void {
    this.line(from.x, from.y, to.x, to.y, s)
    const angle = Math.atan2(to.y - from.y, to.x - from.x)
    const size = 6 + s.width * 1.5
    const left = { x: to.x - size * Math.cos(angle - Math.PI / 6), y: to.y - size * Math.sin(angle - Math.PI / 6) }
    const right = { x: to.x - size * Math.cos(angle + Math.PI / 6), y: to.y - size * Math.sin(angle + Math.PI / 6) }
    this.polygon([to, left, right], { color: s.color })
  }

  markerIcon(shape: "circle" | "arrowUp" | "arrowDown", at: Point, s: MarkerStyle): void {
    const ctx = this.ctx
    const size = s.size ?? 4
    ctx.save()
    ctx.fillStyle = s.color
    if (shape === "circle") {
      ctx.beginPath()
      ctx.arc(at.x, at.y, size, 0, Math.PI * 2)
      ctx.fill()
    } else {
      const dir = shape === "arrowUp" ? -1 : 1
      ctx.beginPath()
      ctx.moveTo(at.x, at.y + dir * size * 1.2)
      ctx.lineTo(at.x - size, at.y - dir * size * 0.4)
      ctx.lineTo(at.x + size, at.y - dir * size * 0.4)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  text(x: number, y: number, str: string, s: TextStyle): void {
    this.textQueue.push({ x, y, str, s })
  }

  textPass(): void {
    const ctx = this.ctx
    for (const item of this.textQueue) {
      ctx.save()
      ctx.font = `${item.s.fontSize}px ${item.s.font ?? DEFAULT_FONT}`
      ctx.fillStyle = item.s.color
      ctx.textAlign = item.s.align ?? "left"
      ctx.textBaseline = item.s.baseline ?? "alphabetic"
      ctx.fillText(item.str, item.x, item.y)
      ctx.restore()
    }
    this.textQueue = []
  }

  private dashArray(dash: number[] | undefined): number[] {
    const pattern = dash ?? DEFAULT_DASH
    const key = pattern.join(",")
    let cached = this.dashCache.get(key)
    if (!cached) {
      cached = pattern
      this.dashCache.set(key, cached)
    }
    return cached
  }
}

export interface RecordedOp {
  name: string
  args: unknown[]
}

/** Geometry-only recording painter: renderer tests snapshot the recorded numbers. */
export class RecordingPainter implements Painter {
  readonly ops: RecordedOp[] = []
  readonly dpr = 1

  begin(): void {
    this.ops.length = 0
  }

  end(): void {}

  snap(v: number): number {
    return Math.round(v)
  }

  snapCenter(v: number): number {
    return Math.round(v) - 0.5
  }

  line(x1: number, y1: number, x2: number, y2: number, s: LineStyle): void {
    this.ops.push({ name: "line", args: [x1, y1, x2, y2, s.color, s.width] })
  }

  dashedLine(x1: number, y1: number, x2: number, y2: number, s: LineStyle): void {
    this.ops.push({ name: "dashedLine", args: [x1, y1, x2, y2, s.color, s.width] })
  }

  polygon(points: readonly Point[], s: FillStyle): void {
    this.ops.push({ name: "polygon", args: [points.map((p) => [p.x, p.y]), s.color, s.opacity ?? 1] })
  }

  rect(x: number, y: number, w: number, h: number, fill: FillStyle, stroke?: LineStyle): void {
    this.ops.push({ name: "rect", args: [x, y, w, h, fill.color, fill.opacity ?? 1, stroke?.color ?? null] })
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, s: FillStyle): void {
    this.ops.push({ name: "ellipse", args: [cx, cy, rx, ry, rot, s.color, s.opacity ?? 1] })
  }

  arrow(from: Point, to: Point, s: LineStyle): void {
    this.ops.push({ name: "arrow", args: [from.x, from.y, to.x, to.y, s.color, s.width] })
  }

  markerIcon(shape: "circle" | "arrowUp" | "arrowDown", at: Point, s: MarkerStyle): void {
    this.ops.push({ name: "markerIcon", args: [shape, at.x, at.y, s.color, s.size ?? 4] })
  }

  text(x: number, y: number, str: string, s: TextStyle): void {
    this.ops.push({ name: "text", args: [x, y, str, s.fontSize, s.align ?? "left"] })
  }

  textPass(): void {
    this.ops.push({ name: "textPass", args: [] })
  }
}
