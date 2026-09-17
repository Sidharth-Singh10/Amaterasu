import type { Point } from "./painter"

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Distance from a point to a segment (clamped at the endpoints). */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const wx = p.x - a.x
  const wy = p.y - a.y
  const len2 = vx * vx + vy * vy
  if (len2 === 0) return Math.hypot(wx, wy)
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2))
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
}

export function distToPoint(p: Point, a: Point): number {
  return Math.hypot(p.x - a.x, p.y - a.y)
}

export function distToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w))
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h))
  return Math.hypot(dx, dy)
}

export function insideRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

export function rectFromCorners(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  }
}
