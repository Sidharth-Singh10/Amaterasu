import type { Renderer } from "../registry"
import { distToSegment } from "../hit"
import { drawHandles, drawShapeLabel, extendToPane, lineStyle, resolvePoints } from "./common"

export const rayRenderer: Renderer = {
  kind: "ray",
  draw(a, t, p, env) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 2) return
    const [origin, through] = points
    const tip = extendToPane(origin, through, t.cssWidth, t.cssHeight)
    const style = lineStyle(a, env)
    if (a.style.dash) p.dashedLine(origin.x, origin.y, tip.x, tip.y, style)
    else p.line(origin.x, origin.y, tip.x, tip.y, style)
    if (env.selected) drawHandles(p, [origin, through])
    drawShapeLabel(p, a, origin.x + 8, origin.y - 8)
  },
  hitTest(a, t, pt, tol) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 2) return null
    const tip = extendToPane(points[0], points[1], t.cssWidth, t.cssHeight)
    const distance = distToSegment(pt, points[0], tip)
    return distance <= tol ? distance : null
  },
  handles: true,
}
