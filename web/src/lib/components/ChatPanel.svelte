<script lang="ts">
  import { onMount } from "svelte"
  import { ApiError } from "@/lib/api/client"
  import { bridge, onStreamEvent, type RawMessage, type StreamEvent } from "@/lib/api/bridge"
  import Icon from "@/lib/components/Icon.svelte"

  let {
    mode = "live",
    onUndoTurn,
  }: { mode?: "live" | "demo"; onUndoTurn?: (messageIDs: string[]) => void } = $props()

  interface ToolCard {
    id: string
    name: string
    status: string
    detail?: string
  }

  interface ChatItem {
    id: string
    role: "user" | "assistant"
    text: string
    tools: ToolCard[]
    streaming?: boolean
  }

  const SESSION_KEY = "amaterasu.chat.session"

  const PROMPTS = ["Analyze this setup", "Mark support and resistance", "Where's the invalidation?"]

  let sessionID = $state<string | null>(null)
  let items = $state<ChatItem[]>([])
  let input = $state("")
  let running = $state(false)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let listEl = $state<HTMLDivElement | null>(null)
  let inputEl = $state<HTMLTextAreaElement | null>(null)
  let hydrateTimer: number | undefined

  onMount(() => {
    if (mode === "demo") {
      notice = "Demo data — the agent is unavailable in demo mode."
      return
    }
    const unsubscribe = onStreamEvent(handleEvent)
    void bootstrap()
    return () => {
      unsubscribe()
      window.clearTimeout(hydrateTimer)
    }
  })

  $effect(() => {
    if (listEl && items.length > 0) {
      listEl.scrollTop = listEl.scrollHeight
    }
  })

  async function bootstrap(): Promise<void> {
    try {
      const stored = localStorage.getItem(SESSION_KEY)
      if (stored) {
        sessionID = stored
        try {
          await hydrate()
          return
        } catch {
          localStorage.removeItem(SESSION_KEY)
        }
      }
      const created = await bridge.createChatSession()
      sessionID = created.sessionID
      localStorage.setItem(SESSION_KEY, created.sessionID)
    } catch (cause) {
      handleError(cause)
    }
  }

  async function hydrate(): Promise<void> {
    if (!sessionID) return
    const response = await bridge.messages(sessionID)
    items = mapMessages(response.messages)
  }

  function scheduleHydrate(): void {
    window.clearTimeout(hydrateTimer)
    hydrateTimer = window.setTimeout(() => {
      void hydrate().catch(handleError)
    }, 400)
  }

  function handleEvent(event: StreamEvent): void {
    const data = event.data as Record<string, unknown> | undefined
    const eventSession = data?.sessionID as string | undefined
    if (eventSession && sessionID && eventSession !== sessionID) return

    switch (event.type) {
      case "chat.turn.started":
      case "session.execution.started":
        running = true
        return
      case "session.text.started": {
        const assistantID = data?.assistantMessageID as string | undefined
        if (!assistantID) return
        if (!items.some((item) => item.id === assistantID)) {
          items = [...items, { id: assistantID, role: "assistant", text: "", tools: [], streaming: true }]
        }
        running = true
        return
      }
      case "session.text.delta": {
        const assistantID = data?.assistantMessageID as string | undefined
        const delta = (data?.delta as string | undefined) ?? ""
        if (!assistantID) return
        items = items.map((item) =>
          item.id === assistantID ? { ...item, text: item.text + delta, streaming: true } : item,
        )
        return
      }
      case "session.text.ended": {
        const assistantID = data?.assistantMessageID as string | undefined
        const text = (data?.text as string | undefined) ?? ""
        if (!assistantID) return
        items = items.map((item) => (item.id === assistantID ? { ...item, text, streaming: false } : item))
        return
      }
      case "session.inbox.delivered":
        scheduleHydrate()
        return
      case "session.step.ended":
        scheduleHydrate()
        return
      case "session.execution.succeeded":
        running = false
        scheduleHydrate()
        return
      case "session.execution.failed": {
        running = false
        const message = (data?.error as { message?: string } | undefined)?.message
        if (message) error = message
        scheduleHydrate()
        return
      }
    }
  }

  function mapMessages(messages: RawMessage[]): ChatItem[] {
    const mapped: ChatItem[] = []
    for (const message of messages) {
      if (message.type === "user") {
        mapped.push({ id: message.id, role: "user", text: message.text ?? "", tools: [] })
      } else if (message.type === "assistant") {
        let text = ""
        const tools: ToolCard[] = []
        for (const part of message.content ?? []) {
          const type = String(part.type ?? "")
          if (type === "text" && typeof part.text === "string") {
            text += part.text
          } else if (type === "tool" || part.tool) {
            const state = (part.state ?? {}) as Record<string, unknown>
            const metadata = (state.metadata ?? {}) as Record<string, unknown>
            const nested = Array.isArray(metadata.toolCalls)
              ? (metadata.toolCalls as Array<Record<string, unknown>>)
              : []
            if (nested.length > 0) {
              // Code Mode: the top-level call is `execute`; the interesting tools are nested.
              for (const call of nested) {
                tools.push({
                  id: String(call.id ?? `${message.id}-${tools.length}`),
                  name: String(call.tool ?? "tool"),
                  status: String(call.status ?? state.status ?? "completed"),
                  detail: digest(state.input ?? part.input),
                })
              }
            } else {
              tools.push({
                id: String(part.id ?? `${message.id}-${tools.length}`),
                name: String(part.tool ?? part.name ?? "tool"),
                status: String(state.status ?? part.status ?? "done"),
                detail: digest(state.input ?? part.input),
              })
            }
          }
        }
        mapped.push({ id: message.id, role: "assistant", text, tools })
      }
    }
    return mapped
  }

  function digest(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined
    try {
      const text = JSON.stringify(value)
      return text.length > 140 ? `${text.slice(0, 140)}…` : text
    } catch {
      return undefined
    }
  }

  function statusDot(status: string): string {
    const value = status.toLowerCase()
    if (value.includes("error") || value.includes("fail")) return "bg-down"
    if (value.includes("run") || value.includes("pending") || value.includes("progress")) return "bg-select animate-pulse"
    return "bg-up"
  }

  /** Assistant message ids of the turn containing `index` (since the previous user message). */
  function turnMessageIDs(index: number): string[] {
    let start = index
    while (start > 0 && items[start - 1].role === "assistant") start--
    let end = index
    while (end < items.length - 1 && items[end + 1].role === "assistant") end++
    return items.slice(start, end + 1).map((item) => item.id)
  }

  function turnHasChartTools(index: number): boolean {
    return turnMessageIDs(index).some((id) => {
      const item = items.find((candidate) => candidate.id === id)
      return item?.tools.some((tool) => tool.name.startsWith("chart")) ?? false
    })
  }

  function isTurnTail(index: number): boolean {
    return index === items.length - 1 || items[index + 1].role === "user"
  }

  function insertPrompt(prompt: string): void {
    input = prompt
    inputEl?.focus()
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || !sessionID || running) return
    input = ""
    error = null
    items = [...items, { id: `local-${Date.now()}`, role: "user", text, tools: [] }]
    try {
      await bridge.prompt(sessionID, text)
      running = true
    } catch (cause) {
      handleError(cause)
    }
  }

  async function interrupt(): Promise<void> {
    if (!sessionID) return
    try {
      await bridge.interrupt(sessionID)
      running = false
    } catch (cause) {
      handleError(cause)
    }
  }

  function handleError(cause: unknown): void {
    if (cause instanceof ApiError) {
      if (cause.code === "chat_not_configured") {
        notice = "The agent bridge is not configured on the server (OPENCODE_PASSWORD is unset)."
        return
      }
      error = `${cause.code}: ${cause.message}`
    } else {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="scroll-area min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" bind:this={listEl} aria-live="polite">
    {#if notice}
      <p class="rounded-md border border-line-1 bg-surface-2/60 px-2.5 py-2 text-[11px] leading-relaxed text-ink-3">
        {notice}
      </p>
    {/if}
    {#if error}
      <p class="rounded-md border border-down/30 bg-down-soft px-2.5 py-2 text-[11px] leading-relaxed text-down" role="alert">
        {error}
      </p>
    {/if}

    {#if items.length === 0 && !notice}
      <div class="flex flex-col gap-3 pt-1">
        <p class="text-[10px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Chart analyst</p>
        <p class="text-[11px] leading-relaxed text-ink-2">
          Ask about the instrument on screen. The agent reads the visible bars, draws levels and zones, and plots
          indicators — every drawing lands in your undo history.
        </p>
        <div class="flex flex-col gap-0.5">
          {#each PROMPTS as prompt (prompt)}
            <button
              type="button"
              class="flex items-center gap-2 rounded-sm px-1.5 py-1 text-left font-mono text-[11px] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none"
              onclick={() => insertPrompt(prompt)}
            >
              <span class="text-accent" aria-hidden="true">&gt;</span>
              <span class="truncate">{prompt}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#each items as item, index (item.id)}
      {#if item.role === "user"}
        <div class="ml-auto max-w-[88%] rounded-lg rounded-br-xs border border-accent/25 bg-accent-soft px-2.5 py-2 text-[13px] leading-relaxed text-ink-1">
          {item.text}
        </div>
      {:else}
        <div class="space-y-2">
          {#if item.text}
            <div class="text-[13px] leading-relaxed whitespace-pre-wrap text-ink-1">
              {item.text}{#if item.streaming}<span
                  class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-[1px] bg-accent align-text-bottom"
                ></span>{/if}
            </div>
          {/if}
          {#each item.tools as tool (tool.id)}
            <div class="rounded-md bg-surface-2/70 px-2.5 py-1.5">
              <div class="flex items-center gap-2">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full {statusDot(tool.status)}" aria-hidden="true"></span>
                <span class="truncate font-mono text-[11px] text-ink-2">{tool.name}</span>
                <span class="ml-auto shrink-0 text-[9px] font-semibold tracking-[0.12em] text-ink-3 uppercase"
                  >{tool.status}</span
                >
              </div>
              {#if tool.detail}
                <p class="mt-1 truncate pl-3.5 font-mono text-[10px] text-ink-2">{tool.detail}</p>
              {/if}
            </div>
          {/each}
          {#if isTurnTail(index) && turnHasChartTools(index) && onUndoTurn}
            <button type="button" class="btn" onclick={() => onUndoTurn(turnMessageIDs(index))}>
              <Icon name="undo" size={12} /> Undo this turn
            </button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <div class="border-t border-line-1 p-3">
    <label for="chat-input" class="sr-only">Message the chart analyst</label>
    <textarea
      id="chat-input"
      bind:this={inputEl}
      bind:value={input}
      rows={2}
      placeholder="Ask about this chart…"
      disabled={mode === "demo" || !sessionID}
      onkeydown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault()
          void send()
        }
      }}
      class="input w-full resize-none leading-relaxed"
    ></textarea>
    <div class="mt-2 flex items-center gap-2">
      <button
        type="button"
        class="btn btn-primary"
        onclick={() => void send()}
        disabled={running || !sessionID || input.trim() === ""}
      >
        {#if running}
          <span class="h-3 w-3 animate-spin rounded-full border border-line-2 border-t-accent" aria-hidden="true"></span>
          Running…
        {:else}
          Send
        {/if}
      </button>
      {#if running}
        <button type="button" class="btn" onclick={() => void interrupt()}>Interrupt</button>
      {/if}
      <span class="ml-auto hidden text-[10px] text-ink-2 sm:inline">Enter sends · Shift+Enter adds a line</span>
    </div>
  </div>
</div>
