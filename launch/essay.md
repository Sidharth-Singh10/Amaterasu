# Why structured operations beat screenshots

*The case for an action layer between agents and visual software.*

A demo of a computer-use agent is easy to make compelling. The agent looks at a screenshot, moves
a cursor, clicks a toolbar, drags a line across a chart, and types a summary. For thirty seconds it
looks like the future.

Then you put it in front of a real workspace.

The chart reflows. The user switches from daily to five-minute candles. The browser zoom is not
100%. A panel opens over the canvas. The agent clicks a coordinate that used to be a trendline. The
line it "drew" is a sequence of pixels, not an object. There is no id, no inverse, no owner, and no
record of which model made it. Undo removes the wrong thing, or nothing at all.

This is not a vision problem. The model can see the screen. The problem is that the screen is the
wrong interface for an action.

## What computer use is good at

Screenshot-driven agents are a real advance. They can operate software that was never designed for
automation, across arbitrary websites and desktop apps. That is valuable for long-tail workflows,
exploration, and migration.

But computer use optimizes for *reach*, not *precision*. It answers the question "can the agent
operate this interface?" It does not answer:

- What object did the agent create?
- Can the user undo exactly that action?
- Who authorized it, and with what scope?
- What happens when the layout changes?
- Can another component apply the same action without a browser?
- Can an auditor reconstruct what happened a week later?

In precision domains — charts, CAD, GIS, medical imaging, financial dashboards — "close enough"
is not a passing grade. A trendline anchored to a pixel instead of a bar is wrong the moment the
viewport changes.

## MCP standardized the verb. It did not standardize the object.

The Model Context Protocol solved a large part of the integration problem. Before MCP, every agent
framework had its own way to expose tools. After MCP, an agent can discover a tool, call it, and
read the result.

But a tool call is still a stateless verb. `draw_line(x1, y1, x2, y2)` does not describe:

- the chart, document, or workspace it belongs to;
- the object it creates, or that object's stable id;
- whether the user can undo it;
- who authorized it;
- how it survives a zoom or an interval change;
- whether it was already applied.

MCP gives agents a way to *act*. It does not give them a shared state to act *on*. That missing
layer is where most production agent work gets stuck.

## The four properties

A workspace that agents can safely edit needs four properties. They are not features; they are
invariants.

**Typed.** An action is a semantic operation against a known object model, not a coordinate. A
trendline has two anchors in data space. A rectangle has a range. A graph merge has a source and a
target. The adapter validates the shape before anything changes.

**Reversible.** Every applied operation carries enough information to undo it. The adapter owns the
inverse because only the adapter knows what the operation meant in its domain. Undo is not a
screenshot diff; it is a typed operation in the other direction.

**Attributable.** Every attempt records the actor, the turn, the capability, the target, and the
time. Applied and rejected attempts both belong in the record. A rejected operation is evidence
that the system refused something, not noise to discard.

**Scoped.** An agent should not inherit the user's full authority. It gets a capability: a
document, a set of op types, a set of permissions, an expiry, and optionally an approval
requirement for destructive operations. The capability is checked before the adapter sees the op.

These properties are not new ideas. Version control, databases, and workflow engines have had them
for decades. What is new is applying them to the visual workspace that an agent and a human share.

## One loop

Common Ground turns those properties into one loop.

1. **The agent sends an envelope.** It carries a protocol version, document id, turn id, sequence,
   actor, capability, op type, target, payload, idempotency key, and an optional rationale. The
   envelope is deliberately loose so newer peers can add metadata; the payload is validated by the
   adapter and stays domain-specific.

2. **The server checks the capability.** The grant names the documents, op types, permissions, and
   expiry. Destructive ops can require a one-shot human approval. A denied op gets a typed
   rejection, not a silent failure.

3. **The adapter applies or rejects it.** A chart adapter resolves `(time, price)` anchors against
   the bars currently loaded. If the anchor is outside the window, the rejection can carry a
   suggestion — the nearest valid bar — so the agent can self-correct instead of guessing again.

4. **The journal records the ack and inverse.** The server assigns the op id and revision. It
   stores the adapter's result and the inverse ops. A turn is a group of ops from one actor that can
   be undone atomically. Undoing a turn is itself a new turn, so the history stays append-only.

5. **The audit chain links the attempt.** Each entry is hashed with the previous hash, the canonical
   JSON of the entry, and a server-chosen hash function. The reference server uses blake3. A
   verifier can check sequencing, document identity, linkage, and every digest.

The important part is not any single step. It is that all five share one contract. The mouse, the
agent, an import job, and a test harness use the same op DSL. The browser owns projection. The
server owns revisions and policy. The adapter owns domain meaning. Each component can be replaced
without redefining the others.

## What it looks like when it works

An agent is asked to mark the recent swing low and the range around it.

It sends a `chart.shape.create` for a horizontal line at the swing low, then a rectangle for the
range. The server journals both under one turn, checks the capability, and waits for the browser to
ack. The browser validates the anchors, applies the shapes locally, computes inverses, and returns
the result. The shapes survive a zoom and an interval switch because they are anchored in data
space, not pixels.

Then the agent tries to delete a shape the user locked. The adapter rejects the op with
`unknown_target` or a lock warning. The server journals the rejection. The agent retries with a
different target. The user sees the whole exchange in the journal, including the refusal.

Later, the user clicks "undo this turn." The server replays the stored inverses as a new turn. The
shapes disappear. The audit chain still contains the original creation, the rejection, and the undo.
Nothing is rewritten.

That is a different product from a screenshot agent. It is not just safer. It is more capable,
because the agent can reason about ids, revisions, and rejections instead of pixels.

## What this is not

It is not a CRDT. Version 1 is server-authoritative. The journal assigns revisions and serializes
ops. Multiplayer conflict resolution and offline editing are later work. Claiming otherwise would
be dishonest.

It is not a replacement for MCP. It complements MCP. MCP standardizes how an agent discovers and
calls a tool. Common Ground standardizes the state that tool mutates, the permission it runs under,
and the record it leaves behind. The MCP server in this repo is a thin client over the journal.

It is not a UI framework. It does not render your canvas or prescribe your component tree. The
chart adapter ships with Amaterasu because that is the reference app; the graph adapter exists to
prove the protocol is not chart-specific.

It is not trying to make every action automatic. Approval gates are a feature. Some operations
should stop and ask a human. The protocol makes that a first-class state, not an afterthought.

## Evidence, not adjectives

The repository has six language-agnostic conformance fixtures:

1. anchor survival across viewport changes;
2. undo and redo;
3. idempotent retry;
4. capability denial;
5. malformed operation handling;
6. audit-chain tamper detection.

The same fixtures run against a TypeScript `MemoryTarget` and the Rust journal. A second product
adapter applies `graph.*` envelopes to a knowledge graph, computes inverses, and acks the journal.
The reference app, Amaterasu, journals every agent chart op before dispatch, verifies an Ed25519
capability token on writes, records the browser's inverse ops, and exposes document metadata,
snapshots, op history, audit, and forward-only undo endpoints.

That is the level of evidence a protocol needs. A demo can show one path working. A conformance
corpus shows that two implementations agree on the contract.

## The integration path

The smallest useful integration is smaller than most teams expect:

1. Define three object types and five ops.
2. Implement one write path with validation and an inverse.
3. Implement the conformance target.
4. Run the six fixtures.
5. Expose the ops to an agent through MCP.

The graph adapter is a compact example of the first four. The MCP server is the fifth. A developer
can get to a first ack in an afternoon and spend the rest of the time on domain semantics, which is
where the real value is.

## The interface is the document

The industry is converging on agents that can see and operate software. That is useful. But
seeing is not the same as understanding, and clicking is not the same as editing.

If we want agents to work inside the tools professionals already use, we need to give them the
document, not a picture of it. We need typed operations, stable ids, scoped authority, honest
rejections, and a record that survives the session.

MCP gave agents tools. The next layer gives them a shared workspace.

---

*Common Ground is MIT licensed. The protocol, SDK, conformance fixtures, and reference app are at
[github.com/Sidharth-Singh10/Amaterasu](https://github.com/Sidharth-Singh10/Amaterasu).*
