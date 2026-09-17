import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"

/**
 * Phase 0 end-to-end check. Requires the web app to be running:
 *   npm run dev --workspace @amaterasu/web      (or the Rust service serving `web/out`)
 *
 * Env:
 *   AMATERASU_URL  base URL (default http://127.0.0.1:3000)
 *   CHROME_PATH    explicit Chromium/Chrome executable
 *
 * Exits non-zero when any check fails.
 */

const BASE_URL = process.env.AMATERASU_URL ?? "http://127.0.0.1:3000"

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const roots = [
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      const candidates = [
        join(root, dir, "chrome-linux64", "chrome"),
        join(root, dir, "chrome-linux", "chrome"),
        join(root, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ]
      for (const candidate of candidates) if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const executablePath = findChromium()
if (!executablePath) {
  console.error(
    "No Chromium found. Install one with `npx playwright install chromium` or set CHROME_PATH.",
  )
  process.exit(2)
}

const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("404")) consoleErrors.push(m.text())
})
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.goto(`${BASE_URL}/?demo=1`, { waitUntil: "domcontentloaded" })
await page.waitForFunction(() => !!window.__amaterasu, null, { timeout: 20000 })
await page.waitForTimeout(500)

const probe = () =>
  page.evaluate(() => {
    const scan = (c) => {
      const ctx = c.getContext("2d")
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let painted = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++
      return painted
    }
    const canvases = [...document.querySelectorAll('section[aria-label="Chart"] > canvas')]
    const ctl = window.__amaterasu
    const snap = ctl.getSnapshot()
    const line = snap.annotations.find((a) => a.kind === "trendline") ?? null
    return {
      painted: canvases[0] ? scan(canvases[0]) : -1,
      annotations: snap.annotations.length,
      range: snap.visible?.logicalRange ?? null,
      linePoints: line?.points ?? null,
      linePixels: line ? ctl.pixelsOf(line.id) : null,
    }
  })

const chart = page.locator('section[aria-label="Chart"]')
const box = await chart.boundingBox()
const steps = {}
const has = (v) => v !== null && v !== undefined

steps.load = await probe()

await page.getByRole("button", { name: "Level", exact: true }).click()
await page.getByRole("button", { name: "Apply op" }).click()
await page.waitForTimeout(400)
steps.presetDraw = await probe()

await page.getByRole("button", { name: "Undo" }).click()
await page.waitForTimeout(250)
steps.undo = await probe()
await page.getByRole("button", { name: "Redo" }).click()
await page.waitForTimeout(250)
steps.redo = await probe()

await page.getByRole("button", { name: "Trend", exact: true }).click()
await page.mouse.click(box.x + 300, box.y + 420)
await page.mouse.click(box.x + 700, box.y + 260)
await page.waitForTimeout(300)
steps.mouseDraw = await probe()

await page.mouse.move(box.x + 900, box.y + 650)
await page.mouse.down()
await page.mouse.move(box.x + 600, box.y + 650, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(300)
steps.pan = await probe()

await page.mouse.move(box.x + 500, box.y + 400)
await page.mouse.wheel(0, -500)
await page.waitForTimeout(300)
steps.zoom = await probe()

const mid = {
  x: (steps.zoom.linePixels[0].x + steps.zoom.linePixels[1].x) / 2,
  y: (steps.zoom.linePixels[0].y + steps.zoom.linePixels[1].y) / 2,
}
await page.mouse.move(box.x + mid.x, box.y + mid.y)
await page.mouse.down()
await page.mouse.move(box.x + mid.x, box.y + mid.y - 60, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(300)
steps.drag = await probe()

await page.locator("#op-json").fill('{"op":"draw","kind":"hline","points":[{"t":1,"p":1}]}')
await page.getByRole("button", { name: "Apply op" }).click()
await page.waitForTimeout(300)
steps.invalidOp = await probe()
const failureCardVisible = await page.locator("li", { hasText: "failed" }).count()

// Computed series: plot a deterministic line built from the last three bars.
const seriesOp = await page.evaluate(() => {
  const bars = window.__amaterasu.getSnapshot().bars.slice(-3)
  return {
    op: "add_series",
    id: "e2e-line",
    name: "E2E line",
    points: bars.map((bar) => ({ t: bar.time, v: bar.close })),
  }
})
await page.locator("#op-json").fill(JSON.stringify(seriesOp))
await page.getByRole("button", { name: "Apply op" }).click()
await page.waitForTimeout(400)
const series = await page.evaluate(() => window.__amaterasu.getSnapshot().series)

await browser.close()

const checks = {
  loadsClean: steps.load.painted === 0 && steps.load.annotations === 0 && has(steps.load.range),
  presetDraws: steps.presetDraw.annotations === 1 && steps.presetDraw.painted > 0,
  undoRemoves: steps.undo.annotations === 0 && steps.undo.painted === 0,
  redoRestores: steps.redo.annotations === 1 && steps.redo.painted === steps.presetDraw.painted,
  mouseDraws: steps.mouseDraw.annotations === 2 && steps.mouseDraw.painted > steps.presetDraw.painted,
  panChangesRange:
    steps.pan.range.from !== steps.zoom.range.from || steps.pan.range.to !== steps.zoom.range.to,
  panKeepsOverlays: steps.pan.painted > 0,
  zoomNarrowsSpan: steps.zoom.range.to - steps.zoom.range.from < steps.pan.range.to - steps.pan.range.from,
  zoomKeepsOverlays: steps.zoom.painted > 0,
  dragMovesAnnotation:
    JSON.stringify(steps.drag.linePoints) !== JSON.stringify(steps.zoom.linePoints) &&
    Math.abs(steps.drag.linePixels[0].y - (steps.zoom.linePixels[0].y - 60)) < 0.01,
  dragDoesNotPan: steps.drag.range.from === steps.zoom.range.from,
  invalidOpUnchanged: steps.invalidOp.annotations === 2 && failureCardVisible >= 1,
  seriesPlots: series.length === 1 && series[0].id === "e2e-line" && series[0].points === 3,
  noConsoleErrors: consoleErrors.length === 0,
}

const allPassed = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ checks, consoleErrors, allPassed }, null, 2))

if (!allPassed) {
  console.error("E2E checks failed")
  process.exit(1)
}
console.log("E2E checks passed")
