<script lang="ts">
  import { onMount } from "svelte"
  import { dev } from "$app/environment"
  import { ChartController, type ControllerSummary, type LogEntry, type Tool } from "@/lib/chart/ChartController"
  import OpConsole from "@/lib/components/OpConsole.svelte"
  import ChatPanel from "@/lib/components/ChatPanel.svelte"
  import Icon from "@/lib/components/Icon.svelte"
  import type { IconName } from "@/lib/components/icons"
  import { startChartBridge } from "@/lib/chart/bridge-wiring"
import { bridge } from "@/lib/api/bridge"
  import { ApiError, api, type Quote, type SearchResult } from "@/lib/api/client"
  import { INTERVALS, intervalOption } from "@/lib/api/intervals"
  import { demoCandles } from "@/lib/data/mock"

  const TOOLS: Array<{ id: Tool; label: string; icon: IconName }> = [
    { id: "select", label: "Select", icon: "select" },
    { id: "trendline", label: "Trend", icon: "trendline" },
    { id: "ray", label: "Ray", icon: "ray" },
    { id: "hline", label: "H-Line", icon: "hline" },
    { id: "vline", label: "V-Line", icon: "vline" },
    { id: "rect", label: "Rect", icon: "rect" },
    { id: "label", label: "Label", icon: "label" },
  ]

  const STATE_KEY = "amaterasu.state"

  let hostEl: HTMLDivElement
  let annotationEl: HTMLCanvasElement
  let ephemeralEl: HTMLCanvasElement
  let labelsEl: HTMLDivElement
  let searchEl = $state<HTMLInputElement | null>(null)

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
  let searching = $state(false)
  let tab = $state<"agent" | "console">("console")
  let bridgeError = $state<string | null>(null)
  let chartId = ""
  let chartBridge: ReturnType<typeof startChartBridge> | null = null

  let refreshTimer: number | undefined
  let searchTimer: number | undefined
  let docTimer: number | undefined
  let docSaveSuspended = false
  const EMPTY_DOC = { v: 1 as const, annotations: [], series: [] }

  const intervalOptions = INTERVALS

  /** First paint before any candles arrive — the chart gets a composed skeleton. */
  let initialLoading = $derived(mode === "live" && loading && lastUpdated === null)
  let quoteDelta = $derived(quote?.change != null && quote.change < 0 ? "text-down" : "text-up")

  $effect(() => {
    if (!controller) return
    controller.setSymbolMeta({
      symbol: mode === "demo" ? "RELIANCE (mock)" : (symbol?.name ?? "loading…"),
      interval,
    })
  })

  onMount(() => {
    const instance = new ChartController(
      { host: hostEl, annotationCanvas: annotationEl, ephemeralCanvas: ephemeralEl, labelsHost: labelsEl },
      {
        candles: [],
        listeners: {
          onChange: () => {
            summary = instance.summary
            scheduleDocSave()
          },
          onLog: (entry) => {
            log = [entry, ...log].slice(0, 100)
          },
          onViewportChange: () => chartBridge?.scheduleSync(),
        },
      },
    )
    controller = instance
    // Seed the summary so the active-tool and undo/redo states render before
    // the first document change.
    summary = instance.summary
    if (dev) {
      ;(window as unknown as { __amaterasu?: ChartController }).__amaterasu = instance
    }

    mode = new URLSearchParams(window.location.search).get("demo") === "1" ? "demo" : "live"
    if (mode === "demo") {
      const bars = demoCandles()
      instance.applyCandles(bars)
      const last = bars[bars.length - 1]
      const previous = bars[bars.length - 2] ?? last
      const change = last.close - previous.close
      quote = {
        indKey: "DEMO",
        name: "RELIANCE (mock)",
        ltp: last.close,
        change,
        changePct: previous.close !== 0 ? (change / previous.close) * 100 : 0,
      }
      lastUpdated = Math.floor(Date.now() / 1000)
      loading = false
    } else {
      void bootstrap()
    }

    chartId = sessionStorage.getItem("amaterasu.chartId") ?? crypto.randomUUID()
    sessionStorage.setItem("amaterasu.chartId", chartId)
    if (mode === "live") {
      bridge.startStream()
    }
    chartBridge = startChartBridge({
      controller: instance,
      chartId,
      enabled: () => mode === "live",
      context: () => (symbol ? { symbol: symbol.name, interval } : null),
      onAgentError: (message) => {
        bridgeError = message
      },
    })
    if (mode === "live") {
      tab = "agent"
      void chartBridge.attach()
    }

    window.addEventListener("beforeunload", saveState)
    return () => {
      window.removeEventListener("beforeunload", saveState)
      window.clearInterval(refreshTimer)
      window.clearTimeout(searchTimer)
      window.clearTimeout(docTimer)
      chartBridge?.dispose()
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
      // Upstream 5xx (an INDmoney blip) gets one retry before surfacing the error.
      const option = intervalOption(interval)
      const indKey = symbol.indKey
      let response
      try {
        response = await api.candles(indKey, interval, option.lookback)
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status < 500) throw cause
        await new Promise((resolve) => setTimeout(resolve, 800))
        response = await api.candles(indKey, interval, option.lookback)
      }
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
      chartBridge?.scheduleSync()
      void loadWorkspaceDoc()
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

  /** Surgical undo for one agent turn: removes the shapes that turn drew. */
  function undoTurn(messageIDs: string[]): void {
    if (!controller) return
    for (const messageID of messageIDs) controller.undoTurnBySource(messageID)
  }

  function selectInterval(value: string): void {
    if (value === interval || mode === "demo") return
    interval = value
    void loadCandles({ preserveView: false })
    startAutoRefresh()
  }

  async function selectSymbol(result: SearchResult): Promise<void> {
    if (mode === "demo") return
    // Persist the outgoing symbol's document, then switch identity and clear stale
    // drawings immediately — the incoming document loads with the incoming candles.
    docSaveSuspended = true
    try {
      await flushDocSave()
      symbol = result
      quote = null
      searchOpen = false
      query = ""
      results = []
      controller?.loadDoc(EMPTY_DOC)
    } finally {
      docSaveSuspended = false
    }
    await loadCandles({ preserveView: false })
  }

  function onQueryInput(value: string): void {
    query = value
    window.clearTimeout(searchTimer)
    const term = value.trim()
    if (term.length < 2) {
      results = []
      searchOpen = false
      searching = false
      return
    }
    searching = true
    searchOpen = true
    searchTimer = window.setTimeout(async () => {
      try {
        const response = await api.search(term)
        results = response.results
        searching = false
        searchOpen = true
      } catch (cause) {
        searching = false
        handleError(cause)
      }
    }, 250)
  }

  function closeSearchOnBlur(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null
    if (next && (event.currentTarget as HTMLElement).contains(next)) return
    searchOpen = false
  }

  function onSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return
    searchOpen = false
    searchEl?.blur()
  }

  function onTabKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    tab = tab === "agent" ? "console" : "agent"
    const id = tab === "agent" ? "tab-agent" : "tab-console"
    queueMicrotask(() => document.getElementById(id)?.focus())
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

  /** Loads this symbol's persisted document (annotations + series); empty until drawn. */
  async function loadWorkspaceDoc(): Promise<void> {
    if (mode !== "live" || !symbol || !controller) return
    const key = symbol.indKey
    try {
      const response = await api.getWorkspace(key)
      if (symbol?.indKey !== key || !controller) return
      if (response.payload) {
        // Programmatic replacement must not trigger a save of what we just loaded.
        docSaveSuspended = true
        try {
          const result = controller.loadDoc(response.payload)
          if (!result.ok) console.warn("workspace document rejected", result.warnings)
        } finally {
          docSaveSuspended = false
        }
      }
    } catch (cause) {
      handleError(cause)
    }
  }

  /** Persists the current document immediately (cancels a pending debounce). */
  async function flushDocSave(): Promise<void> {
    if (mode !== "live" || !symbol || !controller) return
    window.clearTimeout(docTimer)
    await api.putWorkspace(symbol.indKey, controller.exportDoc()).catch(() => {})
  }

  /** Debounced persistence of the current document under the symbol it belongs to. */
  function scheduleDocSave(): void {
    if (docSaveSuspended || mode !== "live" || !symbol || !controller) return
    const key = symbol.indKey
    window.clearTimeout(docTimer)
    docTimer = window.setTimeout(() => {
      // A symbol switch mid-debounce must not write this doc under the old symbol.
      if (!controller || symbol?.indKey !== key) return
      void api.putWorkspace(key, controller.exportDoc()).catch(() => {})
    }, 800)
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

<div class="flex h-dvh flex-col overflow-hidden bg-canvas text-ink-1">
  <header
    class="grain relative z-40 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-1 bg-surface-1 px-3 py-2.5 sm:px-4"
  >
    <div class="flex items-center gap-2.5">
      <svg class="shrink-0" width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="0.6" y="0.6" width="18.8" height="18.8" rx="4.5" fill="var(--color-surface-2)" stroke="var(--color-line-2)"/>
        <path d="M5.6 6.5v7" stroke="var(--color-accent)" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M10 4.5v11" stroke="var(--color-select)" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M14.4 7.5v5.5" stroke="var(--color-up)" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M3.6 13.4l12.8-6.8" stroke="var(--color-ink-2)" stroke-width="1" stroke-linecap="round" opacity="0.6"/>
      </svg>
      <h1 class="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">Amaterasu</h1>
    </div>

    <span class="hidden h-5 w-px bg-line-1 sm:block" aria-hidden="true"></span>

    {#if mode === "demo"}
      <span class="font-mono text-[11px] text-ink-2">RELIANCE · mock data</span>
    {:else}
      <div class="relative" onfocusout={closeSearchOnBlur}>
        <Icon name="search" size={14} class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          bind:this={searchEl}
          type="search"
          aria-label="Search symbols"
          placeholder="Search symbol…"
          value={query}
          oninput={(event) => onQueryInput((event.currentTarget as HTMLInputElement).value)}
          onfocus={() => (searchOpen = results.length > 0)}
          onkeydown={onSearchKeydown}
          class="input w-40 pl-8 sm:w-52"
        />
        {#if searchOpen}
          <div
            class="absolute left-0 top-[calc(100%+6px)] z-50 w-full min-w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line-2 bg-surface-2 shadow-pop"
          >
            {#if searching}
              <p class="flex items-center gap-2 px-3 py-2.5 text-xs text-ink-3">
                <span class="h-3 w-3 animate-spin rounded-full border border-line-2 border-t-accent" aria-hidden="true"
                ></span>
                Searching…
              </p>
            {:else if results.length === 0}
              <p class="px-3 py-2.5 text-xs text-ink-3">No matches for “{query.trim()}”</p>
            {:else}
              <ul class="scroll-area max-h-64 overflow-y-auto py-1" aria-label="Search results">
                {#each results as result (result.indKey)}
                  <li>
                    <button
                      type="button"
                      onclick={() => selectSymbol(result)}
                      class="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-xs text-ink-2 transition-colors duration-100 hover:bg-surface-3 hover:text-ink-1"
                    >
                      <span class="truncate">{result.name}</span>
                      <span class="shrink-0 font-mono text-[10px] text-ink-3">{result.indKey}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if quote}
      <div class="flex items-baseline gap-2" aria-label="Quote">
        {#if mode === "live" && symbol}
          <span class="hidden max-w-36 truncate text-[11px] text-ink-2 xl:inline">{symbol.name}</span>
        {/if}
        <span class="font-mono text-[17px] font-bold leading-none tabular-nums text-ink-1"
          >{formatPrice(quote.ltp)}</span
        >
        <span class="font-mono text-[11px] leading-none tabular-nums {quoteDelta}"
          >{formatChange(quote.change, quote.changePct)}</span
        >
      </div>
    {:else if mode === "live" && symbol}
      <span class="h-4 w-24 animate-pulse rounded-sm bg-surface-3" aria-hidden="true"></span>
    {/if}

    <div class="flex items-center rounded-md border border-line-1 bg-surface-2 p-0.5" role="group" aria-label="Interval">
      {#each intervalOptions as option (option.value)}
        <button
          type="button"
          class="seg"
          aria-pressed={interval === option.value}
          disabled={mode === "demo"}
          onclick={() => selectInterval(option.value)}
        >
          {option.label}
        </button>
      {/each}
    </div>

    <div class="ml-auto flex items-center gap-3 text-[11px] text-ink-3">
      <span class="sr-only" aria-live="polite">{loading && !initialLoading ? "Updating chart data" : ""}</span>
      {#if loading && !initialLoading}
        <span class="h-3 w-3 animate-spin rounded-full border border-line-2 border-t-accent" aria-hidden="true"></span>
      {/if}
      <span class="tabular-nums hidden sm:inline">updated <span class="font-mono">{formatUpdated(lastUpdated)}</span></span>
      {#if mode === "live"}
        <label class="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" bind:checked={autoRefresh} class="peer sr-only" />
          <span
            class="relative h-3.5 w-6 rounded-full bg-surface-3 transition-colors duration-150 after:absolute after:left-0.5 after:top-0.5 after:h-2.5 after:w-2.5 after:rounded-full after:bg-ink-3 after:transition-transform after:duration-150 after:content-[''] peer-checked:bg-accent/80 peer-checked:after:translate-x-2.5 peer-checked:after:bg-white peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60"
            aria-hidden="true"
          ></span>
          <span>auto</span>
        </label>
        <span class="tip tip-left">
          <button type="button" class="btn btn-icon" aria-label="Refresh" onclick={refreshNow}>
            <Icon name="refresh" size={14} />
          </button>
          <span class="tip-text" aria-hidden="true">Refresh</span>
        </span>
      {/if}
      <span
        class="flex items-center gap-1.5 rounded-sm border border-line-1 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.12em] uppercase {mode ===
        "demo"
          ? "text-ink-3"
          : "text-up"}"
      >
        <span class="h-1 w-1 rounded-full {mode === 'demo' ? 'bg-ink-3' : 'bg-up animate-live'}" aria-hidden="true"></span>
        {mode}
      </span>
      <span class="tabular-nums hidden md:inline"
        >{summary ? `${summary.count} drawing${summary.count === 1 ? "" : "s"}` : "—"}</span
      >
    </div>
  </header>

  {#if needsConnection}
    <div class="flex flex-wrap items-center gap-2 border-b border-select/30 bg-select-soft px-4 py-2 text-xs text-select">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-select" aria-hidden="true"></span>
      <span>INDmoney is not connected — chart data is unavailable.</span>
      <a class="font-medium text-select underline underline-offset-2 hover:text-ink-1" href="/api/indmoney/connect"
        >Connect INDmoney</a
      >
    </div>
  {/if}
  {#if error}
    <div class="border-b border-down/30 bg-down-soft px-4 py-2 text-xs text-down" role="alert">{error}</div>
  {/if}

  <main class="isolate flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
    <section aria-label="Chart" class="relative min-h-[320px] flex-1" aria-busy={loading}>
      <div bind:this={hostEl} class="absolute inset-0"></div>
      <canvas bind:this={annotationEl} class="pointer-events-none absolute left-0 top-0 z-10" aria-hidden="true"
      ></canvas>
      <canvas bind:this={ephemeralEl} class="pointer-events-none absolute left-0 top-0 z-20" aria-hidden="true"
      ></canvas>
      <div bind:this={labelsEl} class="pointer-events-none absolute left-0 top-0 z-30 overflow-hidden"></div>
      {#if loading && !initialLoading}
        <div class="pointer-events-none absolute inset-x-0 top-0 z-50 h-px animate-pulse bg-accent/70" aria-hidden="true"></div>
      {/if}
      <p
        class="pointer-events-none absolute left-3 top-2 z-50 hidden items-center gap-1.5 rounded-md border border-line-2 bg-surface-1/85 px-2 py-1 text-[10px] text-ink-2 backdrop-blur-[2px] lg:flex"
      >
        <span>drag pan</span><span aria-hidden="true">·</span><span>scroll zoom</span><span aria-hidden="true">·</span>
        <kbd class="kbd">Del</kbd><span>removes</span><span aria-hidden="true">·</span><kbd class="kbd">Esc</kbd
        ><span>cancels</span>
      </p>
      {#if initialLoading}
        <div class="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-canvas" role="status">
          <div class="flex h-16 items-end gap-1.5" aria-hidden="true">
            {#each [34, 52, 40, 64, 46, 58, 38, 50] as height, index}
              <span
                class="w-2 animate-pulse rounded-sm bg-surface-3"
                style={`height:${height}px; animation-delay:${index * 120}ms`}
              ></span>
            {/each}
          </div>
          <p class="text-xs text-ink-3">Loading {symbol?.name ?? "chart data"}…</p>
        </div>
      {/if}
    </section>

    <aside
      class="grain flex max-h-[55dvh] min-h-0 w-full flex-col overflow-hidden border-t border-line-1 bg-surface-1 pb-[env(safe-area-inset-bottom)] lg:max-h-none lg:w-[380px] lg:border-l lg:border-t-0 lg:pb-0"
    >
      <div
        class="scroll-area flex items-center gap-1 overflow-x-auto border-b border-line-1 px-2 py-1.5 lg:overflow-visible"
        role="toolbar"
        aria-label="Drawing tools"
      >
        {#each TOOLS as tool (tool.id)}
          <span class="tip">
            <button
              type="button"
              class="btn btn-icon"
              aria-label={tool.label}
              aria-pressed={summary?.tool === tool.id}
              onclick={() => controller?.setTool(tool.id)}
            >
              <Icon name={tool.icon} />
            </button>
            <span class="tip-text" aria-hidden="true">{tool.label}</span>
          </span>
        {/each}
        <span class="mx-1 h-4 w-px bg-line-1" aria-hidden="true"></span>
        <span class="tip">
          <button type="button" class="btn btn-icon" aria-label="Undo" disabled={!summary?.canUndo} onclick={() => controller?.undo()}>
            <Icon name="undo" />
          </button>
          <span class="tip-text" aria-hidden="true">Undo</span>
        </span>
        <span class="tip">
          <button type="button" class="btn btn-icon" aria-label="Redo" disabled={!summary?.canRedo} onclick={() => controller?.redo()}>
            <Icon name="redo" />
          </button>
          <span class="tip-text" aria-hidden="true">Redo</span>
        </span>
        <span class="tip tip-left ml-auto">
          <button
            type="button"
            class="btn btn-icon"
            aria-label="Clear all"
            disabled={!summary || summary.count === 0}
            onclick={() => controller?.clearAll()}
          >
            <Icon name="trash" />
          </button>
          <span class="tip-text" aria-hidden="true">Clear all</span>
        </span>
      </div>

      <div class="flex border-b border-line-1" role="tablist" aria-label="Panels" tabindex="-1" onkeydown={onTabKeydown}>
        <button
          id="tab-agent"
          type="button"
          role="tab"
          aria-selected={tab === "agent"}
          aria-controls="panel-agent"
          tabindex={tab === "agent" ? 0 : -1}
          class="tab"
          onclick={() => (tab = "agent")}>Agent</button
        >
        <button
          id="tab-console"
          type="button"
          role="tab"
          aria-selected={tab === "console"}
          aria-controls="panel-console"
          tabindex={tab === "console" ? 0 : -1}
          class="tab"
          onclick={() => (tab = "console")}>Console</button
        >
      </div>

      {#if bridgeError}
        <p class="border-b border-down/30 bg-down-soft px-3 py-1.5 text-[10px] text-down" role="alert">{bridgeError}</p>
      {/if}

      {#if tab === "agent"}
        <div id="panel-agent" role="tabpanel" aria-labelledby="tab-agent" class="flex min-h-0 flex-1 flex-col">
          <ChatPanel {mode} onUndoTurn={undoTurn} />
        </div>
      {:else}
        <div id="panel-console" role="tabpanel" aria-labelledby="tab-console" class="flex min-h-0 flex-1 flex-col">
          <OpConsole {controller} {log} />
        </div>
      {/if}
    </aside>
  </main>
</div>
