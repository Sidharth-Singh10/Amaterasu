import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, it } from "vitest"
import type { TenonClient } from "./client.ts"
import { createServer } from "./server.ts"

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const first = content?.[0]
  if (first?.type !== "text" || !first.text) throw new Error("expected a text result")
  return first.text
}

describe("Tenon MCP server", () => {
  let close: (() => Promise<void>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it("registers the four tools and returns structured JSON", async () => {
    const calls: string[] = []
    const stub = {
      docGet: async (docId: string) => {
        calls.push(`doc:${docId}`)
        return {
          doc: {
            doc: { doc_id: docId, revision: 1, next_seq: 2, pending: 0, audit_seq: 1 },
            verification: { ok: true },
          },
          snapshot: { docId, snapshot: { revision: 1, snapshot: { v: 1 } } },
        }
      },
      stateQuery: async (docId: string, limit?: number) => {
        calls.push(`state:${docId}:${limit ?? 50}`)
        return {
          doc: { doc: {}, verification: { ok: true } },
          ops: { docId, ops: [] },
          audit: { docId, entries: [], verification: { ok: true } },
        }
      },
      opApply: async (docId: string, ops: Array<Record<string, unknown>>) => {
        calls.push(`ops:${docId}:${ops.length}`)
        return { docId, acks: [{ status: "applied" }] }
      },
      turnUndo: async (docId: string, turnId: string) => {
        calls.push(`undo:${docId}:${turnId}`)
        return { docId, applied: true, acks: [] }
      },
    } as unknown as TenonClient

    const server = createServer(stub)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "tenon-mcp-test", version: "0.0.1" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    close = async () => {
      await client.close()
      await server.close()
    }

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "doc_get",
      "op_apply",
      "state_query",
      "turn_undo",
    ])

    const doc = await client.callTool({ name: "doc_get", arguments: { doc_id: "doc_1" } })
    expect(JSON.parse(textOf(doc))).toMatchObject({ snapshot: { docId: "doc_1" } })

    const envelope = {
      v: 1,
      doc_id: "doc_1",
      turn_id: "turn_1",
      seq: 1,
      actor: { kind: "agent", id: "test" },
      capability: "cap_local",
      type: "chart.view.set",
      target: { kind: "chart.view" },
      payload: { op: { op: "set_view" } },
      idempotency_key: "k1",
      created_at: "2026-10-20T09:41:02Z",
    }
    const applied = await client.callTool({
      name: "op_apply",
      arguments: { doc_id: "doc_1", ops: [envelope] },
    })
    expect(JSON.parse(textOf(applied))).toMatchObject({ acks: [{ status: "applied" }] })

    const state = await client.callTool({
      name: "state_query",
      arguments: { doc_id: "doc_1", limit: 5 },
    })
    expect(JSON.parse(textOf(state))).toMatchObject({ ops: { ops: [] } })

    const undo = await client.callTool({
      name: "turn_undo",
      arguments: { doc_id: "doc_1", turn_id: "turn_1" },
    })
    expect(JSON.parse(textOf(undo))).toMatchObject({ applied: true })

    expect(calls).toEqual([
      "doc:doc_1",
      "ops:doc_1:1",
      "state:doc_1:5",
      "undo:doc_1:turn_1",
    ])
  })
})
