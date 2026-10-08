<script lang="ts">
  import type { Kind } from "@amaterasu/chart-dsl"
  import type { ChartController, LogEntry } from "@/lib/chart/ChartController"

  let { controller = null, log = [] }: { controller?: ChartController | null; log?: LogEntry[] } = $props()

  const PRESETS: Array<{ kind: Kind; label: string }> = [
    { kind: "trendline", label: "Trendline" },
    { kind: "rect", label: "Range box" },
    { kind: "hzone", label: "Zone" },
    { kind: "hline", label: "Level" },
    { kind: "marker", label: "Marker" },
    { kind: "measure", label: "Measure" },
    { kind: "fib", label: "Fib" },
    { kind: "channel", label: "Channel" },
    { kind: "label", label: "Callout" },
  ]

  let text = $state("")
  let error = $state<string | null>(null)

  function apply(): void {
    error = null
    if (!controller) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (cause) {
      error = `Invalid JSON: ${(cause as Error).message}`
      return
    }
    const ops = Array.isArray(parsed) ? parsed : [parsed]
    for (const op of ops) controller.applyOp(op)
  }

  function insertPreset(kind: Kind): void {
    error = null
    if (!controller) return
    const op = controller.exampleOp(kind)
    if (!op) {
      error = "Load chart data before using presets."
      return
    }
    text = JSON.stringify(op, null, 2)
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="border-b border-line-1 px-3 py-2.5">
    <p class="mb-1.5 text-[10px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Presets</p>
    <div class="mb-3 flex flex-wrap gap-1">
      {#each PRESETS as preset (preset.kind)}
        <button type="button" class="chip" onclick={() => insertPreset(preset.kind)}>{preset.label}</button>
      {/each}
    </div>
    <label for="op-json" class="mb-1 block text-[10px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Op JSON</label>
    <textarea
      id="op-json"
      bind:value={text}
      spellcheck="false"
      rows={7}
      placeholder={'{ "op": "draw", "kind": "hline", "points": [{ "t": ..., "p": ... }] }'}
      class="input w-full resize-y font-mono text-[11px] leading-relaxed"
    ></textarea>
    {#if error}
      <p role="alert" class="mt-1.5 text-[11px] text-down">{error}</p>
    {/if}
    <div class="mt-2">
      <button type="button" class="btn btn-primary" onclick={apply} disabled={!controller || text.trim() === ""}>
        Apply op
      </button>
    </div>
  </div>

  <div class="scroll-area min-h-0 flex-1 overflow-y-auto px-3 py-2.5" aria-live="polite" aria-label="Op results">
    {#if log.length === 0}
      <p class="text-[11px] leading-relaxed text-ink-3">
        Nothing applied yet. Pick a preset to load a valid op built from the loaded bars, then apply it.
      </p>
    {:else}
      <ul class="space-y-1.5">
        {#each log as entry, index (entry.label + "-" + index)}
          <li class="rounded-md bg-surface-2/70 px-2.5 py-1.5">
            <div class="flex items-center gap-2">
              <span class="h-1.5 w-1.5 shrink-0 rounded-full {entry.result.ok ? 'bg-up' : 'bg-down'}" aria-hidden="true"
              ></span>
              <span class="text-[11px] font-medium {entry.result.ok ? 'text-ink-2' : 'text-down'}"
                >{entry.result.ok ? "ok" : "failed"}</span
              >
              <span class="truncate text-[11px] text-ink-2">{entry.label}</span>
              {#if entry.result.id}
                <span class="ml-auto shrink-0 font-mono text-[10px] text-ink-3">{entry.result.id.slice(0, 8)}</span>
              {/if}
            </div>
            {#if (entry.result.warnings?.length ?? 0) > 0}
              <p class="mt-1 text-[10px] leading-relaxed text-select">{entry.result.warnings?.join("; ")}</p>
            {/if}
            {#if (entry.result.unresolved?.length ?? 0) > 0}
              <p class="mt-1 text-[10px] leading-relaxed text-down">unresolved: {entry.result.unresolved?.join("; ")}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
