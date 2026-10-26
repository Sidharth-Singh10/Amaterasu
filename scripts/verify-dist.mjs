import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const packages = [
  "@tenon-protocol/core",
  "@tenon-protocol/chart",
  "@tenon-protocol/graph",
  "@tenon-protocol/conformance",
  "@tenon-protocol/mcp",
]

const tempRoot = "/tmp/opencode"
mkdirSync(tempRoot, { recursive: true })
const work = mkdtempSync(join(tempRoot, "tenon-dist-"))
const tarballs = join(work, "tarballs")
mkdirSync(tarballs, { recursive: true })

console.log(`packing into ${work}`)
for (const name of packages) {
  execFileSync(
    "npm",
    ["pack", "--workspace", name, "--pack-destination", tarballs, "--silent"],
    { cwd: root, stdio: "inherit" },
  )
}

const archives = readdirSync(tarballs).filter((file) => file.endsWith(".tgz"))
if (archives.length !== packages.length) {
  throw new Error(`expected ${packages.length} tarballs, found ${archives.length}`)
}

writeFileSync(
  join(work, "package.json"),
  `${JSON.stringify({ name: "tenon-dist-smoke", private: true, type: "module" }, null, 2)}\n`,
)

console.log("installing tarballs into a clean project")
execFileSync(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...archives.map((file) => join(tarballs, file)),
  ],
  { cwd: work, stdio: "inherit" },
)

writeFileSync(
  join(work, "smoke.mjs"),
  `import assert from "node:assert/strict"
import { EnvelopeSchema, verifyAuditChain } from "@tenon-protocol/core"
import { DocStore } from "@tenon-protocol/chart"
import { GraphStore } from "@tenon-protocol/graph"
import { MemoryTarget, loadFixtures, runSuite } from "@tenon-protocol/conformance"

const envelope = EnvelopeSchema.parse({
  v: 1,
  doc_id: "doc_smoke",
  turn_id: "turn_1",
  seq: 1,
  actor: { kind: "agent", id: "smoke" },
  capability: "cap_smoke",
  type: "chart.shape.create",
  target: { kind: "annotation" },
  payload: { op: "draw" },
  idempotency_key: "turn_1:1",
  created_at: "2026-10-25T10:00:00Z",
})
assert.equal(envelope.doc_id, "doc_smoke")
assert.equal(typeof verifyAuditChain, "function")

const store = new DocStore({ checkAnchor: () => ({ ok: true, warnings: [] }) })
store.beginTurn()
const drawn = store.applyOp({
  op: "draw",
  kind: "hline",
  points: [{ t: 1_700_000_000, p: 2400 }],
})
store.commitTurn()
assert.equal(drawn.ok, true)
assert.equal(store.annotations.length, 1)
store.undo()
assert.equal(store.annotations.length, 0)

const graph = new GraphStore()
assert.equal(graph.applyOp({ op: "node.create", id: "n1", label: "one", kind: "test" }).ok, true)
assert.equal(graph.nodes.length, 1)

const fixtures = loadFixtures()
assert.equal(fixtures.length, 6)
const results = await runSuite(new MemoryTarget(), fixtures)
assert.equal(results.filter((result) => !result.ok).length, 0, JSON.stringify(results.filter((result) => !result.ok), null, 2))

console.log("dist smoke: 5 packages imported, 6 conformance fixtures passed")
`,
)

execFileSync(process.execPath, ["smoke.mjs"], { cwd: work, stdio: "inherit" })

console.log("checking the MCP binary")
const server = spawn(
  process.execPath,
  [join(work, "node_modules/@tenon-protocol/mcp/dist/main.js")],
  {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TENON_URL: "http://127.0.0.1:9" },
  },
)

const response = await new Promise((resolvePromise, reject) => {
  let buffer = ""
  const timer = setTimeout(() => {
    server.kill()
    reject(new Error("MCP initialize timed out"))
  }, 5_000)

  server.stdout.on("data", (chunk) => {
    buffer += chunk.toString()
    for (const line of buffer.split("\n")) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        if (message.id === 1) {
          clearTimeout(timer)
          resolvePromise(message)
          return
        }
      } catch {
        // Partial line; wait for more data.
      }
    }
  })
  server.stderr.on("data", (chunk) => process.stderr.write(chunk))
  server.on("error", reject)

  server.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "dist-smoke", version: "1.0.0" },
      },
    })}\n`,
  )
})

server.kill()
if (response.error) throw new Error(`MCP initialize failed: ${JSON.stringify(response.error)}`)
if (response.result?.serverInfo?.name !== "tenon") {
  throw new Error(`unexpected MCP server name: ${JSON.stringify(response.result)}`)
}

console.log("dist smoke: MCP server initialized")
console.log(`artifacts kept at ${work}`)
