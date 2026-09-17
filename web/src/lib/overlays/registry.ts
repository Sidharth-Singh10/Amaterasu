import type { Annotation, Kind } from "@amaterasu/chart-dsl"
import type { Transform } from "@/lib/chart/transform"
import type { Painter, Point } from "./painter"

/** Frame environment passed to renderers. */
export interface FrameEnv {
  selected: boolean
  hovered: boolean
}

/**
 * Renderers are pure functions of (annotation, transform): immediate-mode redraw,
 * never diffed. Each kind owns its drawing, hit-testing, and (later) handles.
 */
export interface Renderer<A extends Annotation = Annotation> {
  readonly kind: Kind
  draw(a: A, t: Transform, painter: Painter, env: FrameEnv): void
  /** Pixel distance to the shape, or null on miss. */
  hitTest?(a: A, t: Transform, pt: Point, tol: number): number | null
  /** Anchor points are draggable handles when the annotation is selected. */
  readonly handles?: boolean
}

const registry = new Map<Kind, Renderer>()

export function registerRenderer(renderer: Renderer): void {
  if (registry.has(renderer.kind)) {
    throw new Error(`a renderer is already registered for kind "${renderer.kind}"`)
  }
  registry.set(renderer.kind, renderer)
}

export function getRenderer(kind: Kind): Renderer | undefined {
  return registry.get(kind)
}

export function registeredKinds(): Kind[] {
  return [...registry.keys()]
}
