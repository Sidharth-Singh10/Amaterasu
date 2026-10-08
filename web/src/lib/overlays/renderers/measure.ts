import type { Renderer } from "../registry"
import { distToSegment } from "../hit"
import { lineStyle, resolvePoints } from "./common"
import { palette } from "@/lib/theme/palette"

/**
 * Measurement between two anchors: a dashed connector and a badge with Δ price, Δ %
 * and the bar span. Computed client-side from the resolved anchors.
 */
export const measureRenderer: Renderer = {
  kind: "measure",
  draw(a, t, p, env) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 2) return
    const [from, to] = points
    const first = t.resolve(a.points[0])
    const second = t.resolve(a.points[1])
    if (!first.ok || !second.ok) return
    const style = lineStyle(a, env)
    p.dashedLine(from.x, from.y, to.x, to.y, { ...style, dash: [4, 3] })
    p.markerIcon("circle", from, { color: style.color, size: 3 })
    p.markerIcon("circle", to, { color: style.color, size: 3 })

    const deltaPrice = a.points[1].p - a.points[0].p
    const deltaPct = a.points[0].p !== 0 ? (deltaPrice / a.points[0].p) * 100 : 0
    const bars = Math.round(Math.abs(second.li - first.li))
    const sign = deltaPrice >= 0 ? "+" : ""
    const text = `Δ ${sign}${deltaPrice.toFixed(2)} (${sign}${deltaPct.toFixed(2)}%) · ${bars} bars`

    const midX = (from.x + to.x) / 2
    const midY = (from.y + to.y) / 2
    const fontSize = a.style.fontSize ?? 11
    const width = text.length * fontSize * 0.62 + 12
    p.rect(midX - width / 2, midY - 20, width, 18, { color: palette.labelBg, opacity: 1 }, {
      color: style.color,
      width: 1,
    })
    p.text(midX, midY - 11, text, {
      color: a.style.color ?? palette.shapeText,
      fontSize,
      align: "center",
      baseline: "middle",
    })
  },
  hitTest(a, t, pt, tol) {
    const points = resolvePoints(a, t)
    if (!points || points.length < 2) return null
    const distance = distToSegment(pt, points[0], points[1])
    return distance <= Math.max(tol, 8) ? distance : null
  },
  handles: true,
}
