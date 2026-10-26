# Conformance suite v0

Language-agnostic fixtures live in `cases/`. The runner is `packages/canvas-conformance`.
A target implements `ConformanceTarget` and runs the same JSON without modification.

## Run it

```sh
npm install
npm run test:conformance
```

The suite currently runs against `MemoryTarget`, a minimal reference implementation of the
protocol spine (revisions, idempotency, capabilities, audit chain) with a 2D object model. It
proves the fixtures and the spec. It is **not** evidence that `tenon-server` or the chart adapter
conform; those targets are wired in Phase 1.

## The six cases

| File | Property |
|---|---|
| `01-anchor-survival.json` | Document points survive zoom/pan, round-trip, and are unchanged by view ops |
| `02-undo-redo.json` | Undo appends inverse ops as a new turn; redo is an undo of the undo; a turn is undone once |
| `03-idempotent-retry.json` | Same key + payload replays the ack without re-applying; a changed payload conflicts |
| `04-capability-denial.json` | Out-of-scope, expired, and mis-bound capabilities are rejected; the document is unchanged |
| `05-malformed-op.json` | Bad envelope, unknown type, bad payload, and missing target produce typed codes |
| `06-audit-chain.json` | The chain verifies; tampering is detected at the exact index |

## Fixture format

A fixture is JSON with `id`, `kind`, `title`, optional `docId`, `setup`, `actor`, `capability`,
and a non-empty `steps` array.

`setup.capabilities` are capability **claims** (post-signature); the harness is responsible for
signature verification, and fixtures test scope/permission/expiry/audience only.

### Steps

| Step | Fields | Meaning |
|---|---|---|
| `apply` | `op`, `expect` | Build an envelope from the shorthand and apply it |
| `apply_raw` | `envelope`, `expect` | Apply a literal envelope (used for malformed cases) |
| `snapshot` | `expect` | Assert revision, object count, ids, and/or data |
| `undo` | `turn`, `expect` | Undo a turn id, or `$last` for the last applied turn |
| `verify_audit` | `expect` | Assert `ok`, `brokenAt`, and/or entry count |
| `tamper_audit` | `index`, `patch` | Test hook: mutate one audit entry |
| `project` / `unproject` | point/screen, viewport, `expect` | Viewport projection checks |

`op` shorthand: `type`, `target`, `payload`, optional `turn` (default `turn_{step}`), `seq`
(default 1), `capability`, `actor`, `approval`, `idempotency_key` (default `{turn}:{seq}`).

`expect` for apply/undo: `status`, and optionally `code`, `revision`, `replayed`, `objectId`.
Unspecified fields are not asserted.

## Adding a case

1. Add a JSON file; keep it free of language-specific syntax.
2. Add the `kind` to `CaseKind` in `packages/canvas-conformance/src/types.ts`.
3. If it needs a new step, add it to `Step` and to `runFixture`.
4. Run `npm run test:conformance` against the reference target.
5. Mark the case `pending` in the target matrix below until the real targets pass.

## Target matrix

| Target | Status |
|---|---|
| `MemoryTarget` (reference, TS) | 6/6 |
| `tenon-server` + chart adapter (Rust/TS) | not wired — Phase 1 |
