import type { Annotation } from "@amaterasu/chart-dsl"
import type { Transform } from "@/lib/chart/transform"
import { CanvasPainter, type Point } from "./painter"
import { getRenderer } from "./registry"
import { palette } from "@/lib/theme/palette"

export interface EphemeralShape {
  kind: "line" | "rect" | "point"
  points: Point[]
  color?: string
  dash?: boolean
  /** Optional caption drawn next to the shape (e.g. the snap target label). */
  label?: string
}

export interface SurfaceState {
  annotations: readonly Annotation[]
  selected: ReadonlySet<string>
  hovered: string | null
}

export interface SurfaceOptions {
  annotationCanvas: HTMLCanvasElement
  ephemeralCanvas: HTMLCanvasElement
  labelsHost: HTMLElement
  getTransform: () => Transform | null
  getState: () => SurfaceState
}

const SELECTED_COLOR = palette.selection
const EPHEMERAL_COLOR = palette.selection

/**
 * Owns the canvas stack: one layer for persisted annotations (repaints only when data,
 * viewport, or docs change) and one for ephemeral feedback (draw previews, drag ghosts,
 * hover). DOM label pills live in `labelsHost`.
 */
export class OverlaySurface {
  private readonly annotationCtx: CanvasRenderingContext2D
  private readonly ephemeralCtx: CanvasRenderingContext2D
  private annotationPainter: CanvasPainter
  private ephemeralPainter: CanvasPainter
  private dirty = { annotations: true, ephemeral: true }
  private rafId = 0
  private disposed = false
  private ephemeral: EphemeralShape[] = []
  private readonly labelEls = new Map<string, HTMLDivElement>()

  constructor(private readonly opts: SurfaceOptions) {
    this.annotationCtx = contextOf(opts.annotationCanvas)
    this.ephemeralCtx = contextOf(opts.ephemeralCanvas)
    this.annotationPainter = new CanvasPainter(this.annotationCtx, 1)
    this.ephemeralPainter = new CanvasPainter(this.ephemeralCtx, 1)
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const width = Math.max(1, Math.round(cssWidth))
    const height = Math.max(1, Math.round(cssHeight))
    for (const canvas of [this.opts.annotationCanvas, this.opts.ephemeralCanvas]) {
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
    }
    this.opts.labelsHost.style.width = `${width}px`
    this.opts.labelsHost.style.height = `${height}px`
    this.annotationPainter = new CanvasPainter(this.annotationCtx, dpr)
    this.ephemeralPainter = new CanvasPainter(this.ephemeralCtx, dpr)
    this.invalidate("all")
  }

  setEphemeral(shapes: EphemeralShape[]): void {
    this.ephemeral = shapes
    this.invalidate("ephemeral")
  }

  invalidate(which: "annotations" | "ephemeral" | "all" = "all"): void {
    if (this.disposed) return
    if (which === "all") {
      this.dirty.annotations = true
      this.dirty.ephemeral = true
    } else {
      this.dirty[which] = true
    }
    if (this.rafId === 0) {
      this.rafId = requestAnimationFrame(this.frame)
    }
  }

  /** Nearest annotation to `pt` within `tol` pixels, in current pane coordinates. */
  hitTest(pt: Point, tol: number): { id: string; distance: number } | null {
    const t = this.opts.getTransform()
    if (!t) return null
    const state = this.opts.getState()
    let best: { id: string; distance: number } | null = null
    for (const annotation of state.annotations) {
      if (annotation.hidden) continue
      const renderer = getRenderer(annotation.kind)
      if (!renderer?.hitTest) continue
      const distance = renderer.hitTest(annotation, t, pt, tol)
      if (distance != null && (best == null || distance < best.distance)) {
        best = { id: annotation.id, distance }
      }
    }
    return best
  }

  dispose(): void {
    this.disposed = true
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId)
    for (const el of this.labelEls.values()) el.remove()
    this.labelEls.clear()
  }

  private frame = (): void => {
    this.rafId = 0
    if (this.disposed) return
    const t = this.opts.getTransform()
    if (!t) return
    if (this.dirty.annotations) {
      this.dirty.annotations = false
      this.drawAnnotations(t)
    }
    if (this.dirty.ephemeral) {
      this.dirty.ephemeral = false
      this.drawEphemeral(t)
    }
  }

  private clear(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  private drawAnnotations(t: Transform): void {
    this.clear(this.annotationCtx, this.opts.annotationCanvas)
    const painter = this.annotationPainter
    painter.begin()
    const state = this.opts.getState()
    const order = [...state.annotations]
      .filter((a) => !a.hidden)
      .sort((a, b) => orderKey(a, state) - orderKey(b, state))
    for (const annotation of order) {
      const renderer = getRenderer(annotation.kind)
      if (!renderer) continue
      try {
        renderer.draw(annotation, t, painter, {
          selected: state.selected.has(annotation.id),
          hovered: state.hovered === annotation.id,
        })
      } catch (error) {
        // One bad annotation must never kill the frame.
        console.error(`overlay render failed for ${annotation.id} (${annotation.kind})`, error)
      }
    }
    painter.textPass()
    painter.end()
    this.updateLabels(t, state)
  }

  private drawEphemeral(t: Transform): void {
    this.clear(this.ephemeralCtx, this.opts.ephemeralCanvas)
    const painter = this.ephemeralPainter
    painter.begin()
    for (const shape of this.ephemeral) {
      const color = shape.color ?? EPHEMERAL_COLOR
      const width = 1.25
      if (shape.kind === "line" && shape.points.length >= 2) {
        const [a, b] = shape.points
        if (shape.dash !== false) painter.dashedLine(a.x, a.y, b.x, b.y, { color, width, dash: [5, 4] })
        else painter.line(a.x, a.y, b.x, b.y, { color, width })
      } else if (shape.kind === "rect" && shape.points.length >= 2) {
        const [a, b] = shape.points
        const x = Math.min(a.x, b.x)
        const y = Math.min(a.y, b.y)
        const w = Math.abs(a.x - b.x)
        const h = Math.abs(a.y - b.y)
        painter.rect(x, y, w, h, { color, opacity: 0.08 }, { color, width, dash: [5, 4] })
      } else if (shape.kind === "point" && shape.points.length >= 1) {
        painter.markerIcon("circle", shape.points[0], { color, size: 4 })
      }
      if (shape.label && shape.points.length >= 1) {
        painter.text(shape.points[0].x + 10, shape.points[0].y - 12, shape.label, {
          color: palette.selection,
          fontSize: 11,
          align: "left",
          baseline: "bottom",
        })
      }
    }
    painter.textPass()
    painter.end()
    void t
  }

  private updateLabels(t: Transform, state: SurfaceState): void {
    const seen = new Set<string>()
    for (const annotation of state.annotations) {
      if (annotation.kind !== "label" || annotation.hidden) continue
      seen.add(annotation.id)
      const resolved = t.resolve(annotation.points[0])
      let el = this.labelEls.get(annotation.id)
      if (!resolved.ok || !t.isVisible(resolved.x, resolved.y)) {
        if (el) el.style.display = "none"
        continue
      }
      if (!el) {
        el = document.createElement("div")
        el.dataset.annotationId = annotation.id
        el.style.cssText = [
          "position:absolute",
          "transform:translate(-50%,-50%)",
          "padding:2px 6px",
          "border-radius:4px",
          "font-size:11px",
          "line-height:1.3",
          "white-space:nowrap",
          "pointer-events:none",
          `background:${palette.labelBg}`,
          `border:1px solid ${palette.labelBorder}`,
          `color:${palette.shapeText}`,
          "max-width:220px",
          "overflow:hidden",
          "text-overflow:ellipsis",
        ].join(";")
        this.opts.labelsHost.appendChild(el)
        this.labelEls.set(annotation.id, el)
      }
      el.textContent = annotation.label ?? "label"
      el.style.display = ""
      el.style.left = `${resolved.x}px`
      el.style.top = `${resolved.y - 14}px`
    }
    for (const [id, el] of this.labelEls) {
      if (!seen.has(id)) {
        el.remove()
        this.labelEls.delete(id)
      }
    }
  }
}

function orderKey(annotation: Annotation, state: SurfaceState): number {
  const emphasis = state.selected.has(annotation.id) || state.hovered === annotation.id ? 1_000_000 : 0
  return emphasis + annotation.z * 100_000 + annotation.createdAt
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("2d canvas context unavailable")
  return ctx
}
