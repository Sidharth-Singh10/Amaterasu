import { distToRect, insideRect, rectFromCorners } from "../hit"
import type { Renderer } from "../registry"
import { baseColor, drawHandles, drawShapeLabel, lineStyle, resolvePoints } from "./common"

/** Bounded rectangle: two opposite corners. */
export const rectRenderer: Renderer = {
  kind: "rect",
  draw(a, t, p, env) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 2) return
    const rect = rectFromCorners(points[0], points[1])
    const fillColor = a.style.fill ?? baseColor(a)
    const stroke = lineStyle(a, env)
    p.rect(rect.x, rect.y, rect.w, rect.h, { color: fillColor, opacity: a.style.fillOpacity ?? 0.12 }, stroke)
    if (env.selected) drawHandles(p, [points[0], points[1]])
    drawShapeLabel(p, a, rect.x + 6, rect.y - 4)
  },
  hitTest(a, t, pt, tol) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 2) return null
    const rect = rectFromCorners(points[0], points[1])
    if (insideRect(pt, rect)) return 0
    const distance = distToRect(pt, rect)
    return distance <= tol ? distance : null
  },
  handles: true,
}
