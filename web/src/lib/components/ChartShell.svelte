<script lang="ts">
  import { onMount } from "svelte"
  import { dev } from "$app/environment"
  import { ChartController, type ControllerSummary, type LogEntry, type Tool } from "@/lib/chart/ChartController"
  import OpConsole from "@/lib/components/OpConsole.svelte"
  import { ApiError, api, type Quote, type SearchResult } from "@/lib/api/client"
  import { INTERVALS, intervalOption } from "@/lib/api/intervals"
  import { demoCandles } from "@/lib/data/mock"

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
  const buttonIdle = "border-white/15 bg-white/5 text-[#c9d4e3] hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
  const buttonActive = "border-[#f0b429]/70 bg-[#f0b429]/15 text-[#f0b429]"

  const STATE_KEY = "amaterasu.state"

  let hostEl: HTMLDivElement
  let annotationEl: HTMLCanvasElement
  let ephemeralEl: HTMLCanvasElement
  let labelsEl: HTMLDivElement

  let controller = $state<ChartController | null>(null)
  let summary = $state<ControllerSummary | null>(null)
  let log = $state<LogEntry[]>([])

  let mode = $state<"live" | "demo">("live")
  let symbol = $state<SearchResult | null>(null)
  let interval = $state("1day")
  let quote = $state<Quote | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  let needsConnection = $state(false)
  let lastUpdated = $state<number | null>(null)
  let autoRefresh = $state(true)
  let query = $state("")
  let results = $state<SearchResult[]>([])
  let searchOpen = $state(false)

  let refreshTimer: number | undefined
  let searchTimer: number | undefined

  const intervalOptions = INTERVALS

  function snapshotMeta() {
    return {
      symbol: mode === "demo" ? "RELIANCE (mock)" : (symbol?.name ?? "unknown"),
      interval,
    }
  }

  onMount(() => {
    const instance = new ChartController(
      { host: hostEl, annotationCanvas: annotationEl, ephemeralCanvas: ephemeralEl, labelsHost: labelsEl },
      {
        candles: [],
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
    if (dev) {
      ;(window as unknown as { __amaterasu?: ChartController }).__amaterasu = instance
    }

    mode = new URLSearchParams(window.location.search).get("demo") === "1" ? "demo" : "live"
    if (mode === "demo") {
      instance.applyCandles(demoCandles())
      lastUpdated = Math.floor(Date.now() / 1000)
      loading = false
    } else {
      void bootstrap()
    }

    window.addEventListener("beforeunload", saveState)
    return () => {
      window.removeEventListener("beforeunload", saveState)
      window.clearInterval(refreshTimer)
      window.clearTimeout(searchTimer)
      instance.dispose()
      if (dev) delete (window as unknown as { __amaterasu?: ChartController }).__amaterasu
      controller = null
    }
  })

  async function bootstrap(): Promise<void> {
    try {
      const status = await api.status()
      needsConnection = !status.connected
    } catch (cause) {
      handleError(cause)
    }
    const restored = readState()
    if (restored) {
      symbol = restored.symbol
      interval = restored.interval
    } else {
      symbol = await resolveDefaultSymbol()
    }
    await loadCandles({ preserveView: false, applyStoredView: true })
    startAutoRefresh()
  }

  async function resolveDefaultSymbol(): Promise<SearchResult | null> {
    try {
      const response = await api.search("RELIANCE")
      return response.results[0] ?? null
    } catch (cause) {
      handleError(cause)
      return null
    }
  }

  async function loadCandles(opts: { preserveView: boolean; applyStoredView?: boolean }): Promise<void> {
    if (!symbol || !controller) {
      loading = false
      return
    }
    loading = true
    try {
      const option = intervalOption(interval)
      const response = await api.candles(symbol.indKey, interval, option.lookback)
      controller.applyCandles(response.candles, { preserveView: opts.preserveView })
      if (opts.applyStoredView) {
        const view = readState()?.view
        if (view) controller.setViewport(view)
      }
      lastUpdated = response.fetchedAt
      error = null
      needsConnection = false
      void loadQuote()
      saveState()
    } catch (cause) {
      handleError(cause)
    } finally {
      loading = false
    }
  }

  async function loadQuote(): Promise<void> {
    if (!symbol) return
    try {
      quote = await api.quote(symbol.indKey)
    } catch (cause) {
      if (cause instanceof ApiError && cause.needsConnection) needsConnection = true
      // Quotes are decorative; other failures stay silent.
    }
  }

  function handleError(cause: unknown): void {
    if (cause instanceof ApiError) {
      if (cause.needsConnection) {
        needsConnection = true
        error = null
      } else {
        error = `${cause.code}: ${cause.message}`
      }
    } else {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function startAutoRefresh(): void {
    window.clearInterval(refreshTimer)
    refreshTimer = window.setInterval(() => {
      if (!autoRefresh || mode !== "live" || document.visibilityState !== "visible") return
      void loadCandles({ preserveView: true })
    }, intervalOption(interval).refreshMs)
  }

  function refreshNow(): void {
    void loadCandles({ preserveView: true })
  }

  function selectInterval(value: string): void {
    if (value === interval || mode === "demo") return
    interval = value
    void loadCandles({ preserveView: false })
    startAutoRefresh()
  }

  async function selectSymbol(result: SearchResult): Promise<void> {
    if (mode === "demo") return
    symbol = result
    quote = null
    searchOpen = false
    query = ""
    results = []
    await loadCandles({ preserveView: false })
  }

  function onQueryInput(value: string): void {
    query = value
    window.clearTimeout(searchTimer)
    const term = value.trim()
    if (term.length < 2) {
      results = []
      searchOpen = false
      return
    }
    searchTimer = window.setTimeout(async () => {
      try {
        const response = await api.search(term)
        results = response.results
        searchOpen = results.length > 0
      } catch (cause) {
        handleError(cause)
      }
    }, 250)
  }

  function saveState(): void {
    if (mode !== "live" || !symbol) return
    const view = controller?.getViewport() ?? null
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ symbol, interval, view }))
    } catch {
      // Storage unavailable (private mode); persistence is best-effort.
    }
  }

  function readState(): { symbol: SearchResult; interval: string; view: { from: number; to: number } | null } | null {
    try {
      const raw = localStorage.getItem(STATE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as {
        symbol?: SearchResult
        interval?: string
        view?: { from: number; to: number } | null
      }
      if (!parsed.symbol?.indKey) return null
      return {
        symbol: parsed.symbol,
        interval: intervalOption(parsed.interval ?? "1day").value,
        view: parsed.view ?? null,
      }
    } catch {
      return null
    }
  }

  function formatPrice(value?: number | null): string {
    return value == null ? "—" : value.toFixed(2)
  }

  function formatChange(value?: number | null, pct?: number | null): string {
    if (value == null || pct == null) return ""
    const sign = value >= 0 ? "+" : ""
    return `${sign}${value.toFixed(2)} (${sign}${pct.toFixed(2)}%)`
  }

  function formatUpdated(epoch?: number | null): string {
    if (!epoch) return "—"
    return new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  }
</script>

<div class="flex h-dvh flex-col bg-[#0b0f14] text-[#d7dee8]">
  <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/10 px-4 py-2">
    <h1 class="text-sm font-semibold tracking-wide">Amaterasu</h1>

    {#if mode === "demo"}
      <span class="text-xs text-[#8b98a9]">RELIANCE · mock data (demo)</span>
    {:else}
      <div class="relative">
        <input
          type="search"
          aria-label="Search symbols"
          placeholder="Search symbol…"
          value={query}
          oninput={(event) => onQueryInput((event.currentTarget as HTMLInputElement).value)}
          onfocus={() => (searchOpen = results.length > 0)}
          class="w-44 rounded border border-white/15 bg-[#0d121a] px-2 py-1 text-xs text-[#d7dee8] placeholder:text-[#5c6a7d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4c8dff]"
        />
        {#if searchOpen}
          <ul
            class="absolute left-0 top-8 z-50 max-h-64 w-72 overflow-y-auto rounded border border-white/15 bg-[#0d121a] py-1 shadow-lg"
            aria-label="Search results"
          >
            {#each results as result (result.indKey)}
              <li>
                <button
                  type="button"
                  onclick={() => selectSymbol(result)}
                  class="block w-full px-3 py-1.5 text-left text-xs text-[#c9d4e3] hover:bg-white/10"
                >
                  {result.name}
                  <span class="ml-1 text-[10px] text-[#5c6a7d]">{result.indKey}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if quote}
        <span class="text-xs text-[#8b98a9]">
          <span class="font-medium text-[#d7dee8]">{formatPrice(quote.ltp)}</span>
          <span class={quote.change != null && quote.change < 0 ? "text-[#ef5350]" : "text-[#26a69a]"}>
            {formatChange(quote.change, quote.changePct)}
          </span>
        </span>
      {/if}
    {/if}

    <div class="flex items-center gap-1" role="group" aria-label="Interval">
      {#each intervalOptions as option (option.value)}
        <button
          type="button"
          aria-pressed={interval === option.value}
          disabled={mode === "demo"}
          onclick={() => selectInterval(option.value)}
          class="{buttonBase} {interval === option.value ? buttonActive : buttonIdle}"
        >
          {option.label}
        </button>
      {/each}
    </div>

    <div class="ml-auto flex items-center gap-2 text-xs text-[#8b98a9]">
      {#if loading}<span aria-live="polite">updating…</span>{/if}
      <span>updated {formatUpdated(lastUpdated)}</span>
      {#if mode === "live"}
        <label class="flex cursor-pointer items-center gap-1">
          <input type="checkbox" bind:checked={autoRefresh} class="accent-[#4c8dff]" />
          auto
        </label>
        <button type="button" class={buttonBase + " " + buttonIdle} onclick={refreshNow}>Refresh</button>
      {/if}
      <span
        class="rounded px-1.5 py-0.5 text-[10px] {mode === "demo" ? "bg-white/10 text-[#8b98a9]" : "bg-[#26a69a]/20 text-[#26a69a]"}">{mode}</span>
      <span aria-live="polite">{summary ? `${summary.count} annotation${summary.count === 1 ? "" : "s"}` : "…"}</span>
    </div>
  </header>

  {#if needsConnection}
    <div class="flex items-center gap-2 border-b border-[#f0b429]/40 bg-[#f0b429]/10 px-4 py-1.5 text-xs text-[#f0b429]">
      <span>INDmoney is not connected — chart data is unavailable.</span>
      <a class="underline underline-offset-2 hover:text-[#ffd977]" href="/api/indmoney/connect">Connect INDmoney</a>
    </div>
  {/if}
  {#if error}
    <div class="border-b border-[#ef5350]/40 bg-[#ef5350]/10 px-4 py-1.5 text-xs text-[#ef5350]" role="alert">{error}</div>
  {/if}

  <main class="flex min-h-0 flex-1 flex-col lg:flex-row">
    <section aria-label="Chart" class="relative min-h-[320px] flex-1" aria-busy={loading}>
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
          class="{buttonBase} {buttonIdle}">Undo</button
        >
        <button
          type="button"
          onclick={() => controller?.redo()}
          disabled={!summary?.canRedo}
          class="{buttonBase} {buttonIdle}">Redo</button
        >
        <button
          type="button"
          onclick={() => controller?.clearAll()}
          disabled={!summary || summary.count === 0}
          class="{buttonBase} {buttonIdle}">Clear all</button
        >
      </div>
      <OpConsole {controller} {log} />
    </aside>
  </main>
</div>
