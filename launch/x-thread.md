# X / LinkedIn thread draft

**Post 1**

MCP gave agents tools.
Tenon gives them a shared workspace.

An open protocol for humans and AI agents editing the same canvas — typed ops, scoped
capabilities, acks, per-turn undo, and a hash-chained audit log.

Live demo + MIT SDK: https://sidharth-singh10.github.io/Amaterasu/

**Post 2**

Screenshot agents look magical until the layout changes.

A click at (812, 430) is not a trendline. It has no id, no inverse, no owner, and no record. In
precision domains, "close enough" is wrong.

**Post 3**

MCP standardized the verb. It did not standardize the object.

`draw_line(x1, y1, x2, y2)` does not say which document it belongs to, what it created, who
authorized it, or how to undo it.

**Post 4**

Tenon makes every mutation the same envelope:

actor · turn · capability · target · idempotency key · rationale

The server assigns the revision. The adapter applies or rejects it. The ack carries the result and
the inverse.

**Post 5**

That one contract buys four things:

- typed operations instead of coordinates
- one-turn undo instead of screenshot diffs
- scoped capabilities and approval gates
- an append-only audit chain

**Post 6**

It is not a CRDT and not a replacement for MCP.

v1 is server-authoritative. MCP standardizes how an agent calls a tool; Tenon standardizes
the state it mutates and the record it leaves behind.

**Post 7**

Published today:

- TypeScript SDK (core, chart, graph, conformance)
- MCP server: `npx -y @tenon-protocol/mcp`
- Protocol spec + 6 language-agnostic fixtures
- Amaterasu reference app

MIT. Feedback welcome.
https://github.com/Sidharth-Singh10/Amaterasu

**Suggested media**

- Post 1: `site/og.png`
- Post 2: `site/demo-poster.png`
- Post 4: a cropped screenshot of the journal trace from the landing page
