import type { Renderer } from "../registry"
import { activeColor } from "./common"
import { palette } from "@/lib/theme/palette"

/**
 * Event marker at a price point: circle or directional arrow with optional text.
 * `style.shape` selects the glyph (`arrowUp` labels above, `arrowDown` labels below).
 */
export const markerRenderer: Renderer = {
  kind: "marker",
  draw(a, t, p, env) {
    const resolved = t.resolve(a.points[0])
    if (!resolved.ok) return
    const color = activeColor(a, env)
    const shape = a.style.shape ?? "circle"
    p.markerIcon(shape, { x: resolved.x, y: resolved.y }, { color, size: 5 })
    if (a.label) {
      const below = shape === "arrowDown"
      p.text(resolved.x + 8, below ? resolved.y + 14 : resolved.y - 10, a.label, {
        color: a.style.color ?? palette.shapeText,
        fontSize: a.style.fontSize ?? 11,
        align: "left",
        baseline: below ? "top" : "bottom",
      })
    }
  },
  hitTest(a, t, pt, tol) {
    const resolved = t.resolve(a.points[0])
    if (!resolved.ok) return null
    const distance = Math.hypot(pt.x - resolved.x, pt.y - resolved.y)
    return distance <= Math.max(tol, 12) ? distance : null
  },
}
