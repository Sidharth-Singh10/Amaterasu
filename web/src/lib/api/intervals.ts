export interface IntervalOption {
  value: string
  label: string
  lookback: string
  /** Auto-refresh cadence for this interval. */
  refreshMs: number
}

/**
 * Interval → lookback mapping, sized to the INDmoney ≤250-candle cap: coarser intervals
 * get longer lookbacks instead of paging. Cadences follow the plan's refresh policy
 * (fast intraday, slow daily, pause when hidden).
 */
export const INTERVALS: IntervalOption[] = [
  { value: "1minute", label: "1m", lookback: "1d", refreshMs: 5_000 },
  { value: "5minute", label: "5m", lookback: "7d", refreshMs: 15_000 },
  { value: "15minute", label: "15m", lookback: "14d", refreshMs: 15_000 },
  { value: "30minute", label: "30m", lookback: "14d", refreshMs: 30_000 },
  { value: "60minute", label: "1h", lookback: "14d", refreshMs: 30_000 },
  { value: "240minute", label: "4h", lookback: "1y", refreshMs: 60_000 },
  { value: "1day", label: "1D", lookback: "1y", refreshMs: 60_000 },
  { value: "1week", label: "1W", lookback: "1y", refreshMs: 300_000 },
  { value: "1month", label: "1M", lookback: "1y", refreshMs: 300_000 },
]

export const DEFAULT_INTERVAL = "1day"

export function intervalOption(value: string): IntervalOption {
  return INTERVALS.find((option) => option.value === value) ?? intervalOption(DEFAULT_INTERVAL)
}
