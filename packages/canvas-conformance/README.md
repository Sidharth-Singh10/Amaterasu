# @tenon-protocol/conformance

Six language-agnostic fixtures and a runner for **Tenon** implementations.

The fixtures exercise anchor survival, undo/redo, idempotent retry, capability denial, malformed
ops, and audit-chain tamper detection. The same corpus is run against the TypeScript
`MemoryTarget` and the Rust journal in `server/tests/conformance.rs`.

## Install

```sh
npm install @tenon-protocol/conformance @tenon-protocol/core
```

## Run the corpus

```ts
import { MemoryTarget, loadFixtures, runSuite } from "@tenon-protocol/conformance"

const results = await runSuite(new MemoryTarget(), loadFixtures())
const failed = results.filter((result) => !result.ok)

console.log(`${results.length - failed.length}/${results.length} fixtures passed`)
if (failed.length > 0) process.exitCode = 1
```

The published package includes the six fixture JSON files, so `loadFixtures()` works without the
repository. Pass a directory to run your own corpus.

## Test another target

Implement `ConformanceTarget`:

```ts
interface ConformanceTarget {
  reset(seed: DocSeed): Promise<void> | void
  apply(envelope: unknown): Promise<Ack> | Ack
  undo(turnId: string, actor: Actor, capability: string): Promise<{ turn?: Turn; acks: Ack[] }> | { turn?: Turn; acks: Ack[] }
  snapshot(): DocSnapshot
  project(point: Point, viewport: Viewport): Point
  unproject(screen: Point, viewport: Viewport): Point
  audit(): readonly AuditEntry[]
  verifyAudit(): AuditVerification
  tamperAudit?(index: number, patch: Record<string, unknown>): void
}
```

Then call `runSuite(yourTarget)`. The target owns ids, revisions, idempotency, capabilities, and
the audit chain; the fixtures only describe observable behavior.

## Related packages

- [`@tenon-protocol/core`](../canvas-core) — protocol schemas and audit helpers
- [`@tenon-protocol/chart`](../canvas-chart) — chart adapter
- [`@tenon-protocol/graph`](../canvas-graph) — graph adapter

MIT licensed.
