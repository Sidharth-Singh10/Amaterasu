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

describe("hzone renderer", () => {
  const points = [
    { t: BARS[110], p: 1200 },
    { t: BARS[130], p: 1150 },
  ]

  it("draws a full-width band between the two prices", () => {
    const { op } = render("hzone", points)
    const rect = op("rect")
    expect(rect).toBeDefined()
    const [x, y, w, h] = rect!.args as [number, number, number, number]
    const top = 400 * ((1300 - 1200) / 300)
    const bottom = 400 * ((1300 - 1150) / 300)
    expect(x).toBe(0)
    expect(close(w, 800)).toBe(true)
    expect(close(y, top)).toBe(true)
    expect(close(h, bottom - top)).toBe(true)
  })

  it("hits inside the band and misses outside the tolerance", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("hzone")!
    const t = makeTransform()
    const ann = annotation("hzone", points)
    const inside = 400 * ((1300 - 1175) / 300)
    expect(renderer.hitTest!(ann, t, { x: 100, y: inside }, 6)).toBe(0)
    const above = 400 * ((1300 - 1100) / 300)
    expect(renderer.hitTest!(ann, t, { x: 100, y: above }, 6)).toBeNull()
  })
})

describe("vzone renderer", () => {
  const points = [
    { t: BARS[110], p: 1200 },
    { t: BARS[130], p: 1200 },
  ]

  it("draws a full-height band between the two times", () => {
    const { op } = render("vzone", points)
    const rect = op("rect")
    expect(rect).toBeDefined()
    const [x, y, w, h] = rect!.args as [number, number, number, number]
    expect(close(x, 80)).toBe(true)
    expect(y).toBe(0)
    expect(close(w, 160)).toBe(true)
    expect(close(h, 400)).toBe(true)
  })

  it("hits inside the time band", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("vzone")!
    const t = makeTransform()
    const ann = annotation("vzone", points)
    expect(renderer.hitTest!(ann, t, { x: 160, y: 200 }, 6)).toBe(0)
    expect(renderer.hitTest!(ann, t, { x: 320, y: 200 }, 6)).toBeNull()
  })
})

describe("marker renderer", () => {
  it("draws the configured glyph and label", () => {
    const { op } = render(
      "marker",
      [{ t: BARS[110], p: 1200 }],
      { label: "swing low", style: { shape: "arrowUp", color: "#26a69a" } },
    )
    const icon = op("markerIcon")
    expect(icon).toBeDefined()
    expect(icon!.args[0]).toBe("arrowUp")
    const text = op("text")
    expect(text).toBeDefined()
    expect(text!.args[2]).toBe("swing low")
  })

  it("hit-tests within a 12px radius", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("marker")!
    const t = makeTransform()
    const ann = annotation("marker", [{ t: BARS[110], p: 1200 }])
    const point = { x: 80, y: 400 * ((1300 - 1200) / 300) }
    expect(renderer.hitTest!(ann, t, point, 6)).not.toBeNull()
    expect(renderer.hitTest!(ann, t, { x: point.x + 30, y: point.y }, 6)).toBeNull()
  })
})

describe("measure renderer", () => {
  const points = [
    { t: BARS[100], p: 1100 },
    { t: BARS[130], p: 1200 },
  ]

  it("draws a connector and a badge with the deltas", () => {
    const { op } = render("measure", points)
    expect(op("dashedLine")).toBeDefined()
    const text = op("text")
    expect(text).toBeDefined()
    const label = String(text!.args[2])
    expect(label).toContain("+100.00")
    expect(label).toContain("+9.09%")
    expect(label).toContain("30 bars")
  })

  it("hit-tests along the connector", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("measure")!
    const t = makeTransform()
    const ann = annotation("measure", points)
    const from = { x: 0, y: 400 * ((1300 - 1100) / 300) }
    const to = { x: 240, y: 400 * ((1300 - 1200) / 300) }
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    expect(renderer.hitTest!(ann, t, mid, 6)).not.toBeNull()
    expect(renderer.hitTest!(ann, t, { x: mid.x, y: mid.y + 40 }, 6)).toBeNull()
  })
})

describe("fib renderer", () => {
  const points = [
    { t: BARS[100], p: 1100 },
    { t: BARS[130], p: 1200 },
  ]

  it("draws seven levels with price labels", () => {
    const { painter } = render("fib", points)
    const lines = painter.ops.filter((o) => o.name === "line")
    expect(lines).toHaveLength(7)
    // 50% sits midway: p = 1150 → y = 200
    const midLine = lines.find((line) => close((line.args as number[])[1], 200))
    expect(midLine).toBeDefined()
    const text = painter.ops.find(
      (op) => op.name === "text" && String((op.args as unknown[])[2]).includes("50.0%"),
    )
    expect(text).toBeDefined()
    expect(String((text!.args as unknown[])[2])).toContain("1150.00")
  })

  it("hits on a level line and misses between levels", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("fib")!
    const t = makeTransform()
    const ann = annotation("fib", points)
    expect(renderer.hitTest!(ann, t, { x: 100, y: 200 }, 6)).toBe(0)
    expect(renderer.hitTest!(ann, t, { x: 100, y: 250 }, 6)).toBeNull()
  })
})

describe("channel renderer", () => {
  const points = [
    { t: BARS[100], p: 1100 },
    { t: BARS[130], p: 1200 },
    { t: BARS[100], p: 1150 },
  ]

  it("draws two parallel rails and a fill", () => {
    const { painter, op } = render("channel", points)
    expect(op("polygon")).toBeDefined()
    const lines = painter.ops.filter((o) => o.name === "line")
    expect(lines).toHaveLength(2)
    const [x1, y1, x2, y2] = lines[0].args as [number, number, number, number]
    expect(close(x1, 0)).toBe(true)
    expect(close(y1, 400 * (200 / 300))).toBe(true)
    expect(close(x2, 240)).toBe(true)
    expect(close(y2, 400 * (100 / 300))).toBe(true)
  })

  it("hit-tests either rail", () => {
    registerBuiltinRenderers()
    const renderer = getRenderer("channel")!
    const t = makeTransform()
    const ann = annotation("channel", points)
    const midRail = { x: 120, y: (400 * (200 / 300) + 400 * (100 / 300)) / 2 }
    expect(renderer.hitTest!(ann, t, midRail, 6)).not.toBeNull()
    expect(renderer.hitTest!(ann, t, { x: midRail.x, y: midRail.y + 80 }, 6)).toBeNull()
  })
})
