import { describe, expect, it } from "vitest"
import type { Anchor } from "@amaterasu/chart-dsl"
import { makeFakeAdapters } from "@/lib/testing/fake-adapters"
import { DocStore } from "@/lib/ops/reducer"
import { Transform, type ResolveFailure } from "./transform"

/**
 * Headline Phase 0 test: annotations authored on one data window/interval must resolve
 * predictably when the window shifts, the interval changes, or the loaded range no longer
 * covers them (§6.3.3 resolver tiers).
 */

const DAY = 86_400

// Daily series anchored at 09:15 IST (03:45 UTC) — the canonical session-open convention.
const DAILY_START = Math.floor(Date.UTC(2025, 0, 1, 3, 45) / 1000)
const DAILY = Array.from({ length: 200 }, (_, i) => DAILY_START + i * DAY)

// Five-minute series sharing the same canonical timestamps for the same session.
const INTRADAY_START = DAILY[100]
const INTRADAY = Array.from({ length: 375 }, (_, i) => INTRADAY_START + i * 300)

function transformFor(bars: readonly number[], visibleFrom = 0): Transform {
  const { scale, price } = makeFakeAdapters({
    bars,
    visibleFrom,
    pxPerBar: 6,
    width: 900,
    height: 400,
    priceMin: 900,
    priceMax: 1400,
  })
  return new Transform({ scale, price, bars, cssWidth: 900, cssHeight: 400, dpr: 1 })
}

function storeFor(transform: Transform) {
  let id = 0
  return new DocStore({
    checkAnchor: (anchor: Anchor) => {
      const resolved = transform.resolve(anchor)
      return resolved.ok
        ? { ok: true, warnings: resolved.warnings }
        : { ok: false, reason: resolved.reason, warnings: resolved.warnings }
    },
    newId: () => `a${++id}`,
    now: () => 1_000_000 + id,
  })
}

describe("anchoring across window shifts", () => {
  it("keeps an annotation exact when the shifted window still contains its bar", () => {
    const author = transformFor(DAILY)
    const win = transformFor(DAILY.slice(120), 20) // loaded window starts 120 bars in
    const annotation = { t: DAILY[150], p: 1200 }
    expect(author.resolve(annotation).ok).toBe(true)

    const resolved = win.resolve(annotation)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.tier).toBe(1)
    expect(resolved.exact).toBe(true)
  })

  it("extrapolates (tier 3) when the loaded window is older than the annotation", () => {
    const older = transformFor(DAILY.slice(0, 100))
    const resolved = older.resolve({ t: DAILY[150], p: 1200 })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.tier).toBe(3)
    expect(resolved.warnings.length).toBeGreaterThan(0)
  })

  it("fails hard (tier 4) when the loaded window starts after the annotation", () => {
    const newer = transformFor(DAILY.slice(100))
    const resolved = newer.resolve({ t: DAILY[10], p: 1200 })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason satisfies ResolveFailure).toBe("before-loaded-window")
  })

  it("resolves a daily anchor exactly on an intraday chart via the session-open convention", () => {
    const intraday = transformFor(INTRADAY)
    const resolved = intraday.resolve({ t: DAILY[100], p: 1200 })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.tier).toBe(1)
  })

  it("resolves a same-session timestamp between intraday bars as tier 2", () => {
    const intraday = transformFor(INTRADAY)
    const between = { t: DAILY[100] + 150, p: 1200 } // exactly between two 5m bars
    const resolved = intraday.resolve(between)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.tier).toBe(2)
    expect(Math.abs(resolved.li - 0.5)).toBeLessThan(1e-6)
  })
})

describe("op intake against the loaded window", () => {
  it("rejects a draw before the loaded window with a structured failure", () => {
    const store = storeFor(transformFor(DAILY.slice(100)))
    const result = store.applyOp({
      op: "draw",
      kind: "hline",
      points: [{ t: DAILY[10], p: 1200 }],
    })
    expect(result.ok).toBe(false)
    expect(result.unresolved).toEqual(["before-loaded-window"])
    expect(store.annotations).toHaveLength(0)
  })

  it("accepts a draw inside the window and reports tier warnings", () => {
    const store = storeFor(transformFor(INTRADAY))
    const result = store.applyOp({
      op: "draw",
      kind: "trendline",
      points: [
        { t: DAILY[100], p: 1200 },
        { t: DAILY[100] + 150, p: 1250 },
      ],
    })
    expect(result.ok).toBe(true)
    expect(store.annotations).toHaveLength(1)
    expect(result.warnings?.length).toBeGreaterThan(0)
  })
})
