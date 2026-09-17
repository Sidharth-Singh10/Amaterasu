import type { Renderer } from "../registry"
import { drawHandles, drawShapeLabel, lineStyle, resolvePoints, segmentHit } from "./common"

export const trendlineRenderer: Renderer = {
  kind: "trendline",
  draw(a, t, p, env) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 2) return
    const [start, end] = points
    const style = lineStyle(a, env)
    if (a.style.dash) p.dashedLine(start.x, start.y, end.x, end.y, style)
    else p.line(start.x, start.y, end.x, end.y, style)
    if (env.selected) drawHandles(p, points)
    drawShapeLabel(p, a, (start.x + end.x) / 2, (start.y + end.y) / 2 - 8)
  },
  hitTest(a, t, pt, tol) {
    return segmentHit(a, t, pt, tol)
  },
  handles: true,
}
