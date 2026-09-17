<script lang="ts">
  import { onMount } from "svelte"
  import { ApiError } from "@/lib/api/client"
  import { bridge, onStreamEvent, type RawMessage, type StreamEvent } from "@/lib/api/bridge"

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

  let sessionID = $state<string | null>(null)
  let items = $state<ChatItem[]>([])
  let input = $state("")
  let running = $state(false)
  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let listEl = $state<HTMLDivElement | null>(null)
  let hydrateTimer: number | undefined

  const buttonBase =
    "rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-[#c9d4e3] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4c8dff]"

  onMount(() => {
    if (mode === "demo") {
      notice = "The agent is unavailable in demo mode."
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
  <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" bind:this={listEl} aria-live="polite">
    {#if notice}
      <p class="rounded border border-white/10 bg-white/5 p-2 text-[11px] text-[#8b98a9]">{notice}</p>
    {/if}
    {#if error}
      <p class="rounded border border-[#ef5350]/40 bg-[#ef5350]/10 p-2 text-[11px] text-[#ef5350]" role="alert">
        {error}
      </p>
    {/if}
    {#if items.length === 0 && !notice}
      <p class="text-[11px] text-[#8b98a9]">
        Ask the analyst about the chart — e.g. “Mark the recent range and tell me what to watch.”
      </p>
    {/if}

    {#each items as item, index (item.id)}
      {#if item.role === "user"}
        <div class="ml-6 rounded border border-[#4c8dff]/30 bg-[#4c8dff]/10 p-2 text-xs text-[#d7dee8]">
          {item.text}
        </div>
      {:else}
        <div class="space-y-2">
          {#if item.text}
            <div class="rounded border border-white/10 bg-white/5 p-2 text-xs leading-relaxed text-[#d7dee8] whitespace-pre-wrap">
              {item.text}{#if item.streaming}<span class="text-[#8b98a9]">▍</span>{/if}
            </div>
          {/if}
          {#each item.tools as tool (tool.id)}
            <div class="rounded border border-white/10 bg-[#0d121a] p-2">
              <div class="flex items-center gap-2">
                <span class="font-mono text-[10px] text-[#8b98a9]">{tool.status}</span>
                <span class="text-[11px] font-medium text-[#c9d4e3]">{tool.name}</span>
              </div>
              {#if tool.detail}
                <p class="mt-1 truncate font-mono text-[10px] text-[#5c6a7d]">{tool.detail}</p>
              {/if}
            </div>
          {/each}
          {#if isTurnTail(index) && turnHasChartTools(index) && onUndoTurn}
            <button type="button" class={buttonBase} onclick={() => onUndoTurn(turnMessageIDs(index))}>
              Undo this turn
            </button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <div class="border-t border-white/10 p-3">
    <label for="chat-input" class="sr-only">Message the chart analyst</label>
    <textarea
      id="chat-input"
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
      class="w-full resize-none rounded border border-white/15 bg-[#0d121a] p-2 text-xs text-[#d7dee8] placeholder:text-[#5c6a7d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4c8dff]"
    ></textarea>
    <div class="mt-2 flex items-center gap-2">
      <button type="button" class={buttonBase} onclick={() => void send()} disabled={running || !sessionID || input.trim() === ""}>
        {running ? "Running…" : "Send"}
      </button>
      {#if running}
        <button type="button" class={buttonBase} onclick={() => void interrupt()}>Interrupt</button>
      {/if}
    </div>
  </div>
</div>
