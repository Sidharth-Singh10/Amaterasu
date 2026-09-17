import { registerRenderer } from "../registry"
import { hlineRenderer } from "./hline"
import { labelRenderer } from "./label"
import { rayRenderer } from "./ray"
import { rectRenderer } from "./rect"
import { trendlineRenderer } from "./trendline"
import { vlineRenderer } from "./vline"

let registered = false

/** Idempotent: the controller calls this on construction. */
export function registerBuiltinRenderers(): void {
  if (registered) return
  registered = true
  for (const renderer of [
    trendlineRenderer,
    rayRenderer,
    hlineRenderer,
    vlineRenderer,
    rectRenderer,
    labelRenderer,
  ]) {
    registerRenderer(renderer)
  }
}
