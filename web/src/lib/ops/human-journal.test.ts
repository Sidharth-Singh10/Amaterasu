import { describe, expect, it, vi } from "vitest"
import type { DocPayload } from "@tenon-protocol/chart"
import type { HumanOpEvent } from "@/lib/chart/ChartController"
import { HumanJournalRecorder, type HumanJournalRecord } from "./human-journal"

const empty: DocPayload = { v: 1, annotations: [], series: [] }
const drawn: DocPayload = {
  v: 1,
  annotations: [
    {
      id: "a1",
      kind: "trendline",
      points: [
        { t: 1000, p: 10 },
        { t: 2000, p: 20 },
      ],
      style: {},
      z: 0,
      hidden: false,
      locked: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  series: [],
}

function event(overrides: Partial<HumanOpEvent> = {}): HumanOpEvent {
  return {
    op: {
      op: "draw",
      kind: "trendline",
      points: [
        { t: 1000, p: 10 },
        { t: 2000, p: 20 },
      ],
    },
    result: { ok: true, id: "a1" },
    before: empty,
    after: drawn,
    turnId: "turn_human_1",
    ...overrides,
  }
}

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe("HumanJournalRecorder", () => {
  it("records a human draw with its inverse and snapshot", async () => {
    const recordFn = vi.fn(
      async (_docId: string, _records: HumanJournalRecord[]) => ({ acks: [] }),
    )
    const recorder = new HumanJournalRecorder({
      docId: "doc_1",
      recordFn,
      flushDelayMs: 0,
    })
    recorder.record(event())
    await wait()
    expect(recordFn).toHaveBeenCalledTimes(1)
    const records = recordFn.mock.calls[0]![1]
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope).toMatchObject({
      doc_id: "doc_1",
      turn_id: "turn_human_1",
      actor: { kind: "human", id: "local" },
      capability: "cap_human",
      type: "chart.shape.create",
      payload: { op: { op: "draw" } },
    })
    expect(records[0]!.inverse).toEqual([
      {
        type: "chart.shape.delete",
        target: { kind: "chart.shape", id: "a1" },
        payload: { op: { op: "remove", id: "a1" } },
      },
    ])
    expect(records[0]!.snapshot).toEqual(drawn)
    recorder.dispose()
  })

  it("does not record view or rejected ops", async () => {
    const recordFn = vi.fn(async () => ({ acks: [] }))
    const recorder = new HumanJournalRecorder({
      docId: "doc_1",
      recordFn,
      flushDelayMs: 0,
    })
    recorder.record(
      event({
        op: { op: "set_view", bars: 100 },
        result: { ok: true },
        before: drawn,
        after: drawn,
      }),
    )
    recorder.record(event({ result: { ok: false, warnings: ["no"] } }))
    await wait()
    expect(recordFn).not.toHaveBeenCalled()
    recorder.dispose()
  })

  it("retries a failed batch with the same envelopes", async () => {
    const recordFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ acks: [] })
    const recorder = new HumanJournalRecorder({
      docId: "doc_1",
      recordFn,
      flushDelayMs: 0,
      retryDelayMs: 0,
    })
    recorder.record(event())
    await wait(40)
    expect(recordFn).toHaveBeenCalledTimes(2)
    const first = recordFn.mock.calls[0]![1][0].envelope.idempotency_key
    const second = recordFn.mock.calls[1]![1][0].envelope.idempotency_key
    expect(second).toBe(first)
    recorder.dispose()
  })
})
