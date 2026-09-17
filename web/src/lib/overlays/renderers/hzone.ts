import type { Renderer } from "../registry"
import { baseColor, drawShapeLabel, lineStyle } from "./common"

/**
 * Price band spanning the full pane width between `points[0].p` and `points[1].p`
 * (supply/demand zone). Only prices matter; the anchors' times are unused.
 */
export const hzoneRenderer: Renderer = {
  kind: "hzone",
  draw(a, t, p, env) {
    const y1 = t.yOfPrice(a.points[0].p)
    const y2 = t.yOfPrice(a.points[1]?.p ?? a.points[0].p)
    if (y1 == null || y2 == null) return
    const top = Math.min(y1, y2)
    const height = Math.max(Math.abs(y2 - y1), 1)
    const fillColor = a.style.fill ?? baseColor(a)
    const stroke = lineStyle(a, env)
    p.rect(0, top, t.cssWidth, height, { color: fillColor, opacity: a.style.fillOpacity ?? 0.12 }, {
      ...stroke,
      width: Math.max(stroke.width - 0.5, 0.5),
    })
    if (env.selected) {
      for (const y of [y1, y2]) p.markerIcon("circle", { x: t.cssWidth / 2, y }, { color: "#f0b429", size: 4 })
    }
    drawShapeLabel(p, a, 6, top - 4)
  },
  hitTest(a, t, pt, tol) {
    const y1 = t.yOfPrice(a.points[0].p)
    const y2 = t.yOfPrice(a.points[1]?.p ?? a.points[0].p)
    if (y1 == null || y2 == null) return null
    const top = Math.min(y1, y2)
    const bottom = Math.max(y1, y2)
    if (pt.y >= top && pt.y <= bottom) return 0
    const distance = Math.min(Math.abs(pt.y - top), Math.abs(pt.y - bottom))
    return distance <= tol ? distance : null
  },
  handles: true,
}
