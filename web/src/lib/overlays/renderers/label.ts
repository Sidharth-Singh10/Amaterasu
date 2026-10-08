import type { Renderer } from "../registry"
import { activeColor } from "./common"

/**
 * Text callout. The pill itself is rendered by the DOM labels layer (selectable text,
 * wrapping, no canvas measureText cost); this renderer draws only the anchor dot and
 * owns hit-testing for selection.
 */
export const labelRenderer: Renderer = {
  kind: "label",
  draw(a, t, p, env) {
    const resolved = t.resolve(a.points[0])
    if (!resolved.ok) return
    const color = activeColor(a, env)
    p.markerIcon("circle", { x: resolved.x, y: resolved.y }, { color, size: 3 })
  },
  hitTest(a, t, pt, tol) {
    const resolved = t.resolve(a.points[0])
    if (!resolved.ok) return null
    const distance = Math.hypot(pt.x - resolved.x, pt.y - resolved.y)
    const effective = Math.max(tol, 12)
    return distance <= effective ? distance : null
  },
}
