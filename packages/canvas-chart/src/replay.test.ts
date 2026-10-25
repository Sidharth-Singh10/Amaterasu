import { describe, expect, it } from "vitest"
import { replayApplied, type JournalReplayOp } from "./replay.ts"

const draw: JournalReplayOp = {
  seq: 2,
  status: "applied",
  envelope: {
    payload: {
      op: {
        op: "draw",
        kind: "hline",
        points: [{ t: 1000, p: 10 }],
      },
    },
  },
  ack: { result: { id: "a1" } },
}

const series: JournalReplayOp = {
  seq: 1,
  status: "applied",
  envelope: {
    payload: {
      op: {
        op: "add_series",
        id: "s1",
        name: "SMA",
        points: [
          { t: 1, v: 1 },
          { t: 2, v: 2 },
        ],
      },
    },
  },
}

const rejected: JournalReplayOp = {
  seq: 3,
  status: "rejected",
  envelope: { payload: { op: { op: "remove", id: "a1" } } },
}

describe("replayApplied", () => {
  it("applies in sequence order, preserves ack ids, and skips rejected ops", () => {
    const result = replayApplied([draw, rejected, series])
    expect(result.applied).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.doc.annotations).toHaveLength(1)
    expect(result.doc.annotations[0]!.id).toBe("a1")
    expect(result.doc.series[0]!.id).toBe("s1")
  })

  it("fails loudly when an applied op no longer applies", () => {
    expect(() =>
      replayApplied([
        {
          seq: 1,
          status: "applied",
          envelope: { payload: { op: { op: "remove", id: "missing" } } },
        },
      ]),
    ).toThrow(/replay failed at seq 1/)
  })
})
