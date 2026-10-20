<script lang="ts">
  import Icon from "@/lib/components/Icon.svelte"
  import { docs, type DocMeta, type JournalActor, type JournalOp } from "@/lib/api/docs"

  let {
    chartId = "",
    visible = false,
    version = 0,
  }: { chartId?: string; visible?: boolean; version?: number } = $props()

  interface TurnView {
    id: string
    actor: JournalActor
    createdAt: string
    ops: JournalOp[]
    undoes: string | null
    undoneBy: string | null
    applied: number
    rejected: number
    canUndo: boolean
  }

  let ops = $state<JournalOp[]>([])
  let meta = $state<DocMeta | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let undoing = $state<string | null>(null)
  let ticket = 0

  $effect(() => {
    if (!chartId || !visible) return
    // `version` is bumped after every bridge ack, so the panel refetches.
    void version
    void load()
  })

  let turns = $derived.by(() => {
    const byTurn = new Map<string, TurnView>()
    for (const op of ops) {
      let turn = byTurn.get(op.turn_id)
      if (!turn) {
        turn = {
          id: op.turn_id,
          actor: op.envelope.actor,
          createdAt: op.envelope.created_at,
          ops: [],
          undoes: op.undoes,
          undoneBy: op.undone_by,
          applied: 0,
          rejected: 0,
          canUndo: false,
        }
        byTurn.set(op.turn_id, turn)
      }
      turn.ops.push(op)
      if (op.status === "applied") turn.applied += 1
      else turn.rejected += 1
    }
    for (const turn of byTurn.values()) {
      turn.ops.sort((left, right) => left.seq - right.seq)
      turn.canUndo =
        !turn.undoneBy &&
        turn.rejected === 0 &&
        turn.ops.some(
          (op) => Array.isArray(op.ack?.inverse) && op.ack.inverse.length > 0,
        )
    }
    return [...byTurn.values()]
  })

  async function load(): Promise<void> {
    if (!chartId) return
    const id = chartId
    const current = ++ticket
    loading = true
    error = null
    try {
      const [nextMeta, nextOps] = await Promise.all([
        docs.meta(id),
        docs.ops(id, 100),
      ])
      if (current !== ticket) return
      meta = nextMeta
      ops = nextOps.ops
    } catch (cause) {
      if (current === ticket) error = (cause as Error).message
    } finally {
      if (current === ticket) loading = false
    }
  }

  async function undo(turn: TurnView): Promise<void> {
    if (!chartId || undoing) return
    undoing = turn.id
    error = null
    try {
      const result = await docs.undoTurn(chartId, turn.id)
      if (!result.applied) {
        const rejected = result.acks.find((ack) => ack.status === "rejected")
        error = rejected
          ? `${rejected.code ?? "rejected"}: ${rejected.message ?? "the adapter rejected the inverse"}`
          : "the undo was not applied"
      }
      await load()
    } catch (cause) {
      error = (cause as Error).message
    } finally {
      undoing = null
    }
  }

  function formatTime(value: string): string {
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  function shortTurn(value: string): string {
    return value.replace(/^turn_/, "").slice(0, 12)
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="border-b border-line-1 px-3 py-2.5">
    <div class="flex items-center gap-2">
      <p class="text-[10px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Journal</p>
      {#if meta}
        <span class="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2"
          >r{meta.doc.revision}</span
        >
        <span class="text-[10px] {meta.verification.ok ? 'text-up' : 'text-down'}">
          {meta.verification.ok
            ? "audit verified"
            : `audit broken at ${meta.verification.broken_at ?? "?"}`}
        </span>
      {/if}
      <button
        type="button"
        class="btn btn-icon ml-auto"
        aria-label="Refresh journal"
        disabled={loading}
        onclick={() => void load()}
      >
        <Icon name="refresh" size={14} />
      </button>
    </div>
    <p class="mt-1 text-[10px] leading-relaxed text-ink-3">
      Agent turns recorded on the server. Undo appends a new turn; it never rewrites history.
    </p>
  </div>

  <div class="scroll-area min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
    {#if loading && ops.length === 0}
      <p class="text-[11px] text-ink-3" role="status">Loading journal…</p>
    {:else if error}
      <p class="text-[11px] leading-relaxed text-down" role="alert">{error}</p>
    {:else if turns.length === 0}
      <p class="text-[11px] leading-relaxed text-ink-3">
        No agent turns journaled for this chart yet. Draw a shape or ask the agent to, then return
        here.
      </p>
    {:else}
      <ul class="space-y-2">
        {#each turns as turn (turn.id)}
          <li class="rounded-md border border-line-1 bg-surface-2/60 px-2.5 py-2">
            <div class="flex items-center gap-2">
              <span
                class="rounded-sm border border-line-1 px-1 py-0.5 text-[9px] font-semibold tracking-[0.08em] uppercase {turn.actor
                  .kind === 'human'
                  ? 'text-select'
                  : 'text-ink-2'}">{turn.actor.kind}</span
              >
              <span class="truncate font-mono text-[10px] text-ink-2">{turn.actor.id}</span>
              <span class="ml-auto shrink-0 font-mono text-[10px] text-ink-3"
                >{formatTime(turn.createdAt)}</span
              >
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ink-3">
              <span class="font-mono">{shortTurn(turn.id)}</span>
              <span aria-hidden="true">·</span>
              <span>{turn.ops.length} op{turn.ops.length === 1 ? "" : "s"}</span>
              {#if turn.undoneBy}
                <span class="text-select">undone</span>
              {:else if turn.undoes}
                <span class="text-select">undo of {shortTurn(turn.undoes)}</span>
              {/if}
            </div>

            <ul class="mt-1.5 space-y-1">
              {#each turn.ops as op (op.op_id)}
                <li class="rounded bg-surface-1/70 px-2 py-1">
                  <div class="flex items-center gap-2">
                    <span
                      class="h-1.5 w-1.5 shrink-0 rounded-full {op.status === 'applied'
                        ? 'bg-up'
                        : 'bg-down'}"
                      aria-hidden="true"
                    ></span>
                    <span class="truncate font-mono text-[10px] text-ink-2">{op.envelope.type}</span>
                    {#if op.envelope.target.id}
                      <span class="shrink-0 font-mono text-[9px] text-ink-3"
                        >{op.envelope.target.id.slice(0, 8)}</span
                      >
                    {/if}
                    {#if op.revision != null}
                      <span class="ml-auto shrink-0 font-mono text-[9px] text-ink-3"
                        >r{op.revision}</span
                      >
                    {/if}
                  </div>
                  {#if op.status !== "applied" && op.ack}
                    <p class="mt-0.5 text-[10px] leading-relaxed text-down">
                      {op.ack.code ?? "rejected"}{op.ack.message ? ` — ${op.ack.message}` : ""}
                    </p>
                  {:else if op.envelope.rationale}
                    <p class="mt-0.5 truncate text-[10px] text-ink-3">{op.envelope.rationale}</p>
                  {/if}
                </li>
              {/each}
            </ul>

            <div class="mt-2 flex items-center gap-2">
              <button
                type="button"
                class="btn text-[10px]"
                disabled={!turn.canUndo || undoing !== null}
                onclick={() => void undo(turn)}
              >
                {undoing === turn.id ? "Undoing…" : "Undo turn"}
              </button>
              {#if !turn.canUndo && !turn.undoneBy}
                <span class="text-[10px] text-ink-3">
                  {turn.rejected > 0 ? "turn has rejections" : "no inverse recorded"}
                </span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
