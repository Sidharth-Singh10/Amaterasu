import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { TenonClient } from "./client.ts"

const meta = {
  doc: { doc_id: "doc_1", revision: 2, next_seq: 3, pending: 0, audit_seq: 2 },
  verification: { ok: true },
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : null
}

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    client: new TenonClient(`http://127.0.0.1:${port}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe("TenonClient", () => {
  let close: (() => Promise<void>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it("reads metadata, snapshots, history, and audit", async () => {
    const requests: string[] = []
    const served = await serve((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.setHeader("content-type", "application/json")
      if (request.url === "/api/docs/doc_1") return response.end(JSON.stringify(meta))
      if (request.url === "/api/docs/doc_1/snapshot") {
        return response.end(
          JSON.stringify({ docId: "doc_1", snapshot: { revision: 2, snapshot: { v: 1 } } }),
        )
      }
      if (request.url?.startsWith("/api/docs/doc_1/ops")) {
        return response.end(JSON.stringify({ docId: "doc_1", ops: [] }))
      }
      if (request.url === "/api/docs/doc_1/audit") {
        return response.end(
          JSON.stringify({ docId: "doc_1", entries: [], verification: { ok: true } }),
        )
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: "not_found", message: "no route" }))
    })
    close = served.close

    const doc = await served.client.docGet("doc_1")
    expect(doc.doc.doc.revision).toBe(2)
    expect(doc.snapshot.snapshot?.snapshot).toEqual({ v: 1 })

    const state = await served.client.stateQuery("doc_1", 10)
    expect(state.ops.ops).toEqual([])
    expect(state.audit.verification.ok).toBe(true)

    expect(requests).toContain("GET /api/docs/doc_1/ops?limit=10")
  })

  it("posts ops and undo requests with capability tokens", async () => {
    const seen: Array<{ method?: string; url?: string; token?: string; body: unknown }> = []
    const served = await serve(async (request, response) => {
      response.setHeader("content-type", "application/json")
      if (request.url?.startsWith("/api/capabilities/") && request.url.endsWith("/token")) {
        const capId = request.url.split("/")[3]
        return response.end(JSON.stringify({ token: `tok_${capId}` }))
      }
      seen.push({
        method: request.method,
        url: request.url,
        token: request.headers["x-tenon-capability"] as string | undefined,
        body: await body(request),
      })
      if (request.url?.endsWith("/ops")) {
        return response.end(JSON.stringify({ docId: "doc_1", acks: [{ status: "applied" }] }))
      }
      if (request.url?.endsWith("/undo")) {
        return response.end(
          JSON.stringify({ docId: "doc_1", applied: true, undoTurnId: "turn_2", acks: [] }),
        )
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: "not_found", message: "no route" }))
    })
    close = served.close

    const envelope = { v: 1, doc_id: "doc_1", type: "chart.view.set" }
    const applied = await served.client.opApply("doc_1", [envelope])
    expect(applied).toEqual({ docId: "doc_1", acks: [{ status: "applied" }] })
    await served.client.turnUndo("doc_1", "turn_1")

    expect(seen[0]).toEqual({
      method: "POST",
      url: "/api/docs/doc_1/ops",
      token: "tok_cap_local",
      body: { ops: [envelope] },
    })
    expect(seen[1]).toEqual({
      method: "POST",
      url: "/api/docs/doc_1/turns/turn_1/undo",
      token: "tok_cap_undo",
      body: {},
    })
  })

  it("surfaces typed server errors", async () => {
    const served = await serve((_request, response) => {
      response.statusCode = 422
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: "invalid_op", message: "bad envelope" }))
    })
    close = served.close

    await expect(served.client.docGet("doc_1")).rejects.toMatchObject({
      status: 422,
      code: "invalid_op",
      message: "bad envelope",
    })
  })
})
