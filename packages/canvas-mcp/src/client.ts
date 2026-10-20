export interface DocMetaResponse {
  doc: {
    doc_id: string
    revision: number
    next_seq: number
    pending: number
    audit_seq: number
  }
  verification: { ok: boolean; broken_at?: number; reason?: string }
}

export interface SnapshotResponse {
  docId: string
  snapshot: { revision: number; snapshot: unknown } | null
}

export interface OpsResponse {
  docId: string
  ops: Array<Record<string, unknown>>
}

export interface AuditResponse {
  docId: string
  entries: Array<Record<string, unknown>>
  verification: { ok: boolean; broken_at?: number; reason?: string }
}

export class CommonGroundError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "CommonGroundError"
    this.status = status
    this.code = code
  }
}

/**
 * Thin HTTP client shared by the MCP tools. The transport is deliberately boring: the server
 * owns the journal and the browser adapter owns domain application.
 */
export class CommonGroundClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(baseUrl = "http://127.0.0.1:8787", fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.fetchImpl = fetchImpl
  }

  async docGet(docId: string): Promise<{ doc: DocMetaResponse; snapshot: SnapshotResponse }> {
    const [doc, snapshot] = await Promise.all([
      this.request<DocMetaResponse>(`/api/docs/${encodeURIComponent(docId)}`),
      this.request<SnapshotResponse>(`/api/docs/${encodeURIComponent(docId)}/snapshot`),
    ])
    return { doc, snapshot }
  }

  async stateQuery(docId: string, limit = 50): Promise<{
    doc: DocMetaResponse
    ops: OpsResponse
    audit: AuditResponse
  }> {
    const id = encodeURIComponent(docId)
    const [doc, ops, audit] = await Promise.all([
      this.request<DocMetaResponse>(`/api/docs/${id}`),
      this.request<OpsResponse>(`/api/docs/${id}/ops?limit=${limit}`),
      this.request<AuditResponse>(`/api/docs/${id}/audit`),
    ])
    return { doc, ops, audit }
  }

  async opApply(docId: string, ops: Array<Record<string, unknown>>): Promise<unknown> {
    return this.request(`/api/docs/${encodeURIComponent(docId)}/ops`, {
      method: "POST",
      body: JSON.stringify({ ops }),
    })
  }

  async turnUndo(docId: string, turnId: string): Promise<unknown> {
    return this.request(
      `/api/docs/${encodeURIComponent(docId)}/turns/${encodeURIComponent(turnId)}/undo`,
      { method: "POST", body: "{}" },
    )
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      ...init,
    })
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    if (!response.ok) {
      const record = (body ?? {}) as { error?: string; message?: string }
      throw new CommonGroundError(
        response.status,
        record.error ?? "http_error",
        record.message ?? `${response.status} ${response.statusText}`,
      )
    }
    return body as T
  }
}
