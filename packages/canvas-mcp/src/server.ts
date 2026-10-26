import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { EnvelopeSchema } from "@tenon-protocol/core"
import { z } from "zod"
import type { TenonClient } from "./client.ts"

async function textResult(action: () => Promise<unknown>) {
  try {
    const value = await action()
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    }
  }
}

/**
 * The four Tenon tools. Tool inputs are envelopes, not domain shorthands: an adapter
 * registers its own op types and the server remains domain-neutral.
 */
export function createServer(client: TenonClient): McpServer {
  const server = new McpServer({ name: "tenon", version: "0.1.0" })

  server.registerTool(
    "doc_get",
    {
      title: "Get document",
      description:
        "Read a document's revision, pending count, audit status, and latest adapter snapshot.",
      inputSchema: {
        doc_id: z.string().min(1).describe("Tenon document id"),
      },
    },
    async ({ doc_id }) => textResult(() => client.docGet(doc_id)),
  )

  server.registerTool(
    "op_apply",
    {
      title: "Apply operations",
      description:
        "Submit one or more protocol envelopes. The server journals and capability-checks them before the adapter applies them, and blocks until the adapter acks.",
      inputSchema: {
        doc_id: z.string().min(1).describe("Tenon document id"),
        ops: z.array(EnvelopeSchema).min(1).describe("Envelopes to apply in order"),
      },
    },
    async ({ doc_id, ops }) =>
      textResult(() => client.opApply(doc_id, ops as Array<Record<string, unknown>>)),
  )

  server.registerTool(
    "turn_undo",
    {
      title: "Undo turn",
      description:
        "Undo one applied turn by replaying its adapter-supplied inverses as a new audited turn. A turn can be undone once; undo of an undo redoes it.",
      inputSchema: {
        doc_id: z.string().min(1).describe("Tenon document id"),
        turn_id: z.string().min(1).describe("Turn id to undo"),
      },
    },
    async ({ doc_id, turn_id }) => textResult(() => client.turnUndo(doc_id, turn_id)),
  )

  server.registerTool(
    "state_query",
    {
      title: "Query state and history",
      description:
        "Read document metadata, recent journaled ops, and the audit chain with verification.",
      inputSchema: {
        doc_id: z.string().min(1).describe("Tenon document id"),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum ops to return"),
      },
    },
    async ({ doc_id, limit }) => textResult(() => client.stateQuery(doc_id, limit)),
  )

  return server
}
