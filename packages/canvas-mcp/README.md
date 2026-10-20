# @common-ground/canvas-mcp

Stdio MCP server for Common Ground. It is a thin client over the Rust server: the journal owns
ids, revisions, capability checks, and the audit chain; the browser adapter applies ops.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `doc_get` | `doc_id` | Metadata, audit verification, and the latest adapter snapshot |
| `op_apply` | `doc_id`, `ops[]` | Finalized acks (blocks until the browser acks) |
| `turn_undo` | `doc_id`, `turn_id` | New undo turn id and acks; a turn can be undone once |
| `state_query` | `doc_id`, `limit?` | Metadata, recent ops, and audit entries with verification |

`op_apply` takes full protocol envelopes, including `turn_id`, `seq`, `actor`, `capability`,
`type`, `target`, `payload`, and `idempotency_key`. The server assigns ids and revisions.

## Run

```sh
COMMON_GROUND_URL=http://127.0.0.1:8787 node packages/canvas-mcp/src/main.ts
```

`COMMON_GROUND_URL` defaults to `AMATERASU_URL`, then `http://127.0.0.1:8787`. The document id is
the chart id stored in `sessionStorage["amaterasu.chartId"]`.

## MCP client config

```json
{
  "mcpServers": {
    "common-ground": {
      "command": "node",
      "args": ["/home/levi/amaterasu/packages/canvas-mcp/src/main.ts"],
      "env": { "COMMON_GROUND_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

The server writes only JSON-RPC to stdout; diagnostics belong on stderr.
