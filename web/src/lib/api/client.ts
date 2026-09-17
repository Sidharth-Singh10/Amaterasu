import type { Candle } from "@/lib/data/mock"

/** Typed client for the Rust service. In dev these paths are proxied by Vite to :8787. */

export interface CandleResponse {
  indKey: string
  interval: string
  lookback: string
  count: number
  candles: Candle[]
  source: string
  fetchedAt: number
}

export interface SearchResult {
  indKey: string
  name: string
}

export interface Quote {
  indKey: string
  name?: string | null
  symbol?: string | null
  exchange?: string | null
  ltp?: number | null
  change?: number | null
  changePct?: number | null
  prevClose?: number | null
  dayOpen?: number | null
  dayHigh?: number | null
  dayLow?: number | null
  week52High?: number | null
  week52Low?: number | null
  volume?: number | null
  lastUpdated?: string | null
}

export interface ConnectionStatus {
  connected: boolean
  expiresAt?: number | null
  scope?: string | null
}

export interface WorkspaceResponse {
  key: string
  payload: unknown | null
  updatedAt: number | null
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly connectUrl?: string,
  ) {
    super(message)
    this.name = "ApiError"
  }

  /** True when the fix is a one-time INDmoney consent. */
  get needsConnection(): boolean {
    return this.code === "not_connected" || this.code === "unauthorized"
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
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
    const record = (body ?? {}) as { error?: string; message?: string; connectUrl?: string }
    throw new ApiError(
      response.status,
      record.error ?? "http_error",
      record.message ?? `${response.status} ${response.statusText}`,
      record.connectUrl,
    )
  }
  return body as T
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(path, { signal })
}

export const api = {
  status: (signal?: AbortSignal) => request<ConnectionStatus>("/api/indmoney/status", signal),
  search: (query: string, signal?: AbortSignal) =>
    request<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}`, signal),
  candles: (indKey: string, interval: string, lookback: string, signal?: AbortSignal) =>
    request<CandleResponse>(
      `/api/candles?${new URLSearchParams({ ind_key: indKey, interval, lookback }).toString()}`,
      signal,
    ),
  quote: (indKey: string, signal?: AbortSignal) =>
    request<Quote>(`/api/quote?ind_key=${encodeURIComponent(indKey)}`, signal),
  getWorkspace: (key: string, signal?: AbortSignal) =>
    request<WorkspaceResponse>(`/api/workspace/${encodeURIComponent(key)}`, signal),
  putWorkspace: (key: string, payload: unknown) =>
    apiRequest<{ ok: boolean; updatedAt: number }>(`/api/workspace/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ payload }),
    }),
}
