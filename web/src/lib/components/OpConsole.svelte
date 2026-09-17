<script lang="ts">
  import type { Kind } from "@amaterasu/chart-dsl"
  import type { ChartController, LogEntry } from "@/lib/chart/ChartController"

  let { controller = null, log = [] }: { controller?: ChartController | null; log?: LogEntry[] } = $props()

  const PRESETS: Array<{ kind: Kind; label: string }> = [
    { kind: "trendline", label: "Trendline" },
    { kind: "rect", label: "Range box" },
    { kind: "hline", label: "Level" },
    { kind: "vline", label: "Now marker" },
    { kind: "label", label: "Callout" },
  ]

  const buttonBase =
    "rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-[#c9d4e3] transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4c8dff]"

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
    text = JSON.stringify(controller.exampleOp(kind), null, 2)
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="border-b border-white/10 px-3 py-2">
    <div class="mb-2 flex flex-wrap gap-1">
      {#each PRESETS as preset (preset.kind)}
        <button type="button" class={buttonBase} onclick={() => insertPreset(preset.kind)}>{preset.label}</button>
      {/each}
    </div>
    <label for="op-json" class="mb-1 block text-xs text-[#8b98a9]">Chart op JSON (single object or array)</label>
    <textarea
      id="op-json"
      bind:value={text}
      spellcheck="false"
      rows={7}
      placeholder={'{ "op": "draw", "kind": "hline", "points": [{ "t": ..., "p": ... }] }'}
      class="w-full resize-y rounded border border-white/15 bg-[#0d121a] p-2 font-mono text-[11px] leading-relaxed text-[#d7dee8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4c8dff]"
    ></textarea>
    {#if error}
      <p role="alert" class="mt-1 text-[11px] text-[#ef5350]">{error}</p>
    {/if}
    <div class="mt-2 flex gap-1">
      <button
        type="button"
        onclick={apply}
        disabled={!controller || text.trim() === ""}
        class="{buttonBase} disabled:cursor-not-allowed disabled:opacity-40">Apply op</button
      >
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-live="polite" aria-label="Op results">
    {#if log.length === 0}
      <p class="text-[11px] text-[#8b98a9]">No ops applied yet. Use a preset, or paste an op and apply it.</p>
    {:else}
      <ul class="space-y-2">
        {#each log as entry, index (entry.label + "-" + index)}
          <li class="rounded border border-white/10 bg-white/5 p-2">
            <div class="flex items-center gap-2">
              <span class="text-[11px] font-medium {entry.result.ok ? 'text-[#26a69a]' : 'text-[#ef5350]'}">
                {entry.result.ok ? "ok" : "failed"}
              </span>
              <span class="text-[11px] text-[#c9d4e3]">{entry.label}</span>
              {#if entry.result.id}
                <span class="ml-auto text-[10px] text-[#8b98a9]">{entry.result.id.slice(0, 8)}</span>
              {/if}
            </div>
            {#if (entry.result.warnings?.length ?? 0) > 0}
              <p class="mt-1 text-[10px] text-[#f0b429]">{entry.result.warnings?.join("; ")}</p>
            {/if}
            {#if (entry.result.unresolved?.length ?? 0) > 0}
              <p class="mt-1 text-[10px] text-[#ef5350]">unresolved: {entry.result.unresolved?.join("; ")}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
