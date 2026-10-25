import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const siteDir = resolve(root, "site")
const siteOut = resolve(root, "_site")
const webBuild = resolve(root, "web/build")

const rawBase = process.env.SITE_BASE ?? ""
const base = rawBase === "" ? "" : `/${rawBase.replace(/^\/+|\/+$/g, "")}`
const demoBase = `${base}/demo`

if (!existsSync(siteDir)) throw new Error(`missing ${siteDir}`)

console.log(`building the SPA with base ${demoBase || "/demo"}`)
execFileSync("npm", ["run", "build", "--workspace", "@amaterasu/web"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PUBLIC_BASE_PATH: demoBase },
})

rmSync(siteOut, { recursive: true, force: true })
mkdirSync(siteOut, { recursive: true })
cpSync(siteDir, siteOut, { recursive: true })

const demoOut = resolve(siteOut, "demo")
mkdirSync(demoOut, { recursive: true })
cpSync(webBuild, demoOut, { recursive: true })

// GitHub Pages runs Jekyll unless this file is present.
writeFileSync(resolve(siteOut, ".nojekyll"), "")

if (process.env.SITE_CNAME) {
  writeFileSync(resolve(siteOut, "CNAME"), `${process.env.SITE_CNAME}\n`)
}

console.log(`wrote ${siteOut}`)
console.log(`landing: ${base || ""}/`)
console.log(`demo:    ${demoBase}/?demo=1`)
