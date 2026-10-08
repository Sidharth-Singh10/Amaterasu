import type { Renderer } from "../registry"
import { activeColor, baseWidth } from "./common"

/** Horizontal level: spans the full pane width at `points[0].p`. */
export const hlineRenderer: Renderer = {
  kind: "hline",
  draw(a, t, p, env) {
    const y = t.yOfPrice(a.points[0].p)
    if (y == null) return
    const color = activeColor(a, env)
    const width = env.selected ? baseWidth(a) + 0.5 : baseWidth(a)
    const snapY = p.snapCenter(y)
    if (a.style.dash) p.dashedLine(0, snapY, t.cssWidth, snapY, { color, width, dash: [6, 4] })
    else p.line(0, snapY, t.cssWidth, snapY, { color, width })
    if (a.label) {
      p.text(t.cssWidth - 6, snapY - 4, a.label, {
        color,
        fontSize: a.style.fontSize ?? 11,
        align: "right",
        baseline: "bottom",
      })
    }
  },
  hitTest(a, t, pt, tol) {
    const y = t.yOfPrice(a.points[0].p)
    if (y == null) return null
    const distance = Math.abs(pt.y - y)
    return distance <= tol ? distance : null
  },
}
