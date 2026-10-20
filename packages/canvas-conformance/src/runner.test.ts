import { describe, expect, it } from "vitest"
import { MemoryTarget } from "./memory-target.ts"
import { loadFixtures, runFixture } from "./runner.ts"
import type { Fixture } from "./types.ts"

const NOW = () => new Date("2026-06-01T00:00:00Z")

describe("conformance suite", () => {
  const fixtures = loadFixtures()

  it("loads the six v0 cases with unique ids", () => {
    expect(fixtures).toHaveLength(6)
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(6)
    expect(fixtures.map((fixture) => fixture.kind).sort()).toEqual(
      ["anchor_survival", "audit_chain", "capability_denial", "idempotent_retry", "malformed_op", "undo_redo"].sort(),
    )
  })

  for (const fixture of fixtures) {
    it(`${fixture.id} — ${fixture.title}`, async () => {
      const target = new MemoryTarget({ now: NOW })
      const result = await runFixture(target, fixture)
      const failures = result.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail ?? "failed"}`)
      expect(failures).toEqual([])
      expect(result.ok).toBe(true)
    })
  }

  it("reports a failed expectation instead of throwing", async () => {
    const fixture: Fixture = {
      id: "self-check",
      kind: "malformed_op",
      title: "runner reports mismatches",
      steps: [{ kind: "snapshot", expect: { objectCount: 1 } }],
    }
    const result = await runFixture(new MemoryTarget({ now: NOW }), fixture)
    expect(result.ok).toBe(false)
    expect(result.checks[0]?.ok).toBe(false)
  })
})
