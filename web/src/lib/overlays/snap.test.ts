import { describe, expect, it } from "vitest"
import { Transform } from "@/lib/chart/transform"
import { makeFakeAdapters } from "@/lib/testing/fake-adapters"
import { SnapEngine, levelStep, roundStep } from "./snap"

const DAY = 86_400
const START = Math.floor(Date.UTC(2025, 0, 1) / 1000)

/** A deterministic series with two obvious pivots: a low at index 10, a high at index 20. */
function makeBars() {
  const bars = []
  for (let i = 0; i < 40; i++) {
    const base = 1000 + i
    let low = base - 5
    let high = base + 5
    if (i === 10) low = 940
    if (i === 20) high = 1120
    bars.push({
      time: START + i * DAY,
      open: base,
      high,
      low,
      close: base + 1,
      volume: 1000 + i,
    })
  }
  return bars
}

function makeTransform(visibleFrom = 0) {
  const bars = makeBars().map((bar) => bar.time)
  const { scale, price } = makeFakeAdapters({
    bars,
    visibleFrom,
    pxPerBar: 10,
    width: 800,
    height: 600,
    priceMin: 900,
    priceMax: 1200,
  })
  return new Transform({ scale, price, bars, cssWidth: 800, cssHeight: 600, dpr: 1 })
}

describe("SnapEngine.snapPoint", () => {
  it("snaps the cursor to a swing pivot and returns its bar time", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    const t = makeTransform()
    // index 10 → x = 100; low 940 → y = 600 * (1200-940)/300 = 520
    const result = snap.snapPoint({ x: 103, y: 523 }, t, { tolPx: 8 })
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("swing")
    expect(result!.price).toBe(940)
    expect(result!.time).toBe(START + 10 * DAY)
  })

  it("snaps to OHLC points when the cursor is closest to one", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    const t = makeTransform()
    // index 30 close = 1031 → y = 600 * (1200-1031)/300 = 338, x = 300
    const result = snap.snapPoint({ x: 301, y: 337 }, t, { tolPx: 6 })
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("ohlc")
    expect(result!.price).toBe(1031)
  })

  it("snaps to round levels when no bar value is closer", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    const t = makeTransform()
    // 1050 is a round level; no bar value sits within 6px of it at this x.
    const y = 600 * ((1200 - 1050) / 300)
    const result = snap.snapPoint({ x: 300, y }, t, { tolPx: 6 })
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("round")
    expect(result!.price).toBe(1050)
  })

  it("returns null beyond the tolerance", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    const t = makeTransform()
    // y = 210 sits between the 1090/1100 levels (20px apart) and far from any bar value.
    const result = snap.snapPoint({ x: 100, y: 210 }, t, { tolPx: 6 })
    expect(result).toBeNull()
  })

  it("prefers structure over round levels on near-ties", () => {
    const bars = makeBars()
    bars[30].close = 1050
    const snap = new SnapEngine()
    snap.setBars(bars)
    const t = makeTransform()
    // index 30 x = 300; both the close (1050) and the 1050 round level are here.
    const result = snap.snapPoint({ x: 300, y: 600 * ((1200 - 1050) / 300) }, t, { tolPx: 8 })
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("ohlc")
  })
})

describe("SnapEngine.snapPrice (agent mode)", () => {
  it("snaps to the nearest OHLC value with its bar time", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    const result = snap.snapPrice(1031.4, 2, ["ohlc"])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("ohlc")
    expect(result!.price).toBe(1031)
    // Ties on price go to the earliest bar; the invariant is that the bar really has this value.
    const bar = makeBars().find((candidate) => candidate.time === result!.time)
    expect(bar).toBeDefined()
    expect([bar!.open, bar!.high, bar!.low, bar!.close]).toContain(1031)
  })

  it("snaps to swing pivots when asked", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    const result = snap.snapPrice(941, 3, ["swing"])
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("swing")
    expect(result!.price).toBe(940)
    expect(result!.time).toBe(START + 10 * DAY)
  })

  it("is zoom-independent: no transform involved", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    const first = snap.snapPrice(1031.2, 2)
    const second = snap.snapPrice(1031.2, 2)
    expect(first).toEqual(second)
  })

  it("returns null outside the tolerance", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    // 1004.7 is 0.3 away from the closest bar value; a 0.01 tolerance must reject it.
    expect(snap.snapPrice(1004.7, 0.01, ["ohlc", "swing"])).toBeNull()
  })

  it("computes ATR over the recent bars", () => {
    const snap = new SnapEngine()
    snap.setBars(makeBars())
    const atr = snap.atr(14)
    expect(atr).not.toBeNull()
    expect(atr!).toBeGreaterThan(0)
  })
})

describe("level helpers", () => {
  it("picks sane round steps", () => {
    expect(roundStep(300)).toBeLessThanOrEqual(10)
    expect(roundStep(3)).toBeLessThanOrEqual(1)
    expect(levelStep(1243)).toBe(50)
    expect(levelStep(42)).toBe(1)
    expect(levelStep(15000)).toBe(100)
  })
})
