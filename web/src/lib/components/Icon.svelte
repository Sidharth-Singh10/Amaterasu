<script lang="ts">
  import type { IconName } from "./icons"

  /**
   * Minimal custom icon set (20×20 grid, 1.5px stroke) — deliberately not a stock
   * icon library. Purely decorative: callers must supply the accessible name.
   */
  let {
    name,
    size = 16,
    class: className = "",
  }: { name: IconName; size?: number; class?: string } = $props()
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox="0 0 20 20"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "select"}
    <path
      d="M4.5 3.5l5.4 12.8 1.6-5.6 5.6-1.6z"
      fill="currentColor"
      stroke="currentColor"
      stroke-width="1.2"
    />
  {:else if name === "trendline"}
    <path d="M4.5 15.5L15.5 4.5" />
    <circle cx="4.5" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="4.5" r="1.4" fill="currentColor" stroke="none" />
  {:else if name === "ray"}
    <path d="M3.5 16L15.5 5" />
    <path d="M16 4.9l-4.1.8M16 4.9l-.8 4.1" />
    <circle cx="3.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
  {:else if name === "hline"}
    <path d="M2.5 10h15" />
  {:else if name === "vline"}
    <path d="M10 2.5v15" />
  {:else if name === "rect"}
    <rect x="3.5" y="5" width="13" height="10" rx="1" />
  {:else if name === "label"}
    <path d="M4 4.5h12v8H9l-3.5 3v-3H4z" />
  {:else if name === "undo"}
    <path d="M8.5 5.5L4 10l4.5 4.5" />
    <path d="M4 10h7.5a4 4 0 014 4v.5" />
  {:else if name === "redo"}
    <path d="M11.5 5.5L16 10l-4.5 4.5" />
    <path d="M16 10H8.5a4 4 0 00-4 4v.5" />
  {:else if name === "trash"}
    <path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10h6.6L14 6M8.5 9v4M11.5 9v4" />
  {:else if name === "refresh"}
    <path d="M15.5 10a5.5 5.5 0 11-1.7-4" />
    <path d="M15.5 3.5v3.2h-3.2" />
  {:else if name === "search"}
    <circle cx="9" cy="9" r="4.5" />
    <path d="M12.4 12.4L16 16" />
  {/if}
</svg>
