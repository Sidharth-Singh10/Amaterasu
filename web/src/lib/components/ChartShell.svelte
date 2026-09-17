<script lang="ts">
  import { onMount } from "svelte"
  import { dev } from "$app/environment"
  import { ChartController, type ControllerSummary, type LogEntry, type Tool } from "@/lib/chart/ChartController"
  import OpConsole from "@/lib/components/OpConsole.svelte"

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

  let hostEl: HTMLDivElement
  let annotationEl: HTMLCanvasElement
  let ephemeralEl: HTMLCanvasElement
  let labelsEl: HTMLDivElement

  let controller = $state<ChartController | null>(null)
  let summary = $state<ControllerSummary | null>(null)
  let log = $state<LogEntry[]>([])

  onMount(() => {
    const instance = new ChartController(
      { host: hostEl, annotationCanvas: annotationEl, ephemeralCanvas: ephemeralEl, labelsHost: labelsEl },
      {
        listeners: {
          onChange: () => {
            summary = instance.summary
          },
          onLog: (entry) => {
            log = [entry, ...log].slice(0, 100)
          },
        },
      },
    )
    controller = instance
    summary = instance.summary
    if (dev) {
      ;(window as unknown as { __amaterasu?: ChartController }).__amaterasu = instance
    }
    return () => {
      instance.dispose()
      if (dev) {
        delete (window as unknown as { __amaterasu?: ChartController }).__amaterasu
      }
      controller = null
    }
  })
</script>

<div class="flex h-dvh flex-col bg-[#0b0f14] text-[#d7dee8]">
  <header class="flex items-center gap-3 border-b border-white/10 px-4 py-2">
    <h1 class="text-sm font-semibold tracking-wide">Amaterasu</h1>
    <span class="text-xs text-[#8b98a9]">RELIANCE · 1D · mock data (Phase 0)</span>
    <span class="ml-auto text-xs text-[#8b98a9]" aria-live="polite">
      {summary ? `${summary.count} annotation${summary.count === 1 ? "" : "s"}` : "…"}
    </span>
  </header>

  <main class="flex min-h-0 flex-1 flex-col lg:flex-row">
    <section aria-label="Chart" class="relative min-h-[320px] flex-1">
      <div bind:this={hostEl} class="absolute inset-0"></div>
      <canvas bind:this={annotationEl} class="pointer-events-none absolute left-0 top-0 z-10" aria-hidden="true"
      ></canvas>
      <canvas bind:this={ephemeralEl} class="pointer-events-none absolute left-0 top-0 z-20" aria-hidden="true"
      ></canvas>
      <div bind:this={labelsEl} class="pointer-events-none absolute left-0 top-0 z-30 overflow-hidden"></div>
      <p class="pointer-events-none absolute left-2 top-1 z-50 text-[10px] text-[#8b98a9]/70">
        drag to pan · wheel to zoom · drag shapes to move · Delete removes · Esc cancels
      </p>
    </section>

    <aside class="flex min-h-0 w-full flex-col border-t border-white/10 lg:w-[380px] lg:border-l lg:border-t-0">
      <div
        class="flex flex-wrap items-center gap-1 border-b border-white/10 px-3 py-2"
        role="toolbar"
        aria-label="Drawing tools"
      >
        {#each TOOLS as tool (tool.id)}
          <button
            type="button"
            aria-pressed={summary?.tool === tool.id}
            onclick={() => controller?.setTool(tool.id)}
            class="{buttonBase} {summary?.tool === tool.id ? buttonActive : buttonIdle}"
          >
            {tool.label}
          </button>
        {/each}
        <span class="mx-1 h-4 w-px bg-white/10" aria-hidden="true"></span>
        <button
          type="button"
          onclick={() => controller?.undo()}
          disabled={!summary?.canUndo}
          class="{buttonBase} {buttonIdle} disabled:cursor-not-allowed disabled:opacity-40">Undo</button
        >
        <button
          type="button"
          onclick={() => controller?.redo()}
          disabled={!summary?.canRedo}
          class="{buttonBase} {buttonIdle} disabled:cursor-not-allowed disabled:opacity-40">Redo</button
        >
        <button
          type="button"
          onclick={() => controller?.clearAll()}
          disabled={!summary || summary.count === 0}
          class="{buttonBase} {buttonIdle} disabled:cursor-not-allowed disabled:opacity-40">Clear all</button
        >
      </div>
      <OpConsole {controller} {log} />
    </aside>
  </main>
</div>
