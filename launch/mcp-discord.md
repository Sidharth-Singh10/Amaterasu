# MCP Discord draft

**Channel:** #show-and-tell (or the appropriate server showcase channel)

**Message**

I published an MCP server for **Common Ground**, an open protocol for reversible, auditable
document edits by agents and humans.

The four tools are `doc_get`, `op_apply`, `turn_undo`, and `state_query`. Ops carry an actor, turn,
capability, idempotency key, and target; acks carry the result and the inverse. That lets the server
do per-turn undo, approval gates for destructive ops, and a hash-chained audit log.

```sh
npx -y @common-ground/canvas-mcp
```

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

It needs a running Common Ground journal and a connected adapter; it is a thin client, not a
standalone store. The repo has a Rust journal, a chart adapter, a second graph adapter, and six
conformance fixtures. MIT, v0.1, registry name `io.github.Sidharth-Singh10/common-ground`.

Landing: https://sidharth-singh10.github.io/Amaterasu/
Repo: https://github.com/Sidharth-Singh10/Amaterasu

Would love feedback on the tool surface — especially whether `op_apply` should accept domain
shorthand or stay envelope-only.
