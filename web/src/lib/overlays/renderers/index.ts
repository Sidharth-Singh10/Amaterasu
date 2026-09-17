import { registerRenderer } from "../registry"
import { channelRenderer } from "./channel"
import { fibRenderer } from "./fib"
import { hlineRenderer } from "./hline"
import { hzoneRenderer } from "./hzone"
import { labelRenderer } from "./label"
import { markerRenderer } from "./marker"
import { measureRenderer } from "./measure"
import { rayRenderer } from "./ray"
import { rectRenderer } from "./rect"
import { trendlineRenderer } from "./trendline"
import { vlineRenderer } from "./vline"
import { vzoneRenderer } from "./vzone"

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
    hzoneRenderer,
    vzoneRenderer,
    markerRenderer,
    measureRenderer,
    fibRenderer,
    channelRenderer,
    labelRenderer,
  ]) {
    registerRenderer(renderer)
  }
}
