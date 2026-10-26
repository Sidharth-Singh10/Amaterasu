import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"
import {
  AckBaseSchema,
  AuditEntrySchema,
  BatchSchema,
  CapabilityClaimsSchema,
  EnvelopeBaseSchema,
  PROTOCOL_VERSION,
  TurnSchema,
} from "../src/protocol.ts"

/**
 * Generates `spec/schemas/*.json` from the zod definitions so the spec and the runtime
 * cannot drift. Run with `npm run schemas` in this package.
 */

const OUT_DIR = resolve(import.meta.dirname, "../../../spec/schemas")

const entries: Array<{ file: string; title: string; schema: z.ZodType }> = [
  { file: "envelope.json", title: "Tenon op envelope", schema: EnvelopeBaseSchema },
  { file: "batch.json", title: "Tenon op batch", schema: BatchSchema },
  { file: "ack.json", title: "Tenon op ack", schema: AckBaseSchema },
  { file: "turn.json", title: "Tenon turn", schema: TurnSchema },
  { file: "capability.json", title: "Tenon capability claims", schema: CapabilityClaimsSchema },
  { file: "audit-entry.json", title: "Tenon audit entry", schema: AuditEntrySchema },
]

mkdirSync(OUT_DIR, { recursive: true })

const manifest: Record<string, string> = {}

for (const { file, title, schema } of entries) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:tenon:protocol:${PROTOCOL_VERSION}:${file.replace(/\.json$/, "")}`,
    title,
    ...json,
  }
  writeFileSync(resolve(OUT_DIR, file), `${JSON.stringify(document, null, 2)}\n`)
  manifest[file] = title
}

writeFileSync(
  resolve(OUT_DIR, "manifest.json"),
  `${JSON.stringify({ protocol_version: PROTOCOL_VERSION, generated_by: "packages/canvas-core/scripts/emit-schemas.ts", schemas: manifest }, null, 2)}\n`,
)

console.log(`wrote ${entries.length + 1} schema files to ${OUT_DIR}`)
