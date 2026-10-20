import { apiRequest } from "./client"
import { capabilityHeaders } from "./capabilities"

export interface JournalActor {
  kind: string
  id: string
  session?: string
  message?: string
}

export interface JournalEnvelope {
  v: number
  doc_id: string
  turn_id: string
  seq: number
  actor: JournalActor
  capability: string
  type: string
  target: { kind: string; id?: string }
  payload: { op?: { op?: string; id?: string } }
  rationale?: string
  idempotency_key: string
  created_at: string
  approval?: string
  approved_by?: { kind: string; id: string }
}

export interface JournalAck {
  status?: string
  revision?: number | null
  code?: string
  message?: string
  retryable?: boolean
  inverse?: unknown[]
  [key: string]: unknown
}

export interface JournalOp {
  seq: number
  op_id: string
  turn_id: string
  status: string
  revision: number | null
  envelope: JournalEnvelope
  ack: JournalAck | null
  undoes: string | null
  undone_by: string | null
}

export interface AuditVerification {
  ok: boolean
  broken_at?: number
  reason?: string
}

export interface DocMeta {
  doc: {
    doc_id: string
    revision: number
    next_seq: number
    pending: number
    audit_seq: number
  }
  verification: AuditVerification
}

export interface UndoResult {
  docId: string
  undoTurnId: string | null
  applied: boolean
  acks: JournalAck[]
}

export interface ApprovalResult {
  docId: string
  approvalId: string
  applied: boolean
  acks: JournalAck[]
}

function docPath(docId: string): string {
  return `/api/docs/${encodeURIComponent(docId)}`
}

export const docs = {
  meta: (docId: string) => apiRequest<DocMeta>(docPath(docId)),
  snapshot: (docId: string) =>
    apiRequest<{ docId: string; snapshot: { revision: number; snapshot: unknown } | null }>(
      `${docPath(docId)}/snapshot`,
    ),
  ops: (docId: string, limit = 100) =>
    apiRequest<{ docId: string; ops: JournalOp[] }>(`${docPath(docId)}/ops?limit=${limit}`),
  audit: (docId: string) =>
    apiRequest<{ docId: string; entries: unknown[]; verification: AuditVerification }>(
      `${docPath(docId)}/audit`,
    ),
  undoTurn: async (docId: string, turnId: string) => {
    const headers = await capabilityHeaders("cap_undo")
    return apiRequest<UndoResult>(`${docPath(docId)}/turns/${encodeURIComponent(turnId)}/undo`, {
      method: "POST",
      body: "{}",
      headers,
    })
  },
  approve: async (docId: string, approvalId: string) => {
    const headers = await capabilityHeaders("cap_human")
    return apiRequest<ApprovalResult>(
      `${docPath(docId)}/approvals/${encodeURIComponent(approvalId)}`,
      { method: "POST", headers },
    )
  },
}
