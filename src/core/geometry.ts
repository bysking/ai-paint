/**
 * Pure 2D geometry helpers used by the rough renderer.
 * No DOM / canvas dependencies — works in Node.
 */

export interface Point {
  x: number
  y: number
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic 32-bit string hash (xmur3-style). */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

export function midPoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy })
}

export function rotatePoint(p: Point, cx: number, cy: number, angleRad: number): Point {
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const dx = p.x - cx
  const dy = p.y - cy
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

export function angleOf(a: Point, b: Point): number {
  return Math.atan2(b.y - a.y, b.x - a.x)
}

export function unitPerp(p: Point): Point {
  const len = Math.hypot(p.x, p.y) || 1
  return { x: -p.y / len, y: p.x / len }
}

/** Signed polygon area (shoelace). */
export function polygonArea(poly: Point[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

/** Ray-casting point-in-polygon test (works for concave). */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

export function lineIntersection(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point,
): Point | null {
  const d1x = p2.x - p1.x
  const d1y = p2.y - p1.y
  const d2x = p4.x - p3.x
  const d2y = p4.y - p3.y
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-9) return null // parallel / collinear
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { x: p1.x + t * d1x, y: p1.y + t * d1y }
}

/** Clip segment a→b against a polygon; returns the inside segments (concave-safe). */
export function clipSegmentToPolygon(a: Point, b: Point, poly: Point[]): Point[][] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy || 1
  const ts = new Set<number>([0, 1])
  for (let i = 0; i < poly.length; i++) {
    const hit = lineIntersection(a, b, poly[i], poly[(i + 1) % poly.length])
    if (hit) {
      const t = ((hit.x - a.x) * dx + (hit.y - a.y) * dy) / lenSq
      if (t > 1e-6 && t < 1 - 1e-6) ts.add(t)
    }
  }
  const sorted = [...ts].sort((x, y) => x - y)
  const out: Point[][] = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const t0 = sorted[i]
    const t1 = sorted[i + 1]
    if (t1 - t0 < 1e-6) continue
    const mid = { x: a.x + dx * ((t0 + t1) / 2), y: a.y + dy * ((t0 + t1) / 2) }
    if (pointInPolygon(mid, poly)) {
      out.push([
        { x: a.x + dx * t0, y: a.y + dy * t0 },
        { x: a.x + dx * t1, y: a.y + dy * t1 },
      ])
    }
  }
  return out
}

export function ellipsePoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotationRad = 0,
  steps = 48,
): Point[] {
  const pts: Point[] = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const p = { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) }
    pts.push(rotatePoint(p, cx, cy, rotationRad))
  }
  return pts
}

/** Split segment a→b into [dash, gap] runs. */
export function dashSegments(a: Point, b: Point, dashLen: number, gapLen: number): Point[][] {
  const total = dist(a, b)
  if (total === 0) return []
  const ux = (b.x - a.x) / total
  const uy = (b.y - a.y) / total
  const segs: Point[][] = []
  let t = 0
  while (t < total) {
    const end = Math.min(t + dashLen, total)
    segs.push([
      { x: a.x + ux * t, y: a.y + uy * t },
      { x: a.x + ux * end, y: a.y + uy * end },
    ])
    t = end + gapLen
  }
  return segs
}
