"use client"

import { useState } from "react"
import type { Kind } from "@amaterasu/chart-dsl"
import type { ChartController, LogEntry } from "@/components/chart/ChartController"

const PRESETS: Array<{ kind: Kind; label: string }> = [
  { kind: "trendline", label: "Trendline" },
  { kind: "rect", label: "Range box" },
  { kind: "hline", label: "Level" },
  { kind: "vline", label: "Now marker" },
  { kind: "label", label: "Callout" },
]

const buttonBase =
  "rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-[#c9d4e3] transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4c8dff]"

/**
 * Phase 0 verification surface: paste ops as JSON, apply them, and inspect the OpResult.
 * Everything here talks to the same reducer as the mouse and (later) the agent.
 */
export function OpConsole({ controller, log }: { controller: ChartController | null; log: LogEntry[] }) {
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)

  const apply = () => {
    setError(null)
    if (!controller) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (cause) {
      setError(`Invalid JSON: ${(cause as Error).message}`)
      return
    }
    const ops = Array.isArray(parsed) ? parsed : [parsed]
    for (const op of ops) controller.applyOp(op)
  }

  const insertPreset = (kind: Kind) => {
    setError(null)
    if (!controller) return
    setText(JSON.stringify(controller.exampleOp(kind), null, 2))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-white/10 px-3 py-2">
        <div className="mb-2 flex flex-wrap gap-1">
          {PRESETS.map((preset) => (
            <button key={preset.kind} type="button" className={buttonBase} onClick={() => insertPreset(preset.kind)}>
              {preset.label}
            </button>
          ))}
        </div>
        <label htmlFor="op-json" className="mb-1 block text-xs text-[#8b98a9]">
          Chart op JSON (single object or array)
        </label>
        <textarea
          id="op-json"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={7}
          placeholder={'{ "op": "draw", "kind": "hline", "points": [{ "t": ..., "p": ... }] }'}
          className="w-full resize-y rounded border border-white/15 bg-[#0d121a] p-2 font-mono text-[11px] leading-relaxed text-[#d7dee8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4c8dff]"
        />
        {error && (
          <p role="alert" className="mt-1 text-[11px] text-[#ef5350]">
            {error}
          </p>
        )}
        <div className="mt-2 flex gap-1">
          <button type="button" onClick={apply} disabled={!controller || text.trim() === ""} className={buttonBase + " disabled:cursor-not-allowed disabled:opacity-40"}>
            Apply op
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-live="polite" aria-label="Op results">
        {log.length === 0 ? (
          <p className="text-[11px] text-[#8b98a9]">No ops applied yet. Use a preset, or paste an op and apply it.</p>
        ) : (
          <ul className="space-y-2">
            {log.map((entry, index) => (
              <li key={`${entry.label}-${index}`} className="rounded border border-white/10 bg-white/5 p-2">
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-medium ${entry.result.ok ? "text-[#26a69a]" : "text-[#ef5350]"}`}>
                    {entry.result.ok ? "ok" : "failed"}
                  </span>
                  <span className="text-[11px] text-[#c9d4e3]">{entry.label}</span>
                  {entry.result.id && <span className="ml-auto text-[10px] text-[#8b98a9]">{entry.result.id.slice(0, 8)}</span>}
                </div>
                {(entry.result.warnings?.length ?? 0) > 0 && (
                  <p className="mt-1 text-[10px] text-[#f0b429]">{entry.result.warnings?.join("; ")}</p>
                )}
                {(entry.result.unresolved?.length ?? 0) > 0 && (
                  <p className="mt-1 text-[10px] text-[#ef5350]">unresolved: {entry.result.unresolved?.join("; ")}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
