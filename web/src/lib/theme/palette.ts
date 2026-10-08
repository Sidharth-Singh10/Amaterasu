/**
 * Canvas-side palette for lightweight-charts options and the overlay renderers,
 * which cannot read CSS variables. The DOM side mirrors these values as Tailwind
 * tokens in `web/src/app.css` (@theme) — keep both in sync.
 */
export const palette = {
  canvas: "#0b0f14",
  gridLine: "rgba(148,161,179,0.08)",
  axisText: "#94a1b3",
  axisBorder: "rgba(148,161,179,0.22)",

  up: "#26a69a",
  down: "#ef5350",
  upSoft: "rgba(38,166,154,0.35)",
  downSoft: "rgba(239,83,80,0.35)",

  accent: "#5d91e9",
  selection: "#e6ad33",

  shapeText: "#d5deea",
  labelBg: "rgba(16,22,31,0.9)",
  labelBorder: "rgba(230,173,51,0.5)",
} as const
