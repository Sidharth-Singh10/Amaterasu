import { describe, expect, it } from "vitest"
import type { Candle } from "@/lib/data/mock"
import { diffCandles } from "./diff"

function candle(time: number, close = 100): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1 }
}

describe("diffCandles", () => {
  it("requests a full set for empty inputs", () => {
    expect(diffCandles([], [candle(1)])).toEqual({ mode: "set" })
    expect(diffCandles([candle(1)], [])).toEqual({ mode: "set" })
  })

  it("updates only the running candle", () => {
    const previous = [candle(1), candle(2), candle(3, 100)]
    const next = [candle(1), candle(2), candle(3, 101)]
    const diff = diffCandles(previous, next)
    expect(diff.mode).toBe("update")
    if (diff.mode === "update") {
      expect(diff.candles).toEqual([next[2]])
    }
  })

  it("updates appended bars", () => {
    const previous = [candle(1), candle(2)]
    const next = [candle(1), candle(2), candle(3), candle(4)]
    const diff = diffCandles(previous, next)
    expect(diff.mode).toBe("update")
    if (diff.mode === "update") {
      expect(diff.candles.map((c) => c.time)).toEqual([3, 4])
    }
  })

  it("treats identical windows as a no-op update", () => {
    const candles = [candle(1), candle(2)]
    const diff = diffCandles(candles, [...candles])
    expect(diff.mode).toBe("update")
    if (diff.mode === "update") {
      expect(diff.candles).toEqual([])
    }
  })

  it("falls back to a full set when the window shifted", () => {
    const previous = [candle(1), candle(2), candle(3)]
    const next = [candle(2), candle(3), candle(4)]
    expect(diffCandles(previous, next)).toEqual({ mode: "set" })
  })

  it("falls back to a full set when too many bars changed", () => {
    const previous = Array.from({ length: 20 }, (_, i) => candle(i + 1, 100))
    const next = Array.from({ length: 20 }, (_, i) => candle(i + 1, i < 5 ? 100 : 200))
    expect(diffCandles(previous, next)).toEqual({ mode: "set" })
  })
})
