# Show HN draft

**Title (56 chars)**

Show HN: Tenon – typed, reversible actions for AI agents

**URL**

https://sidharth-singh10.github.io/Amaterasu/

**Body**

Hi HN — I built Tenon, an open protocol for humans and AI agents editing the same visual
workspace.

The problem: screenshot agents are impressive until they touch something real. A click at (812,
430) is not a trendline. MCP standardized how agents call tools, but a tool call like
`draw_line(x1, y1, x2, y2)` still has no object, no undo, no capability, and no audit trail.

Tenon gives every mutation a typed envelope (actor, turn, capability, target, idempotency
key, rationale), a server-assigned revision, an adapter ack, and an inverse. Destructive agent ops
can require a one-shot human approval. Every attempt — applied or rejected — goes into a
hash-chained audit log. Undo is a new turn that replays the stored inverses.

What is live:

- The protocol spec and generated JSON Schemas
- TypeScript SDK: core, chart adapter, graph adapter, conformance runner
- An MCP server (`doc_get`, `op_apply`, `turn_undo`, `state_query`)
- Amaterasu, a chart analyst that draws through the same op DSL as the mouse
- A static interactive demo of the chart editor (sample data; the agent is disabled because it
  needs a server and a model)
- Six conformance fixtures that run against both a TypeScript target and the Rust journal

Stack: TypeScript + zod for the SDK, Rust/axum + SQLite for the reference journal, SvelteKit for
the app, Ed25519 capability tokens, blake3 audit chain. MIT.

What it is not: a CRDT, a replacement for MCP, or a hosted multi-tenant product. v1 is
server-authoritative and local-first. The graph adapter is a second domain, not a claim that every
canvas is solved.

I would especially like feedback from people building agent-native tools: is the envelope the right
abstraction, and what would make an adapter integration take a day instead of a week?

Links:
- Landing: https://sidharth-singh10.github.io/Amaterasu/
- Demo: https://sidharth-singh10.github.io/Amaterasu/demo/?demo=1
- GitHub: https://github.com/Sidharth-Singh10/Amaterasu
- SDK guide: https://github.com/Sidharth-Singh10/Amaterasu/blob/master/docs/sdk.md
- Spec: https://github.com/Sidharth-Singh10/Amaterasu/blob/master/spec/protocol.md

**First comment (post immediately, optional)**

A note on the demo: GitHub Pages is static, so the hosted demo runs the real chart shell and
overlay engine on deterministic candles, but not the model. To see the agent path, run the app and
OpenCode locally; the README has the two commands. I kept the hosted demo honest rather than
faking a streamed response.
