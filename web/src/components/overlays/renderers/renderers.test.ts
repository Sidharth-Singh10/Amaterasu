import { describe, expect, it } from "vitest"
import type { Annotation, Kind } from "@amaterasu/chart-dsl"
import { Transform } from "@/lib/chart/transform"
import { makeFakeAdapters } from "@/lib/testing/fake-adapters"
import { RecordingPainter, type RecordedOp } from "../painter"
import { getRenderer } from "../registry"
import { registerBuiltinRenderers } from "./index"

const DAY = 86_400
const START = Math.floor(Date.UTC(2025, 0, 1) / 1000)
const BARS = Array.from({ length: 200 }, (_, i) => START + i * DAY)

const close = (actual: number, expected: number, eps = 1e-6) => Math.abs(actual - expected) <= eps

function makeTransform() {
  const { scale, price } = makeFakeAdapters({
    bars: BARS,
    visibleFrom: 100,
    pxPerBar: 8,
    width: 800,
    height: 400,
    priceMin: 1000,
    priceMax: 1300,
  })
  return new Transform({ scale, price, bars: BARS, cssWidth: 800, cssHeight: 400, dpr: 1 })
}

function annotation(kind: Kind, points: Annotation["points"], extra?: Partial<Annotation>): Annotation {
  return {
    id: "test",
    kind,
    points,
    style: {},
    z: 0,
    hidden: false,
    locked: false,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

function render(kind: Kind, points: Annotation["points"], extra?: Partial<Annotation>) {
  registerBuiltinRenderers()
  const renderer = getRenderer(kind)
  if (!renderer) throw new Error(`no renderer for ${kind}`)
  const painter = new RecordingPainter()
  const transform = makeTransform()
  const ann = annotation(kind, points, extra)
  painter.begin()
  renderer.draw(ann, transform, painter, { selected: false, hovered: false })
  return { painter, transform, ann, op: (name: string): RecordedOp | undefined => painter.ops.find((o) => o.name === name) }
}

describe("trendline renderer", () => {
  const points = [
    { t: BARS[110], p: 1100 },
    { t: BARS[130], p: 1250 },
  ]

  it("draws a line between the resolved endpoints", () => {
    const { op } = render("trendline", points)
    const line = op("line")
    expect(line).toBeDefined()
    const [x1, y1, x2, y2] = line!.args as [number, number, number, number]
    // x = (li - 100) * 8; y = 400 * (1300 - p) / 300
    expect(close(x1, 80)).toBe(true)
    expect(close(y1, 400 * (200 / 300))).toBe(true)
    expect(close(x2, 240)).toBe(true)
    expect(close(y2, 400 * (50 / 300))).toBe(true)
  })

  it("hit-tests near the segment and misses far away", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("trendline")!
    const t = makeTransform()
    const ann = annotation("trendline", points)
    const midpoint = { x: 160, y: (400 * (200 / 300) + 400 * (50 / 300)) / 2 }
    expect(renderer.hitTest!(ann, t, midpoint, 6)).not.toBeNull()
    expect(renderer.hitTest!(ann, t, { x: midpoint.x, y: midpoint.y + 20 }, 6)).toBeNull()
  })

  it("draws nothing when an anchor is unresolvable", () => {
    const { painter } = render("trendline", [
      { t: BARS[0] - 10 * DAY, p: 1100 },
      { t: BARS[130], p: 1250 },
    ])
    expect(painter.ops.filter((o) => o.name === "line")).toHaveLength(0)
  })
})

describe("ray renderer", () => {
  it("extends through the second point to the pane edge", () => {
    const { op } = render("ray", [
      { t: BARS[110], p: 1100 },
      { t: BARS[130], p: 1250 },
    ])
    const line = op("line")
    expect(line).toBeDefined()
    const [, , x2, y2] = line!.args as [number, number, number, number]
    // Slope: 160px right / -200px up from (80, 266.67) → hits the top edge (y≈0) at x≈293.33.
    expect(close(y2, 0, 1e-6)).toBe(true)
    expect(close(x2, 80 + 160 * (400 * (200 / 300) / 200), 1e-6)).toBe(true)
  })
})

describe("hline renderer", () => {
  it("draws a snapped horizontal line across the pane", () => {
    const { op } = render("hline", [{ t: BARS[110], p: 1200 }])
    const line = op("line")
    const [x1, y1, x2, y2] = line!.args as [number, number, number, number]
    const y = 400 * ((1300 - 1200) / 300)
    expect(x1).toBe(0)
    expect(x2).toBe(800)
    expect(close(y1, Math.round(y) - 0.5)).toBe(true)
    expect(close(y2, Math.round(y) - 0.5)).toBe(true)
  })

  it("hit-tests by vertical distance", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("hline")!
    const t = makeTransform()
    const ann = annotation("hline", [{ t: BARS[110], p: 1200 }])
    const y = 400 * ((1300 - 1200) / 300)
    expect(renderer.hitTest!(ann, t, { x: 10, y: y + 2 }, 6)).not.toBeNull()
    expect(renderer.hitTest!(ann, t, { x: 10, y: y + 20 }, 6)).toBeNull()
  })
})

describe("vline renderer", () => {
  it("draws a snapped vertical line across the pane", () => {
    const { op } = render("vline", [{ t: BARS[110], p: 1200 }])
    const line = op("line")
    const [x1, y1, x2, y2] = line!.args as [number, number, number, number]
    expect(close(x1, Math.round(80) - 0.5)).toBe(true)
    expect(close(x2, Math.round(80) - 0.5)).toBe(true)
    expect(y1).toBe(0)
    expect(y2).toBe(400)
  })
})

describe("rect renderer", () => {
  const points = [
    { t: BARS[110], p: 1050 },
    { t: BARS[130], p: 1250 },
  ]

  it("draws a bounded rect from two corners", () => {
    const { op } = render("rect", points)
    const rect = op("rect")
    expect(rect).toBeDefined()
    const [x, y, w, h] = rect!.args as [number, number, number, number]
    expect(close(x, 80)).toBe(true)
    expect(close(y, 400 * (50 / 300))).toBe(true)
    expect(close(w, 160)).toBe(true)
    expect(close(h, 400 * (200 / 300))).toBe(true)
  })

  it("hits inside with distance 0 and misses beyond the tolerance", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("rect")!
    const t = makeTransform()
    const ann = annotation("rect", points)
    expect(renderer.hitTest!(ann, t, { x: 160, y: 200 }, 6)).toBe(0)
    expect(renderer.hitTest!(ann, t, { x: 160, y: 60 }, 6)).toBeNull()
  })
})

describe("label renderer", () => {
  it("draws an anchor dot and hit-tests within a 12px radius", () => {
    const { op, transform, ann } = render("label", [{ t: BARS[110], p: 1200 }])
    expect(op("markerIcon")).toBeDefined()
    const renderer = getRenderer("label")!
    const point = { x: 80, y: 400 * ((1300 - 1200) / 300) }
    expect(renderer.hitTest!(ann, transform, point, 6)).not.toBeNull()
    expect(renderer.hitTest!(ann, transform, { x: point.x + 30, y: point.y }, 6)).toBeNull()
  })
})

describe("painter geometry", () => {
  it("records dashed lines with a dash hint", () => {
    registerBuiltinRenderers()
    const painter = new RecordingPainter()
    const transform = makeTransform()
    const renderer = getRenderer("trendline")!
    const ann = annotation(
      "trendline",
      [
        { t: BARS[110], p: 1100 },
        { t: BARS[130], p: 1250 },
      ],
      { style: { dash: true } },
    )
    painter.begin()
    renderer.draw(ann, transform, painter, { selected: false, hovered: false })
    expect(painter.ops.some((o) => o.name === "dashedLine")).toBe(true)
    expect(painter.ops.some((o) => o.name === "line")).toBe(false)
  })
})
