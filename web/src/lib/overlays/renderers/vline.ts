import type { Renderer } from "../registry"
import { baseColor, baseWidth } from "./common"

/** Vertical line at the resolved x of `points[0]` (supports liOffset projection). */
export const vlineRenderer: Renderer = {
  kind: "vline",
  draw(a, t, p, env) {
    const resolved = t.resolve(a.points[0])
    if (!resolved.ok) return
    const color = env.selected ? "#f0b429" : baseColor(a)
    const width = env.selected ? baseWidth(a) + 0.5 : baseWidth(a)
    const snapX = p.snapCenter(resolved.x)
    if (a.style.dash) p.dashedLine(snapX, 0, snapX, t.cssHeight, { color, width, dash: [6, 4] })
    else p.line(snapX, 0, snapX, t.cssHeight, { color, width })
    if (a.label) {
      p.text(snapX + 6, 14, a.label, {
        color,
        fontSize: a.style.fontSize ?? 11,
        align: "left",
        baseline: "top",
      })
    }
  },
  hitTest(a, t, pt, tol) {
    const resolved = t.resolve(a.points[0])
    if (!resolved.ok) return null
    const distance = Math.abs(pt.x - resolved.x)
    return distance <= tol ? distance : null
  },
}
