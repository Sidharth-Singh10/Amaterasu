import type { Renderer } from "../registry"
import { baseColor, drawShapeLabel, lineStyle } from "./common"

/**
 * Time band spanning the full pane height between the resolved x of `points[0]` and
 * `points[1]` (session/event window). Only times matter; the anchors' prices are unused.
 */
export const vzoneRenderer: Renderer = {
  kind: "vzone",
  draw(a, t, p, env) {
    const first = t.resolve(a.points[0])
    const second = a.points[1] ? t.resolve(a.points[1]) : first
    if (!first.ok || !second.ok) return
    const left = Math.min(first.x, second.x)
    const width = Math.max(Math.abs(second.x - first.x), 1)
    const fillColor = a.style.fill ?? baseColor(a)
    const stroke = lineStyle(a, env)
    p.rect(left, 0, width, t.cssHeight, { color: fillColor, opacity: a.style.fillOpacity ?? 0.10 }, {
      ...stroke,
      width: Math.max(stroke.width - 0.5, 0.5),
    })
    if (env.selected) {
      for (const x of [first.x, second.x]) p.markerIcon("circle", { x, y: t.cssHeight / 2 }, { color: "#f0b429", size: 4 })
    }
    drawShapeLabel(p, a, left + 6, 14)
  },
  hitTest(a, t, pt, tol) {
    const first = t.resolve(a.points[0])
    const second = a.points[1] ? t.resolve(a.points[1]) : first
    if (!first.ok || !second.ok) return null
    const left = Math.min(first.x, second.x)
    const right = Math.max(first.x, second.x)
    if (pt.x >= left && pt.x <= right) return 0
    const distance = Math.min(Math.abs(pt.x - left), Math.abs(pt.x - right))
    return distance <= tol ? distance : null
  },
  handles: true,
}
