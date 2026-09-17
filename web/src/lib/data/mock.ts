export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MockOptions {
  count: number
  startTime: number
  intervalSeconds: number
  seed?: number
  startPrice?: number
  volatility?: number
  drift?: number
}

/**
 * Deterministic candle generator (seeded LCG) — mock data for Phase 0 and fixtures
 * for tests. Replaced by the Rust data service in Phase 1.
 */
export function generateCandles(opts: MockOptions): Candle[] {
  const {
    count,
    startTime,
    intervalSeconds,
    seed = 42,
    startPrice = 1240,
    volatility = 0.012,
    drift = 0.0003,
  } = opts

  let state = seed >>> 0
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }

  const candles: Candle[] = []
  let close = startPrice
  for (let i = 0; i < count; i++) {
    const open = close
    const change = open * (drift + (rand() - 0.5) * 2 * volatility)
    close = Math.max(1, open + change)
    const high = Math.max(open, close) * (1 + rand() * volatility * 0.5)
    const low = Math.min(open, close) * (1 - rand() * volatility * 0.5)
    const volume = Math.round(2_000_000 + rand() * 8_000_000)
    candles.push({
      time: startTime + i * intervalSeconds,
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume,
    })
  }
  return candles
}

/** Default demo series: ~300 daily bars ending in the recent past. */
export function demoCandles(): Candle[] {
  const intervalSeconds = 86_400
  const count = 300
  const end = Math.floor(Date.UTC(2026, 8, 17) / 1000)
  const startTime = end - count * intervalSeconds
  return generateCandles({ count, startTime, intervalSeconds, seed: 7 })
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
