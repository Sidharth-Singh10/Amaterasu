import type { Annotation } from "@amaterasu/chart-dsl"
import type { Transform } from "@/lib/chart/transform"
import type { LineStyle, Painter, Point } from "../painter"
import type { FrameEnv } from "../registry"
import { distToSegment } from "../hit"

export const SELECTED_COLOR = "#f0b429"
export const DEFAULT_COLOR = "#4c8dff"
export const HANDLE_SIZE = 4

/** Resolve every anchor of an annotation to pixels; null if any is unresolvable. */
export function resolvePoints(a: Annotation, t: Transform): Point[] | null {
  const points: Point[] = []
  for (const anchor of a.points) {
    const resolved = t.resolve(anchor)
    if (!resolved.ok) return null
    points.push({ x: resolved.x, y: resolved.y })
  }
  return points
}

export function baseColor(a: Annotation): string {
  return a.style.color ?? DEFAULT_COLOR
}

export function baseWidth(a: Annotation): number {
  return a.style.width ?? 1.5
}

export function lineStyle(a: Annotation, env: FrameEnv): LineStyle {
  return {
    color: env.selected ? SELECTED_COLOR : baseColor(a),
    width: env.selected ? baseWidth(a) + 0.5 : baseWidth(a),
    dash: a.style.dash ? [6, 4] : undefined,
  }
}

export function drawHandles(p: Painter, points: readonly Point[], color = SELECTED_COLOR): void {
  for (const point of points) p.markerIcon("circle", point, { color, size: HANDLE_SIZE })
}

/** Canvas text for shape labels; kind "label" renders as a DOM pill instead. */
export function drawShapeLabel(p: Painter, a: Annotation, x: number, y: number): void {
  if (!a.label) return
  p.text(x, y, a.label, {
    color: a.style.color ?? "#c9d4e3",
    fontSize: a.style.fontSize ?? 11,
    align: "left",
    baseline: "bottom",
  })
}

export function segmentHit(a: Annotation, t: Transform, pt: Point, tol: number): number | null {
  const points = resolvePoints(a, t)
  if (!points || points.length < 2) return null
  const distance = distToSegment(pt, points[0], points[1])
  return distance <= tol ? distance : null
}

/** Extend a ray from `a` through `b` to the pane edge; returns the far endpoint. */
export function extendToPane(a: Point, b: Point, width: number, height: number): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) return b
  let tMax = Number.POSITIVE_INFINITY
  if (dx > 0) tMax = Math.min(tMax, (width - a.x) / dx)
  if (dx < 0) tMax = Math.min(tMax, (0 - a.x) / dx)
  if (dy > 0) tMax = Math.min(tMax, (height - a.y) / dy)
  if (dy < 0) tMax = Math.min(tMax, (0 - a.y) / dy)
  if (!Number.isFinite(tMax) || tMax < 0) return b
  return { x: a.x + dx * tMax, y: a.y + dy * tMax }
}
