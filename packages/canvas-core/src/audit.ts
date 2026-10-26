import type { AuditEntry } from "./protocol.ts"

/**
 * Audit chain helpers. The chain format is protocol-level; the concrete hash function is the
 * server's (blake3 in `tenon-server`). Keeping the function injectable lets a target verify a chain
 * with whatever primitive it uses while the fixtures assert linkage and tamper detection.
 */

export type HashFn = (input: Uint8Array) => string

export const GENESIS_HASH = `blake3:${"0".repeat(64)}`

/**
 * Deterministic JSON: object keys sorted by codepoint, no whitespace, `undefined` members
 * omitted, non-finite numbers rejected.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value)
}

function serialize(value: unknown): string {
  if (value === null) return "null"
  switch (typeof value) {
    case "string":
      return JSON.stringify(value)
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number")
      return JSON.stringify(value)
    case "boolean":
      return value ? "true" : "false"
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? "null" : serialize(item))).join(",")}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`
    }
    default:
      throw new Error(`canonicalJson: unsupported value of type ${typeof value}`)
  }
}

/**
 * `hash = alg(utf8(prev_hash) || "\n" || utf8(canonical_json(entry without hash/prev_hash)))`.
 * The link is the prefix, not part of the body; the newline is domain separation.
 */
export function hashAuditEntry(
  prevHash: string,
  entry: Record<string, unknown>,
  hash: HashFn,
  alg = "blake3",
): string {
  const body = { ...entry }
  delete body.hash
  delete body.prev_hash
  const input = new TextEncoder().encode(`${prevHash}\n${canonicalJson(body)}`)
  const digest = hash(input)
  if (!/^[0-9a-f]+$/.test(digest)) {
    throw new Error("hashAuditEntry: hash function must return lowercase hex")
  }
  return `${alg}:${digest}`
}

export interface AuditVerification {
  ok: boolean
  /** 0-based index of the first entry that failed, when ok is false. */
  brokenAt?: number
  reason?: string
}

/** Verifies gapless sequencing, document identity, linkage, and every digest. */
export function verifyAuditChain(entries: readonly AuditEntry[], hash: HashFn, alg = "blake3"): AuditVerification {
  let prev = GENESIS_HASH
  const docId = entries[0]?.doc_id
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.seq !== index + 1) {
      return { ok: false, brokenAt: index, reason: `expected seq ${index + 1}, found ${entry.seq}` }
    }
    if (entry.doc_id !== docId) {
      return { ok: false, brokenAt: index, reason: "document id changed mid-chain" }
    }
    if (entry.prev_hash !== prev) {
      return { ok: false, brokenAt: index, reason: "prev_hash does not link to the previous entry" }
    }
    const expected = hashAuditEntry(entry.prev_hash, entry, hash, alg)
    if (entry.hash !== expected) {
      return { ok: false, brokenAt: index, reason: "digest mismatch" }
    }
    prev = entry.hash
  }
  return { ok: true }
}
