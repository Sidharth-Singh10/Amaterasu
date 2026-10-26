# r/mcp draft

**Title**

Tenon: an MCP server for reversible, auditable document edits (open source, MIT)

**Body**

Most MCP servers expose a set of verbs. That works until an agent needs to edit state a human also
owns. Then you need more than a tool call: you need an object id, an inverse, a capability, and a
record of who did what.

I built **Tenon** around that idea. It is an open protocol plus a TypeScript SDK. The MCP
server is a thin client over a journal:

| Tool | What it does |
|---|---|
| `doc_get` | Revision, pending count, audit status, latest adapter snapshot |
| `op_apply` | Journal and apply protocol envelopes; waits for the adapter ack |
| `turn_undo` | Replay a turn's inverses as a new audited turn |
| `state_query` | Recent ops plus audit-chain verification |

Install:

```sh
npx -y @tenon-protocol/mcp
```

Config:

```json
{
  "mcpServers": {
    "tenon": {
      "command": "npx",
      "args": ["-y", "@tenon-protocol/mcp"],
      "env": { "TENON_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

The server needs a running Tenon journal and a connected adapter. It does not store state
itself. The reference journal is a Rust/axum service in the same repo; the reference adapter is a
chart canvas, and there is a second graph adapter to show the protocol is not chart-specific.

Why envelopes instead of simple tools: an envelope carries `actor`, `turn_id`, `capability`,
`target`, `idempotency_key`, and an optional rationale. The ack carries `status`, `revision`,
`result`, and the inverse. That is what makes per-turn undo, approval gates, and an audit chain
possible. A rejected op can carry a `suggestion` (for example, the nearest valid time anchor) so the
agent can self-correct.

Registry name: `io.github.Sidharth-Singh10/tenon`

Caveats, so nobody is surprised:

- v0.1, MIT, server-authoritative. No CRDT or offline conflict resolution yet.
- The MCP server is a client; without a journal and adapter it will not do anything useful.
- The hosted demo is a static chart editor with sample data; the agent path needs a local server
  and model.
- The protocol is domain-neutral, but the only production-tested adapters are chart and graph.

Links:

- Landing: https://sidharth-singh10.github.io/Amaterasu/
- Repo: https://github.com/Sidharth-Singh10/Amaterasu
- MCP package: https://www.npmjs.com/package/@tenon-protocol/mcp
- Spec: https://github.com/Sidharth-Singh10/Amaterasu/blob/master/spec/protocol.md

Happy to answer questions about the envelope/ack design, the capability tokens, or what it took to
make the same conformance fixtures pass against TypeScript and Rust.
