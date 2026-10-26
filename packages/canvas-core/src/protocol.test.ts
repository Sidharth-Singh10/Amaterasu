import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  AckSchema,
  AuditEntrySchema,
  BatchSchema,
  CapabilityClaimsSchema,
  EnvelopeSchema,
  GENESIS_HASH,
  canonicalJson,
  hashAuditEntry,
  matchesPattern,
  opVerb,
  verifyAuditChain,
  type AuditEntry,
  type HashFn,
} from "./index.ts"

const sha256: HashFn = (input) => createHash("sha256").update(input).digest("hex")

const envelope = {
  v: 1,
  doc_id: "doc_reliance_1d",
  turn_id: "turn_ses_1:msg_2",
  seq: 1,
  actor: { kind: "agent", id: "chart-analyst", session: "ses_1" },
  capability: "cap_1",
  type: "chart.shape.create",
  target: { kind: "chart.shape" },
  anchor_space: "chart.data",
  payload: { shape: "trendline", points: [] },
  rationale: "test",
  idempotency_key: "turn_ses_1:msg_2:1",
  created_at: "2026-10-20T09:41:02Z",
} as const

describe("envelope", () => {
  it("accepts a create with no target id", () => {
    const parsed = EnvelopeSchema.parse(envelope)
    expect(parsed.type).toBe("chart.shape.create")
  })

  it("rejects a create that carries a target id", () => {
    const result = EnvelopeSchema.safeParse({ ...envelope, target: { kind: "chart.shape", id: "sh_1" } })
    expect(result.success).toBe(false)
  })

  it("requires a target id for update", () => {
    const result = EnvelopeSchema.safeParse({ ...envelope, type: "chart.shape.update", target: { kind: "chart.shape" } })
    expect(result.success).toBe(false)
    expect(EnvelopeSchema.safeParse({ ...envelope, type: "chart.shape.update", target: { kind: "chart.shape", id: "sh_1" } }).success).toBe(true)
  })

  it("preserves unknown envelope fields", () => {
    const parsed = EnvelopeSchema.parse({ ...envelope, future_flag: { a: 1 } })
    expect((parsed as Record<string, unknown>).future_flag).toEqual({ a: 1 })
  })

  it("rejects a malformed op type", () => {
    expect(EnvelopeSchema.safeParse({ ...envelope, type: "shape.create" }).success).toBe(false)
  })

  it("rejects a non-UTC timestamp", () => {
    expect(EnvelopeSchema.safeParse({ ...envelope, created_at: "2026-10-20 09:41:02" }).success).toBe(false)
  })

  it("parses a batch in order", () => {
    const batch = BatchSchema.parse({ ops: [envelope, { ...envelope, seq: 2 }] })
    expect(batch.ops.map((op) => op.seq)).toEqual([1, 2])
  })

  it("extracts the verb", () => {
    expect(opVerb("chart.shape.create")).toBe("create")
    expect(opVerb("nonsense")).toBe("nonsense")
  })
})

describe("ack", () => {
  const applied = {
    v: 1,
    op_id: "op_1",
    turn_id: "turn_1",
    seq: 1,
    status: "applied",
    revision: 4,
    result: { object_id: "sh_1" },
    inverse: [{ type: "chart.shape.delete", target: { kind: "chart.shape", id: "sh_1" }, payload: {} }],
  } as const

  it("accepts an applied ack", () => {
    expect(AckSchema.parse(applied).revision).toBe(4)
  })

  it("refuses a code on an applied ack", () => {
    expect(AckSchema.safeParse({ ...applied, code: "internal" }).success).toBe(false)
  })

  it("requires rejection fields", () => {
    const rejected = { v: 1, op_id: "op_1", turn_id: "turn_1", seq: 1, status: "rejected", revision: 4 }
    expect(AckSchema.safeParse(rejected).success).toBe(false)
    expect(
      AckSchema.safeParse({
        ...rejected,
        rejected_by: "server",
        code: "capability_denied",
        message: "no",
        retryable: false,
      }).success,
    ).toBe(true)
  })
})

describe("capabilities", () => {
  it("applies the auto approval default", () => {
    const claims = CapabilityClaimsSchema.parse({
      v: 1,
      cap_id: "cap_1",
      iss: "tenon-local",
      sub: { actor_id: "chart-analyst" },
      documents: ["doc_*"],
      op_types: ["chart.shape.*"],
      permissions: ["read", "apply"],
      issued_at: "2026-10-20T09:00:00Z",
      expires_at: "2026-10-20T10:00:00Z",
    })
    expect(claims.approval).toEqual({ mode: "auto", op_types: [] })
  })

  it("matches one dotted segment per wildcard", () => {
    expect(matchesPattern("chart.shape.*", "chart.shape.create")).toBe(true)
    expect(matchesPattern("chart.shape.*", "chart.series.create")).toBe(false)
    expect(matchesPattern("doc_*", "doc_1")).toBe(true)
    expect(matchesPattern("chart.*.create", "chart.shape.create")).toBe(true)
  })
})

describe("audit chain", () => {
  function entry(seq: number) {
    return {
      v: 1 as const,
      doc_id: "doc_1",
      seq,
      revision: seq,
      op_id: `op_${seq}`,
      turn_id: "turn_1",
      status: "applied" as const,
      actor: { kind: "agent" as const, id: "a" },
      capability: "cap_1",
      type: "chart.shape.create",
      target: { kind: "chart.shape" },
      created_at: "2026-10-20T09:41:02Z",
    }
  }

  function chain(count: number): AuditEntry[] {
    const entries: AuditEntry[] = []
    let prev = GENESIS_HASH
    for (let seq = 1; seq <= count; seq += 1) {
      const body = entry(seq)
      const hash = hashAuditEntry(prev, body, sha256, "sha256")
      const full = { ...body, prev_hash: prev, hash }
      expect(AuditEntrySchema.safeParse(full).success).toBe(true)
      entries.push(full)
      prev = hash
    }
    return entries
  }

  it("verifies a valid chain", () => {
    expect(verifyAuditChain(chain(3), sha256, "sha256")).toEqual({ ok: true })
  })

  it("detects tampering at the right index", () => {
    const entries = chain(3)
    entries[1] = { ...entries[1]!, rationale: "changed after the fact" }
    const result = verifyAuditChain(entries, sha256, "sha256")
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(1)
  })

  it("detects a broken link", () => {
    const entries = chain(3)
    entries[2] = { ...entries[2]!, prev_hash: entries[0]!.hash }
    const result = verifyAuditChain(entries, sha256, "sha256")
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(2)
  })

  it("canonicalizes deterministically", () => {
    expect(canonicalJson({ b: 1, a: [undefined, { d: 2, c: 3 }], z: undefined })).toBe('{"a":[null,{"c":3,"d":2}],"b":1}')
  })

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow()
  })
})
