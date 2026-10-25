# @common-ground/canvas-mcp

Stdio MCP server for **Common Ground**. It exposes a running Common Ground journal to MCP clients:
read document metadata, apply typed envelopes, undo a turn, and query the audit chain.

The package is a thin client. The Common Ground server owns ids, revisions, capability checks, and
the audit chain; a browser or graph adapter applies the ops and returns acks.

## Install

```sh
npm install -g @common-ground/canvas-mcp
# or run without installing
npx -y @common-ground/canvas-mcp
```

## Tools

| Tool | Input | Returns |
|---|---|---|
| `doc_get` | `doc_id` | Metadata, audit verification, and the latest adapter snapshot |
| `op_apply` | `doc_id`, `ops[]` | Finalized acks; blocks until the adapter acks |
| `turn_undo` | `doc_id`, `turn_id` | New undo turn id and acks; a turn can be undone once |
| `state_query` | `doc_id`, `limit?` | Metadata, recent ops, and audit entries with verification |

`op_apply` takes full protocol envelopes, including `turn_id`, `seq`, `actor`, `capability`,
`type`, `target`, `payload`, and `idempotency_key`. The server assigns ids and revisions. The
client fetches and caches the signed `X-CG-Capability` token for the envelope's capability, so the
Common Ground server must be reachable for token minting.

## Configure

```json
{
  "mcpServers": {
    "common-ground": {
      "command": "npx",
      "args": ["-y", "@common-ground/canvas-mcp"],
      "env": { "COMMON_GROUND_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

| Variable | Default | Purpose |
|---|---|---|
| `COMMON_GROUND_URL` | `AMATERASU_URL`, then `http://127.0.0.1:8787` | Base URL of the Common Ground server |
| `AMATERASU_URL` | — | Fallback for existing Amaterasu deployments |

`doc_id` is the document configured in the adapter. For Amaterasu it is the chart id in
`sessionStorage["amaterasu.chartId"]`.

The server writes only JSON-RPC to stdout; diagnostics go to stderr.

## Requirements

You need a running Common Ground server and a connected adapter. The registry metadata for this
package is [`io.github.Sidharth-Singh10/common-ground`](https://registry.modelcontextprotocol.io/).

MIT licensed.
