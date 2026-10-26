import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Ack, Actor } from "@tenon-protocol/core"
import type {
  CaseResult,
  Check,
  ConformanceTarget,
  Fixture,
  OpShorthand,
  Point,
  Step,
} from "./types.ts"

const DEFAULT_ACTOR: Actor = { kind: "agent", id: "conformance", session: "ses_conformance" }
const UNDO_ACTOR: Actor = { kind: "human", id: "conformance-user" }
const CREATED_AT = "2026-10-20T09:41:02Z"
const EPSILON = 1e-9

function defaultFixturesDir(): string {
  // In the repo, read the canonical fixtures under spec/. In the published package, use the
  // copy that `scripts/copy-fixtures.mjs` places next to the compiled runner.
  const repoDir = fileURLToPath(new URL("../../../spec/conformance/cases", import.meta.url))
  try {
    if (readdirSync(repoDir).length > 0) return repoDir
  } catch {
    // The package was installed outside the monorepo.
  }
  return fileURLToPath(new URL("./fixtures", import.meta.url))
}

export function loadFixtures(directory?: string): Fixture[] {
  const dir = directory ?? defaultFixturesDir()
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const fixture = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as Fixture
      for (const field of ["id", "kind", "title", "steps"] as const) {
        if (fixture[field] === undefined) throw new Error(`${file}: missing ${field}`)
      }
      if (!Array.isArray(fixture.steps) || fixture.steps.length === 0) {
        throw new Error(`${file}: steps must be a non-empty array`)
      }
      return fixture
    })
}

export async function runFixture(target: ConformanceTarget, fixture: Fixture): Promise<CaseResult> {
  await target.reset(fixture.setup ?? {})
  const checks: Check[] = []
  const docId = fixture.docId ?? "doc_conformance"
  const actor = fixture.actor ?? DEFAULT_ACTOR
  const capability = fixture.capability ?? "cap_write"
  let lastTurnId: string | null = null
  let lastAck: Ack | null = null

  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) })
  }

  for (let index = 0; index < fixture.steps.length; index += 1) {
    const step = fixture.steps[index]!
    const label = `step ${index + 1} (${step.kind})`

    switch (step.kind) {
      case "apply": {
        const envelope = buildEnvelope(step.op, { docId, actor, capability, stepIndex: index })
        const ack = await target.apply(envelope)
        lastAck = ack
        lastTurnId = ack.status === "applied" ? ack.turn_id : lastTurnId
        compareAck(check, label, ack, step.expect)
        break
      }
      case "apply_raw": {
        const ack = await target.apply(step.envelope)
        lastAck = ack
        lastTurnId = ack.status === "applied" ? ack.turn_id : lastTurnId
        compareAck(check, label, ack, step.expect)
        break
      }
      case "snapshot": {
        const snapshot = target.snapshot()
        if (step.expect.revision !== undefined) {
          check(`${label}: revision`, snapshot.revision === step.expect.revision, `expected ${step.expect.revision}, got ${snapshot.revision}`)
        }
        if (step.expect.objectCount !== undefined) {
          check(
            `${label}: object count`,
            snapshot.objects.length === step.expect.objectCount,
            `expected ${step.expect.objectCount}, got ${snapshot.objects.length}`,
          )
        }
        if (step.expect.objectIds !== undefined) {
          const ids = snapshot.objects.map((object) => object.id)
          check(`${label}: object ids`, JSON.stringify(ids) === JSON.stringify(step.expect.objectIds), `got ${JSON.stringify(ids)}`)
        }
        if (step.expect.data !== undefined) {
          for (const [id, expected] of Object.entries(step.expect.data)) {
            const object = snapshot.objects.find((candidate) => candidate.id === id)
            check(`${label}: data ${id}`, object !== undefined && samePoint(object.data, expected), `got ${JSON.stringify(object?.data)}`)
          }
        }
        break
      }
      case "undo": {
        const turnId = resolveTurn(step.turn, lastTurnId, lastAck)
        const outcome = await target.undo(turnId, UNDO_ACTOR, fixture.undoCapability ?? capability)
        const ack = outcome.acks[0]
        if (!ack) {
          check(`${label}: returned an ack`, false, "no acks")
          break
        }
        compareAck(check, label, ack, step.expect)
        if (ack.status === "applied" && outcome.turn) lastTurnId = outcome.turn.turn_id
        break
      }
      case "verify_audit": {
        const verification = target.verifyAudit()
        check(`${label}: ok`, verification.ok === step.expect.ok, `expected ${step.expect.ok}, got ${verification.ok}`)
        if (step.expect.brokenAt !== undefined) {
          check(`${label}: brokenAt`, verification.brokenAt === step.expect.brokenAt, `expected ${step.expect.brokenAt}, got ${verification.brokenAt}`)
        }
        if (step.expect.length !== undefined) {
          const length = target.audit().length
          check(`${label}: length`, length === step.expect.length, `expected ${step.expect.length}, got ${length}`)
        }
        break
      }
      case "tamper_audit": {
        if (!target.tamperAudit) {
          check(`${label}: tamper hook`, false, "target does not expose tamperAudit")
          break
        }
        target.tamperAudit(step.index, step.patch)
        check(`${label}: applied`, true)
        break
      }
      case "project":
      case "unproject": {
        const actual =
          step.kind === "project" ? target.project(step.point, step.viewport) : target.unproject(step.screen, step.viewport)
        check(
          `${label}: coordinates`,
          samePoint(actual, step.expect),
          `expected ${JSON.stringify(step.expect)}, got ${JSON.stringify(actual)}`,
        )
        break
      }
      default: {
        const exhaustive: never = step
        throw new Error(`unknown step ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  return {
    id: fixture.id,
    kind: fixture.kind,
    title: fixture.title,
    ok: checks.every((entry) => entry.ok),
    checks,
  }
}

export async function runSuite(target: ConformanceTarget, fixtures = loadFixtures()): Promise<CaseResult[]> {
  const results: CaseResult[] = []
  for (const fixture of fixtures) results.push(await runFixture(target, fixture))
  return results
}

function buildEnvelope(
  op: OpShorthand,
  context: { docId: string; actor: Actor; capability: string; stepIndex: number },
) {
  const turn = op.turn ?? `turn_${context.stepIndex + 1}`
  const seq = op.seq ?? 1
  return {
    v: 1,
    doc_id: context.docId,
    turn_id: turn,
    seq,
    actor: op.actor ?? context.actor,
    capability: op.capability ?? context.capability,
    type: op.type,
    target: op.target ?? { kind: "obj" },
    payload: op.payload ?? {},
    ...(op.rationale ? { rationale: op.rationale } : {}),
    ...(op.approval ? { approval: op.approval } : {}),
    idempotency_key: op.idempotency_key ?? `${turn}:${seq}`,
    created_at: CREATED_AT,
  }
}

function resolveTurn(reference: string, lastTurnId: string | null, lastAck: Ack | null): string {
  if (reference === "$last") {
    if (!lastTurnId) throw new Error("$last used before any applied turn")
    return lastTurnId
  }
  if (reference === "$lastAckTurn") {
    if (!lastAck) throw new Error("$lastAckTurn used before any ack")
    return lastAck.turn_id
  }
  return reference
}

function compareAck(
  check: (name: string, ok: boolean, detail?: string) => void,
  label: string,
  ack: Ack,
  expect: { status: "applied" | "rejected"; code?: string; revision?: number; replayed?: boolean; objectId?: string },
): void {
  check(`${label}: status`, ack.status === expect.status, `expected ${expect.status}, got ${ack.status}`)
  if (expect.code !== undefined) {
    check(`${label}: code`, ack.code === expect.code, `expected ${expect.code}, got ${ack.code}`)
  }
  if (expect.revision !== undefined) {
    check(`${label}: revision`, ack.revision === expect.revision, `expected ${expect.revision}, got ${ack.revision}`)
  }
  if (expect.replayed !== undefined) {
    check(`${label}: replayed`, ack.replayed === expect.replayed, `expected ${expect.replayed}, got ${ack.replayed}`)
  }
  if (expect.objectId !== undefined) {
    const actual = (ack.result as { object_id?: string } | undefined)?.object_id
    check(`${label}: object id`, actual === expect.objectId, `expected ${expect.objectId}, got ${actual}`)
  }
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON
}
