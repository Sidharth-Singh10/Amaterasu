import type { OpResult } from "@amaterasu/chart-dsl"
import { apiRequest } from "./client"

/** Raw OpenCode message (rendered defensively by the chat panel). */
export interface RawMessage {
  id: string
  type: string
  text?: string
  time?: { created?: number }
  content?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface ChartSyncPayload {
  chartId: string
  symbol: string
  interval: string
  from?: number
  to?: number
}

/** Events forwarded by the Rust bridge from OpenCode + the chart plugin. */
export interface StreamEvent {
  type: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * One shared SSE connection for the app. Consumers subscribe with `onStreamEvent`;
 * the first `startStream()` call opens the connection (EventSource auto-reconnects).
 */
let source: EventSource | null = null
let started = false
const listeners = new Set<(event: StreamEvent) => void>()

function openStream(): () => void {
  if (!started) {
    started = true
    source = new EventSource("/api/stream")
    source.onmessage = (message) => {
      let event: StreamEvent
      try {
        event = JSON.parse(message.data) as StreamEvent
      } catch {
        return
      }
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          console.error("stream listener failed", error)
        }
      }
    }
  }
  return () => {}
}

export function onStreamEvent(listener: (event: StreamEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface ChatSession {
  sessionID: string
}

export const bridge = {
  startStream: openStream,
  createChatSession: () => apiRequest<ChatSession>("/api/chat/session", { method: "POST" }),
  prompt: (sessionID: string, text: string) =>
    apiRequest<{ turnId: string }>(`/api/chat/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  interrupt: (sessionID: string) =>
    apiRequest<{ ok: boolean }>(`/api/chat/${sessionID}/interrupt`, { method: "POST" }),
  messages: (sessionID: string) => apiRequest<{ messages: RawMessage[] }>(`/api/chat/${sessionID}/messages`),
  attach: (chartId: string) =>
    apiRequest<{ ok: boolean }>("/api/chart/attach", { method: "POST", body: JSON.stringify({ chartId }) }),
  detach: (chartId: string) =>
    apiRequest<{ ok: boolean }>("/api/chart/detach", { method: "POST", body: JSON.stringify({ chartId }) }),
  sync: (payload: ChartSyncPayload) =>
    apiRequest<{ ok: boolean }>("/api/chart/sync", { method: "POST", body: JSON.stringify(payload) }),
  opAck: (requestId: string, result: OpResult) =>
    apiRequest<{ ok: boolean }>("/api/chart/op-ack", {
      method: "POST",
      body: JSON.stringify({ requestId, result }),
    }),
  stateAck: (requestId: string, result: Record<string, unknown>) =>
    apiRequest<{ ok: boolean }>("/api/chart/state-ack", {
      method: "POST",
      body: JSON.stringify({ requestId, result }),
    }),
}
