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

export class TenonError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "TenonError"
    this.status = status
    this.code = code
  }
}

/**
 * Thin HTTP client shared by the MCP tools. The transport is deliberately boring: the server
 * owns the journal and the browser adapter owns domain application.
 */
export class TenonClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly tokens = new Map<string, string>()

  constructor(baseUrl = "http://127.0.0.1:8787", fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.fetchImpl = fetchImpl
  }

  private async tokenFor(capId: string): Promise<string> {
    const cached = this.tokens.get(capId)
    if (cached) return cached
    const response = await this.request<{ token: string }>(
      `/api/capabilities/${encodeURIComponent(capId)}/token`,
    )
    if (!response.token) throw new Error(`the server did not return a token for ${capId}`)
    this.tokens.set(capId, response.token)
    return response.token
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
    const capability =
      typeof ops[0]?.capability === "string" ? (ops[0].capability as string) : "cap_local"
    const token = await this.tokenFor(capability)
    return this.request(`/api/docs/${encodeURIComponent(docId)}/ops`, {
      method: "POST",
      body: JSON.stringify({ ops }),
      headers: { "x-tenon-capability": token },
    })
  }

  async turnUndo(docId: string, turnId: string): Promise<unknown> {
    const token = await this.tokenFor("cap_undo")
    return this.request(
      `/api/docs/${encodeURIComponent(docId)}/turns/${encodeURIComponent(turnId)}/undo`,
      { method: "POST", body: "{}", headers: { "x-tenon-capability": token } },
    )
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    headers.set("accept", "application/json")
    if (init?.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers })
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
      throw new TenonError(
        response.status,
        record.error ?? "http_error",
        record.message ?? `${response.status} ${response.statusText}`,
      )
    }
    return body as T
  }
}
