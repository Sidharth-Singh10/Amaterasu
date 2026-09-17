import { describe, expect, it } from "vitest"
import { DEFAULT_INTERVAL, INTERVALS, intervalOption } from "./intervals"

describe("interval options", () => {
  it("only uses lookbacks the server accepts", () => {
    const allowed = ["1d", "7d", "14d", "1y"]
    for (const option of INTERVALS) {
      expect(allowed).toContain(option.lookback)
    }
  })

  it("has a sane refresh cadence ordering", () => {
    const oneMinute = intervalOption("1minute")
    const fifteen = intervalOption("15minute")
    const daily = intervalOption("1day")
    expect(oneMinute.refreshMs).toBeLessThan(fifteen.refreshMs)
    expect(fifteen.refreshMs).toBeLessThan(daily.refreshMs)
  })

  it("falls back to the default for unknown values", () => {
    expect(intervalOption("bogus").value).toBe(DEFAULT_INTERVAL)
    expect(intervalOption("").value).toBe(DEFAULT_INTERVAL)
  })
})
