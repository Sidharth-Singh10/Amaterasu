import type { Candle } from "@/lib/data/mock"

export type CandleDiff =
  | { mode: "set" }
  | { mode: "update"; candles: Candle[] }

const MAX_INCREMENTAL_UPDATES = 8

function sameCandle(a: Candle, b: Candle): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  )
}

/**
 * Chooses between a full `setData` and an incremental tail update when fresh candles
 * arrive. Constraints that shape this:
 *  - `series.update()` can only change/append trailing bars; it cannot drop the oldest
 *    bar, so a shifted window must go through `setData`.
 *  - A refresh should touch only the running candle (and newly appended bars); if the
 *    replay set would be large, a full set is cheaper and safer.
 */
export function diffCandles(previous: readonly Candle[], next: readonly Candle[]): CandleDiff {
  if (previous.length === 0 || next.length === 0) return { mode: "set" }
  // The head moved: bars the client had are gone, which update() cannot express.
  if (previous[0].time !== next[0].time) return { mode: "set" }

  const overlap = Math.min(previous.length, next.length)
  let index = 0
  while (index < overlap && sameCandle(previous[index], next[index])) {
    index++
  }
  const tail = next.slice(index)
  if (tail.length > MAX_INCREMENTAL_UPDATES) return { mode: "set" }
  return { mode: "update", candles: tail }
}
