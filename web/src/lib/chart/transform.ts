import type { Anchor } from "@amaterasu/chart-dsl"

/**
 * The only module that talks to chart scale APIs. Everything else (renderers, hit-testing,
 * interaction, the agent bridge) consumes a Transform.
 *
 * Coordinate spaces:
 *  - data    (t, p)                    → persistence, agent ops, undo
 *  - logical (fractional bar index)    → projections into whitespace/future
 *  - CSS px  (pane-relative)           → drawing and hit-testing
 *  - physical px (CSS × dpr)           → crispness only, inside the Painter
 */

/** Narrow view of lightweight-charts' time scale so tests can use fakes. */
export interface ScaleAdapter {
  timeToCoordinate(time: number): number | null
  coordinateToTime(x: number): number | null
  logicalToCoordinate(li: number): number | null
  coordinateToLogical(x: number): number | null
  timeToIndex(time: number, findNearest?: boolean): number | null
  visibleLogicalRange(): { from: number; to: number } | null
}

export interface PriceAdapter {
  priceToCoordinate(price: number): number | null
  coordinateToPrice(y: number): number | null
}

export type ResolveFailure = "no-data" | "before-loaded-window" | "price-scale-unavailable"

export type ResolvedAnchor =
  | { ok: true; li: number; x: number; y: number; exact: boolean; tier: 1 | 2 | 3; warnings: string[] }
  | { ok: false; reason: ResolveFailure; warnings: string[] }

export interface TransformOptions {
  scale: ScaleAdapter
  price: PriceAdapter
  /** Ascending canonical bar epochs (seconds) currently loaded. */
  bars: readonly number[]
  cssWidth: number
  cssHeight: number
  dpr: number
  paneIndex?: number
}

export const TIER2_WARNING = "snapped to nearest bar (loaded data has no bar at this time)"
export const TIER3_WARNING = "extrapolated beyond the last loaded bar"
export const NO_BARS_WARNING = "no bars loaded"

export class Transform {
  readonly paneIndex: number
  private readonly bars: readonly number[]
  private readonly barDuration: number

  constructor(private readonly opts: TransformOptions) {
    this.paneIndex = opts.paneIndex ?? 0
    this.bars = opts.bars
    this.barDuration = medianBarDuration(opts.bars) ?? 60
  }

  get cssWidth(): number {
    return this.opts.cssWidth
  }

  get cssHeight(): number {
    return this.opts.cssHeight
  }

  get dpr(): number {
    return this.opts.dpr
  }

  xOfLogical(li: number): number | null {
    return this.opts.scale.logicalToCoordinate(li)
  }

  logicalOfX(x: number): number | null {
    return this.opts.scale.coordinateToLogical(x)
  }

  yOfPrice(price: number): number | null {
    return this.opts.price.priceToCoordinate(price)
  }

  priceOfY(y: number): number | null {
    return this.opts.price.coordinateToPrice(y)
  }

  timeOfX(x: number): number | null {
    return this.opts.scale.coordinateToTime(x)
  }

  visibleLogicalRange(): { from: number; to: number } | null {
    return this.opts.scale.visibleLogicalRange()
  }

  visiblePriceRange(): { min: number; max: number } | null {
    const top = this.priceOfY(0)
    const bottom = this.priceOfY(this.cssHeight)
    if (top == null || bottom == null) return null
    return { min: Math.min(top, bottom), max: Math.max(top, bottom) }
  }

  isVisible(x: number, y: number): boolean {
    return x >= 0 && x <= this.cssWidth && y >= 0 && y <= this.cssHeight
  }

  /**
   * Resolver tiers (§6.3.3 of the plan):
   *  1. exact bar time                          → li = index (+ liOffset)
   *  2. inside the loaded window                → nearest bar + residual, warn
   *  3. after the last loaded bar               → extrapolate from last bar, warn
   *  4. before the loaded window                → unresolved (hard)
   */
  resolve(a: Anchor): ResolvedAnchor {
    const warnings: string[] = []
    if (this.bars.length === 0) {
      return { ok: false, reason: "no-data", warnings: [NO_BARS_WARNING] }
    }
    const y = this.yOfPrice(a.p)
    if (y == null) return { ok: false, reason: "price-scale-unavailable", warnings }

    const offset = a.liOffset ?? 0
    const exactIndex = this.opts.scale.timeToIndex(a.t)
    if (exactIndex != null) {
      const li = exactIndex + offset
      const x = this.xOfLogical(li)
      if (x == null) return { ok: false, reason: "no-data", warnings }
      return { ok: true, li, x, y, exact: true, tier: 1, warnings }
    }

    const first = this.bars[0]
    const last = this.bars[this.bars.length - 1]

    if (a.t > last) {
      const li = this.bars.length - 1 + (a.t - last) / this.barDuration + offset
      const x = this.xOfLogical(li)
      if (x == null) return { ok: false, reason: "no-data", warnings }
      return { ok: true, li, x, y, exact: false, tier: 3, warnings: [TIER3_WARNING] }
    }

    if (a.t < first) {
      return {
        ok: false,
        reason: "before-loaded-window",
        warnings: ["anchor lies before the loaded data window"],
      }
    }

    const nearest = this.opts.scale.timeToIndex(a.t, true)
    if (nearest == null) return { ok: false, reason: "no-data", warnings }
    const li = nearest + this.residualFor(a.t, nearest) + offset
    const x = this.xOfLogical(li)
    if (x == null) return { ok: false, reason: "no-data", warnings }
    return { ok: true, li, x, y, exact: false, tier: 2, warnings: [TIER2_WARNING] }
  }

  pixelOf(a: Anchor): { x: number; y: number } | null {
    const r = this.resolve(a)
    return r.ok ? { x: r.x, y: r.y } : null
  }

  /** Build a data-space anchor from a pane pixel position (pointer input). */
  anchorAt(x: number, y: number): Anchor | null {
    const li = this.logicalOfX(x)
    const price = this.priceOfY(y)
    if (li == null || price == null) return null
    return this.anchorFromLogical(li, price)
  }

  anchorFromLogical(li: number, price: number): Anchor | null {
    const n = this.bars.length
    if (n === 0) return null
    if (li <= 0) return dropOffset({ t: this.bars[0], p: price, liOffset: li })
    if (li >= n - 1) return dropOffset({ t: this.bars[n - 1], p: price, liOffset: li - (n - 1) })
    const nearest = Math.min(n - 1, Math.max(0, Math.round(li)))
    return dropOffset({ t: this.bars[nearest], p: price, liOffset: li - nearest })
  }

  /** Logical units per horizontal pixel (drag translation). */
  logicalPerPixel(): number {
    const a = this.xOfLogical(0)
    const b = this.xOfLogical(1)
    if (a == null || b == null || b === a) return 0
    return 1 / (b - a)
  }

  /** Fractional residual of an epoch between loaded bars, relative to `index`. */
  private residualFor(t: number, index: number): number {
    const here = this.bars[index]
    const next = this.bars[index + 1]
    const prev = this.bars[index - 1]
    if (next !== undefined && t > here) {
      const span = next - here
      return span > 0 ? Math.min((t - here) / span, 1) : 0
    }
    if (prev !== undefined && t < here) {
      const span = here - prev
      return span > 0 ? -Math.min((here - t) / span, 1) : 0
    }
    return 0
  }
}

function dropOffset(a: Anchor): Anchor {
  if (a.liOffset !== undefined && Math.abs(a.liOffset) < 1e-9) {
    return { t: a.t, p: a.p }
  }
  return a
}

export function medianBarDuration(bars: readonly number[]): number | null {
  if (bars.length < 2) return null
  const diffs: number[] = []
  for (let i = 1; i < bars.length; i++) diffs.push(bars[i] - bars[i - 1])
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)]
}
