import type { PriceAdapter, ScaleAdapter } from "@/lib/chart/transform"

/**
 * Fake scale/price adapters with exact linear mappings, so resolver and renderer tests
 * can assert pixel geometry as numbers. Not shipped to the app.
 */

export interface FakeAdaptersOptions {
  bars: readonly number[]
  /** Logical index at x = 0. */
  visibleFrom: number
  pxPerBar: number
  width: number
  height: number
  priceMin: number
  priceMax: number
}

export function makeFakeAdapters(o: FakeAdaptersOptions): { scale: ScaleAdapter; price: PriceAdapter } {
  const { bars, visibleFrom, pxPerBar, width, height, priceMin, priceMax } = o

  const indexByTime = new Map<number, number>()
  bars.forEach((t, i) => indexByTime.set(t, i))

  const xOfLogical = (li: number) => (li - visibleFrom) * pxPerBar
  const logicalOfX = (x: number) => x / pxPerBar + visibleFrom

  const nearestIndex = (t: number): number | null => {
    if (bars.length === 0) return null
    let lo = 0
    let hi = bars.length - 1
    if (t <= bars[lo]) return lo
    if (t >= bars[hi]) return hi
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (bars[mid] <= t) lo = mid
      else hi = mid
    }
    return t - bars[lo] <= bars[hi] - t ? lo : hi
  }

  const scale: ScaleAdapter = {
    timeToCoordinate: (t) => {
      const i = indexByTime.get(t)
      return i === undefined ? null : xOfLogical(i)
    },
    coordinateToTime: (x) => {
      const i = Math.round(logicalOfX(x))
      return i >= 0 && i < bars.length ? bars[i] : null
    },
    logicalToCoordinate: (li) => xOfLogical(li),
    coordinateToLogical: (x) => logicalOfX(x),
    timeToIndex: (t, findNearest) => {
      const exact = indexByTime.get(t)
      if (exact !== undefined) return exact
      return findNearest ? nearestIndex(t) : null
    },
    visibleLogicalRange: () => ({ from: visibleFrom, to: visibleFrom + width / pxPerBar }),
  }

  const yOfPrice = (p: number) => (height * (priceMax - p)) / (priceMax - priceMin)
  const priceOfY = (y: number) => priceMax - (y / height) * (priceMax - priceMin)

  const price: PriceAdapter = {
    priceToCoordinate: (p) => yOfPrice(p),
    coordinateToPrice: (y) => priceOfY(y),
  }

  return { scale, price }
}
