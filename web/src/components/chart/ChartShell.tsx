"use client"

import { useEffect, useRef, useState } from "react"
import { ChartController, type ControllerSummary, type LogEntry, type Tool } from "./ChartController"
import { OpConsole } from "@/components/dev/OpConsole"

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: "select", label: "Select" },
  { id: "trendline", label: "Trend" },
  { id: "ray", label: "Ray" },
  { id: "hline", label: "H-Line" },
  { id: "vline", label: "V-Line" },
  { id: "rect", label: "Rect" },
  { id: "label", label: "Label" },
]

const buttonBase =
  "rounded border px-2 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4c8dff]"
const buttonIdle = "border-white/15 bg-white/5 text-[#c9d4e3] hover:bg-white/10"
const buttonActive = "border-[#f0b429]/70 bg-[#f0b429]/15 text-[#f0b429]"

export function ChartShell() {
  const hostRef = useRef<HTMLDivElement>(null)
  const annotationRef = useRef<HTMLCanvasElement>(null)
  const ephemeralRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)

  const [controller, setController] = useState<ChartController | null>(null)
  const [summary, setSummary] = useState<ControllerSummary | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  useEffect(() => {
    const host = hostRef.current
    const annotationCanvas = annotationRef.current
    const ephemeralCanvas = ephemeralRef.current
    const labelsHost = labelsRef.current
    if (!host || !annotationCanvas || !ephemeralCanvas || !labelsHost) return

    let instance: ChartController
    instance = new ChartController(
      { host, annotationCanvas, ephemeralCanvas, labelsHost },
      {
        listeners: {
          onChange: () => setSummary(instance.summary),
          onLog: (entry) => setLog((prev) => [entry, ...prev].slice(0, 100)),
        },
      },
    )
    setController(instance)
    setSummary(instance.summary)
    if (process.env.NODE_ENV !== "production") {
      ;(window as unknown as { __amaterasu?: ChartController }).__amaterasu = instance
    }
    return () => {
      instance.dispose()
      if (process.env.NODE_ENV !== "production") {
        delete (window as unknown as { __amaterasu?: ChartController }).__amaterasu
      }
      setController(null)
    }
  }, [])

  return (
    <div className="flex h-dvh flex-col bg-[#0b0f14] text-[#d7dee8]">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
        <h1 className="text-sm font-semibold tracking-wide">Amaterasu</h1>
        <span className="text-xs text-[#8b98a9]">RELIANCE · 1D · mock data (Phase 0)</span>
        <span className="ml-auto text-xs text-[#8b98a9]" aria-live="polite">
          {summary ? `${summary.count} annotation${summary.count === 1 ? "" : "s"}` : "…"}
        </span>
      </header>

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section aria-label="Chart" className="relative min-h-[320px] flex-1">
          <div ref={hostRef} className="absolute inset-0" />
          <canvas ref={annotationRef} className="pointer-events-none absolute left-0 top-0 z-10" aria-hidden="true" />
          <canvas ref={ephemeralRef} className="pointer-events-none absolute left-0 top-0 z-20" aria-hidden="true" />
          <div ref={labelsRef} className="pointer-events-none absolute left-0 top-0 z-30 overflow-hidden" />
          <p className="pointer-events-none absolute left-2 top-1 z-50 text-[10px] text-[#8b98a9]/70">
            drag to pan · wheel to zoom · drag shapes to move · Delete removes · Esc cancels
          </p>
        </section>

        <aside className="flex min-h-0 w-full flex-col border-t border-white/10 lg:w-[380px] lg:border-l lg:border-t-0">
          <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-3 py-2" role="toolbar" aria-label="Drawing tools">
            {TOOLS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                aria-pressed={summary?.tool === tool.id}
                onClick={() => controller?.setTool(tool.id)}
                className={`${buttonBase} ${summary?.tool === tool.id ? buttonActive : buttonIdle}`}
              >
                {tool.label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-white/10" aria-hidden="true" />
            <button
              type="button"
              onClick={() => controller?.undo()}
              disabled={!summary?.canUndo}
              className={`${buttonBase} ${buttonIdle} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => controller?.redo()}
              disabled={!summary?.canRedo}
              className={`${buttonBase} ${buttonIdle} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Redo
            </button>
            <button
              type="button"
              onClick={() => controller?.clearAll()}
              disabled={!summary || summary.count === 0}
              className={`${buttonBase} ${buttonIdle} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              Clear all
            </button>
          </div>
          <OpConsole controller={controller} log={log} />
        </aside>
      </main>
    </div>
  )
}
