import { DocStore, type DocDeps } from "./doc-store.ts"
import type { DocPayload } from "./schema.ts"

/** The subset of a journal op needed to reconstruct a document. */
export interface JournalReplayOp {
  seq: number
  status: string
  envelope: { payload?: { op?: unknown } }
  ack?: { result?: { id?: unknown } } | null
}

export interface ReplayResult {
  doc: DocPayload
  applied: number
  skipped: number
}

/**
 * Reconstructs a document by replaying applied envelopes in sequence order. Rejected and pending
 * attempts are skipped. Draw ops are hydrated with the id returned in their original ack, so a
 * replay preserves annotation ids without relying on the old inverse limitation.
 */
export function replayApplied(
  ops: readonly JournalReplayOp[],
  overrides: Partial<DocDeps> = {},
): ReplayResult {
  const store = new DocStore({
    checkAnchor: () => ({ ok: true, warnings: [] }),
    onView: () => ({ ok: true, warnings: [] }),
    ...overrides,
  })
  let applied = 0
  let skipped = 0
  for (const item of [...ops].sort((left, right) => left.seq - right.seq)) {
    if (item.status !== "applied") {
      skipped += 1
      continue
    }
    const raw = item.envelope.payload?.op
    const id = item.ack?.result?.id
    const op =
      typeof raw === "object" && raw !== null && (raw as { op?: unknown }).op === "draw" &&
      typeof id === "string"
        ? { ...(raw as Record<string, unknown>), id }
        : raw
    const result = store.applyOp(op)
    if (!result.ok) {
      throw new Error(
        `replay failed at seq ${item.seq}: ${result.warnings?.join("; ") ?? "rejected"}`,
      )
    }
    applied += 1
  }
  return { doc: store.exportDoc(), applied, skipped }
}
