import { describe, expect, it } from "vitest"
import { makeFakeAdapters } from "@/lib/testing/fake-adapters"
import { TIER2_WARNING, TIER3_WARNING, Transform, medianBarDuration } from "./transform"

const DAY = 86_400
const START = Math.floor(Date.UTC(2025, 0, 1) / 1000)
const BARS = Array.from({ length: 200 }, (_, i) => START + i * DAY)

function makeTransform(overrides?: { visibleFrom?: number; pxPerBar?: number }) {
  const width = 800
  const height = 400
  const visibleFrom = overrides?.visibleFrom ?? 100
  const pxPerBar = overrides?.pxPerBar ?? 8
  const { scale, price } = makeFakeAdapters({
    bars: BARS,
    visibleFrom,
    pxPerBar,
    width,
    height,
    priceMin: 1000,
    priceMax: 1300,
  })
  return new Transform({ scale, price, bars: BARS, cssWidth: width, cssHeight: height, dpr: 2 })
}

const close = (actual: number, expected: number, eps = 1e-6) => Math.abs(actual - expected) <= eps

describe("Transform resolver", () => {
  it("resolves an exact bar time as tier 1", () => {
    const t = makeTransform()
    const result = t.resolve({ t: BARS[150], p: 1150 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tier).toBe(1)
    expect(result.exact).toBe(true)
    expect(close(result.x, 400)).toBe(true)
    expect(close(result.y, 200)).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it("applies liOffset on an exact anchor", () => {
    const t = makeTransform()
    const result = t.resolve({ t: BARS[150], p: 1150, liOffset: 0.5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(close(result.li, 150.5)).toBe(true)
    expect(close(result.x, 404)).toBe(true)
  })

  it("resolves between-bars times as tier 2 with a residual and warning", () => {
    const t = makeTransform()
    const result = t.resolve({ t: BARS[150] + DAY / 4, p: 1150 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tier).toBe(2)
    expect(result.exact).toBe(false)
    expect(close(result.li, 150.25)).toBe(true)
    expect(close(result.x, 402)).toBe(true)
    expect(result.warnings).toContain(TIER2_WARNING)
  })

  it("extrapolates beyond the last loaded bar as tier 3", () => {
    const t = makeTransform()
    const result = t.resolve({ t: BARS[199] + 3 * DAY, p: 1150 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tier).toBe(3)
    expect(close(result.li, 202)).toBe(true)
    expect(close(result.x, 816)).toBe(true)
    expect(result.warnings).toContain(TIER3_WARNING)
  })

  it("fails hard before the loaded window", () => {
    const t = makeTransform()
    const result = t.resolve({ t: BARS[0] - DAY, p: 1150 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("before-loaded-window")
  })

  it("fails with no data", () => {
    const { scale, price } = makeFakeAdapters({
      bars: [],
      visibleFrom: 0,
      pxPerBar: 8,
      width: 800,
      height: 400,
      priceMin: 1000,
      priceMax: 1300,
    })
    const t = new Transform({ scale, price, bars: [], cssWidth: 800, cssHeight: 400, dpr: 1 })
    const result = t.resolve({ t: START, p: 1150 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("no-data")
  })

  it("round-trips logical index → anchor → pixel", () => {
    const t = makeTransform()
    for (const li of [100, 125.5, 199.25, 60]) {
      const anchor = t.anchorFromLogical(li, 1100)
      expect(anchor).not.toBeNull()
      const resolved = t.resolve(anchor!)
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) continue
      expect(close(resolved.li, li)).toBe(true)
      expect(close(resolved.x, (li - 100) * 8)).toBe(true)
    }
  })

  it("round-trips pixel → anchor → pixel within half a pixel", () => {
    const t = makeTransform()
    for (const pt of [
      { x: 400, y: 200 },
      { x: 402, y: 180 },
      { x: 120, y: 300 },
    ]) {
      const anchor = t.anchorAt(pt.x, pt.y)
      expect(anchor).not.toBeNull()
      const back = t.pixelOf(anchor!)
      expect(back).not.toBeNull()
      expect(close(back!.x, pt.x, 0.5)).toBe(true)
      expect(close(back!.y, pt.y, 0.5)).toBe(true)
    }
  })

  it("reports the visible price range from the pane edges", () => {
    const t = makeTransform()
    const range = t.visiblePriceRange()
    expect(range).not.toBeNull()
    expect(close(range!.min, 1000)).toBe(true)
    expect(close(range!.max, 1300)).toBe(true)
  })
})

describe("medianBarDuration", () => {
  it("returns the middle bar spacing", () => {
    expect(medianBarDuration([0, 86_400, 172_800])).toBe(86_400)
  })

  it("returns null with fewer than two bars", () => {
    expect(medianBarDuration([])).toBeNull()
    expect(medianBarDuration([5])).toBeNull()
  })
})
