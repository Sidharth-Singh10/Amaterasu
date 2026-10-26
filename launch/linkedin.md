# LinkedIn draft

MCP gave agents tools. Tenon gives them a shared workspace.

Most agent demos still end with a screenshot and a click. That works for exploration, but not for
software where precision matters. A click at (812, 430) is not a trendline. It has no id, no
inverse, no owner, and no audit trail.

I published Tenon, an open protocol for humans and AI agents editing the same visual
workspace. Every mutation is a typed envelope: actor, turn, capability, target, idempotency key, and
an optional rationale. The adapter applies or rejects it. The server journals the result and the
inverse. A turn can be undone atomically. Destructive ops can require a human approval. Every
attempt goes into a hash-chained audit log.

The release includes a TypeScript SDK, a chart adapter, a second graph adapter, six
language-agnostic conformance fixtures, an MCP server, and Amaterasu — a reference chart analyst
that draws through the same op DSL as the mouse.

It is MIT licensed, server-authoritative in v1, and honest about what it is not: no CRDT, no
multi-tenant hosted service, and the static demo does not run the model.

Landing page and live demo: https://sidharth-singh10.github.io/Amaterasu/
Code: https://github.com/Sidharth-Singh10/Amaterasu

I would value feedback from teams building agent-native tools, especially on the envelope/ack
boundary and what a one-day adapter integration should include.
