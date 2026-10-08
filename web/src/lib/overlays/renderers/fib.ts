import type { Renderer } from "../registry"
import { activeColor, baseWidth, drawHandles, drawShapeLabel, resolvePoints } from "./common"
import { palette } from "@/lib/theme/palette"

/** Standard retracement levels drawn between the two anchors. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const

/**
 * Fibonacci retracement between two anchors (typically a swing low and swing high).
 * Each level is a horizontal segment across the anchor span, labelled with % and price.
 */
export const fibRenderer: Renderer = {
  kind: "fib",
  draw(a, t, p, env) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 2) return
    const [from, to] = points
    const color = activeColor(a, env)
    const width = baseWidth(a)
    const left = Math.min(from.x, to.x)
    const right = Math.max(from.x, to.x)
    const p1 = a.points[0].p
    const p2 = a.points[1].p

    for (const level of FIB_LEVELS) {
      const price = p1 + (p2 - p1) * level
      const y = t.yOfPrice(price)
      if (y == null) continue
      const isEdge = level === 0 || level === 1
      p.line(left, y, right, y, { color, width: isEdge ? width + 0.5 : width })
      p.text(right + 6, y + 1, `${(level * 100).toFixed(1)}%  ${price.toFixed(2)}`, {
        color: a.style.color ?? palette.shapeText,
        fontSize: a.style.fontSize ?? 10,
        align: "left",
        baseline: "middle",
      })
    }
    if (env.selected) drawHandles(p, [from, to])
    drawShapeLabel(p, a, left + 6, Math.min(from.y, to.y) - 8)
  },
  hitTest(a, t, pt, tol) {
    const p1 = a.points[0].p
    const p2 = a.points[1].p
    let best: number | null = null
    for (const level of FIB_LEVELS) {
      const y = t.yOfPrice(p1 + (p2 - p1) * level)
      if (y == null) continue
      const distance = Math.abs(pt.y - y)
      if (distance <= tol && (best == null || distance < best)) best = distance
    }
    return best
  },
  handles: true,
}
