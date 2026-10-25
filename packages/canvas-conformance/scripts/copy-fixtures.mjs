import { cpSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("../../../spec/conformance/cases", import.meta.url))
const destination = fileURLToPath(new URL("../dist/fixtures", import.meta.url))

mkdirSync(destination, { recursive: true })
cpSync(source, destination, { recursive: true })

console.log(`copied conformance fixtures to ${destination}`)
