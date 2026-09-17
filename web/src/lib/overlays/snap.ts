import type { Transform } from "@/lib/chart/transform"
import type { Candle } from "@/lib/data/mock"
import type { Point } from "./painter"

export type SnapKind = "ohlc" | "swing" | "round"

export interface SnapResult {
  kind: SnapKind
  price: number
  /** Screen position of the snapped point (for round levels: the cursor's x). */
  x: number
  y: number
  /** The bar time when the candidate is bar-anchored (ohlc/swing). */
  time?: number
  label: string
}

export interface SnapPointOptions {
  /** Screen-space tolerance (human input). */
  tolPx?: number
  kinds?: SnapKind[]
}

export interface DataSnapResult {
  kind: SnapKind
  price: number
  time?: number
  label: string
}

const SWING_LOOKBACK = 3
const ROUND_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
const PRIORITY: Record<SnapKind, number> = { swing: 0, ohlc: 1, round: 2 }

interface Ranked<T> {
  result: T
  distance: number
}

function pickBest<T extends { kind: SnapKind }>(candidates: Array<Ranked<T>>): T | null {
  let best: Ranked<T> | null = null
  for (const candidate of candidates) {
    if (
      !best ||
      PRIORITY[candidate.result.kind] < PRIORITY[best.result.kind] ||
      (PRIORITY[candidate.result.kind] === PRIORITY[best.result.kind] && candidate.distance < best.distance)
    ) {
      best = candidate
    }
  }
  return best ? best.result : null
}

/**
 * Structure snapping. Two modes, one candidate set:
 *  - `snapPoint` (pixels): human input; nearest candidate within tolPx, ohlc/swing
 *    preferred over round levels on near-ties.
 *  - `snapPrice` (data): agent ops; nearest candidate within a price tolerance computed
 *    from ATR, deterministic regardless of zoom.
 */
export class SnapEngine {
  private bars: Candle[] = []
  private swingCache: { length: number; pivots: Array<{ index: number; kind: "high" | "low"; price: number }> } | null = null

  setBars(bars: Candle[]): void {
    this.bars = bars
    this.swingCache = null
  }

  get barCount(): number {
    return this.bars.length
  }

  /** Simple ATR over the last `period` bars; the basis for agent snap tolerance. */
  atr(period = 14): number | null {
    const bars = this.bars
    if (bars.length < period + 1) return null
    let sum = 0
    for (let i = bars.length - period; i < bars.length; i++) {
      const bar = bars[i]
      const previous = bars[i - 1]
      sum += Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      )
    }
    return sum / period
  }

  private pivots(): Array<{ index: number; kind: "high" | "low"; price: number }> {
    if (this.swingCache && this.swingCache.length === this.bars.length) return this.swingCache.pivots
    const pivots: Array<{ index: number; kind: "high" | "low"; price: number }> = []
    const k = SWING_LOOKBACK
    for (let i = k; i < this.bars.length - k; i++) {
      const bar = this.bars[i]
      let isHigh = true
      let isLow = true
      for (let j = i - k; j <= i + k && (isHigh || isLow); j++) {
        if (j === i) continue
        if (this.bars[j].high >= bar.high) isHigh = false
        if (this.bars[j].low <= bar.low) isLow = false
      }
      if (isHigh) pivots.push({ index: i, kind: "high", price: bar.high })
      if (isLow) pivots.push({ index: i, kind: "low", price: bar.low })
    }
    this.swingCache = { length: this.bars.length, pivots }
    return pivots
  }

  snapPoint(pt: Point, t: Transform, opts: SnapPointOptions = {}): SnapResult | null {
    const tolPx = opts.tolPx ?? 8
    const kinds = opts.kinds
    const range = t.visibleLogicalRange()
    if (!range) return null
    const from = Math.max(0, Math.floor(range.from) - 1)
    const to = Math.min(this.bars.length - 1, Math.ceil(range.to) + 1)

    const candidates: Array<Ranked<SnapResult>> = []
    const consider = (candidate: SnapResult, distance: number) => {
      if (kinds && !kinds.includes(candidate.kind)) return
      if (distance > tolPx) return
      candidates.push({ result: candidate, distance })
    }

    for (let i = from; i <= to; i++) {
      const bar = this.bars[i]
      const x = t.xOfLogical(i)
      if (x == null) continue
      const fields: Array<[string, number]> = [
        ["o", bar.open],
        ["h", bar.high],
        ["l", bar.low],
        ["c", bar.close],
      ]
      for (const [field, price] of fields) {
        const y = t.yOfPrice(price)
        if (y == null) continue
        consider(
          { kind: "ohlc", price, time: bar.time, x, y, label: `${field} ${price.toFixed(2)}` },
          Math.hypot(pt.x - x, pt.y - y),
        )
      }
    }

    for (const pivot of this.pivots()) {
      if (pivot.index < from || pivot.index > to) continue
      const x = t.xOfLogical(pivot.index)
      const y = t.yOfPrice(pivot.price)
      if (x == null || y == null) continue
      consider(
        {
          kind: "swing",
          price: pivot.price,
          time: this.bars[pivot.index].time,
          x,
          y,
          label: `swing ${pivot.kind} ${pivot.price.toFixed(2)}`,
        },
        Math.hypot(pt.x - x, pt.y - y),
      )
    }

    const priceRange = t.visiblePriceRange()
    if (priceRange) {
      const step = roundStep(priceRange.max - priceRange.min)
      for (let price = Math.ceil(priceRange.min / step) * step; price <= priceRange.max; price += step) {
        const y = t.yOfPrice(price)
        if (y == null) continue
        consider({ kind: "round", price, x: pt.x, y, label: `level ${price.toFixed(2)}` }, Math.abs(pt.y - y))
      }
    }

    return pickBest(candidates)
  }

  snapPrice(price: number, tolPrice: number, kinds: SnapKind[] = ["ohlc", "swing", "round"]): DataSnapResult | null {
    const candidates: Array<Ranked<DataSnapResult>> = []
    const consider = (candidate: DataSnapResult, distance: number) => {
      if (!kinds.includes(candidate.kind) || distance > tolPrice) return
      candidates.push({ result: candidate, distance })
    }

    for (const bar of this.bars) {
      const fields: Array<[string, number]> = [
        ["o", bar.open],
        ["h", bar.high],
        ["l", bar.low],
        ["c", bar.close],
      ]
      for (const [field, value] of fields) {
        consider({ kind: "ohlc", price: value, time: bar.time, label: `${field} ${value.toFixed(2)}` }, Math.abs(value - price))
      }
    }
    for (const pivot of this.pivots()) {
      consider(
        {
          kind: "swing",
          price: pivot.price,
          time: this.bars[pivot.index].time,
          label: `swing ${pivot.kind} ${pivot.price.toFixed(2)}`,
        },
        Math.abs(pivot.price - price),
      )
    }
    const step = levelStep(price)
    for (let level = Math.floor(price / step) * step; level <= price + step; level += step) {
      consider({ kind: "round", price: level, label: `level ${level.toFixed(2)}` }, Math.abs(level - price))
    }

    return pickBest(candidates)
  }
}

/** Nice level spacing for a visible price range (~40 candidates). */
export function roundStep(range: number): number {
  const target = Math.max(range / 40, 1e-9)
  for (const step of ROUND_STEPS) {
    if (step >= target) return step
  }
  return ROUND_STEPS[ROUND_STEPS.length - 1]
}

/** Nice level spacing around a single price (agent data-space snapping). */
export function levelStep(price: number): number {
  if (price < 50) return 1
  if (price < 200) return 5
  if (price < 1000) return 10
  if (price < 5000) return 50
  if (price < 20000) return 100
  return 500
}
