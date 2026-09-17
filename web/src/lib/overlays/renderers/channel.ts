import type { Point } from "../painter"
import { distToSegment } from "../hit"
import type { Renderer } from "../registry"
import { baseColor, drawHandles, drawShapeLabel, lineStyle, resolvePoints } from "./common"

/**
 * Parallel price channel: anchors 0 and 1 form the first rail; anchor 2 sets the
 * parallel rail's offset (dragging it widens/narrows the channel).
 */
export const channelRenderer: Renderer = {
  kind: "channel",
  draw(a, t, p, env) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 3) return
    const [from, to, guide] = points
    const offset = parallelOffset(from, to, guide)
    const railFrom = { x: from.x + offset.x, y: from.y + offset.y }
    const railTo = { x: to.x + offset.x, y: to.y + offset.y }
    const style = lineStyle(a, env)
    const fill = a.style.fill ?? baseColor(a)

    p.polygon([from, to, railTo, railFrom], { color: fill, opacity: a.style.fillOpacity ?? 0.06 })
    p.line(from.x, from.y, to.x, to.y, style)
    p.line(railFrom.x, railFrom.y, railTo.x, railTo.y, style)
    if (env.selected) drawHandles(p, [from, to, guide])
    drawShapeLabel(p, a, Math.min(from.x, to.x) + 6, Math.min(from.y, railFrom.y, to.y, railTo.y) - 8)
  },
  hitTest(a, t, pt, tol) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 3) return null
    const [from, to, guide] = points
    const offset = parallelOffset(from, to, guide)
    const distance = Math.min(
      distToSegment(pt, from, to),
      distToSegment(pt, { x: from.x + offset.x, y: from.y + offset.y }, { x: to.x + offset.x, y: to.y + offset.y }),
    )
    return distance <= tol ? distance : null
  },
  handles: true,
}

/** Pixel-space perpendicular offset from the line through `to` to `guide`. */
function parallelOffset(from: Point, to: Point, guide: Point): Point {
  const vx = to.x - from.x
  const vy = to.y - from.y
  const lengthSquared = vx * vx + vy * vy
  if (lengthSquared === 0) return { x: 0, y: guide.y - from.y }
  const t = ((guide.x - from.x) * vx + (guide.y - from.y) * vy) / lengthSquared
  const projection = { x: from.x + t * vx, y: from.y + t * vy }
  return { x: guide.x - projection.x, y: guide.y - projection.y }
}
