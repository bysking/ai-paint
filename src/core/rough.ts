/**
 * Rough-style jitter primitives — deterministic, Excalidraw-like hand-drawn look.
 * All jitter is seeded from the element id so renders are reproducible.
 */

import type { Point } from './geometry.js'
import { angleOf, dist, hashSeed, mulberry32, unitPerp } from './geometry.js'

export interface RoughOptions {
  roughness?: number // 0..2
  seed?: string | number
  bowing?: number
}

export interface StrokeOptions extends RoughOptions {
  strokeWidth?: number
  dash?: [number, number] // [dashLen, gapLen]
  hachureGap?: number
  fillWeight?: number
}

export function makeRng(seed: string | number): () => number {
  const s = typeof seed === 'number' ? seed : hashSeed(seed)
  return mulberry32(s)
}

/** Displace a point by a jitter amount perpendicular to travel direction. */
export function jitter(p: Point, prev: Point, next: Point, amt: number, rnd: () => number): Point {
  const dir =
    prev && next
      ? unitPerp({ x: next.x - prev.x, y: next.y - prev.y })
      : { x: (rnd() - 0.5) * 2, y: (rnd() - 0.5) * 2 }
  const d = (rnd() - 0.5) * 2 * amt
  return { x: p.x + dir.x * d, y: p.y + dir.y * d }
}

export interface JitteredLine {
  segments: Point[][] // each segment is [start, end]
}

/**
 * Produce a "rough" polyline: the input polyline is walked with random
 * offsets to fake a shaky hand. Returns the sequence of segment pairs.
 */
export function roughLine(
  points: Point[],
  opts: StrokeOptions = {},
): Point[][] {
  const roughness = clamp01(opts.roughness ?? 1)
  const seed = opts.seed ?? 'line'
  const rnd = makeRng(seed)
  const strokeWidth = opts.strokeWidth ?? 2
  const bowing = opts.bowing ?? 1

  if (points.length < 2) return []

  const amt = strokeWidth * 0.35 * roughness + 0.4 * roughness

  // Resample very long gaps so jitter stays granular
  const resampled: Point[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const d = dist(a, b)
    const steps = Math.max(1, Math.min(40, Math.floor(d / 12)))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      resampled.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  resampled.push(points[points.length - 1])

  // Smooth input slightly (moving average) to avoid kinks amplifying jitter
  const smooth = smoothPoints(resampled, 1)

  const jittered: Point[] = smooth.map((p, i) => {
    const prev = smooth[Math.max(0, i - 1)]
    const next = smooth[Math.min(smooth.length - 1, i + 1)]
    const jit = jitter(p, prev, next, amt * bowing, rnd)
    // occasionally drop a tiny hitch (second pass for hand feel)
    if (rnd() < 0.12 * roughness) {
      return jitter(jit, prev, next, amt * 0.6, rnd)
    }
    return jit
  })

  const segments: Point[][] = []
  if (opts.dash) {
    const [dashLen, gapLen] = opts.dash
    for (let i = 0; i + 1 < jittered.length; i++) {
      for (const [a, b] of dashSegments(jittered[i], jittered[i + 1], dashLen, gapLen)) {
        segments.push([a, b])
      }
    }
  } else {
    for (let i = 0; i + 1 < jittered.length; i++) {
      segments.push([jittered[i], jittered[i + 1]])
    }
  }
  return segments
}

function dashSegments(a: Point, b: Point, dashLen: number, gapLen: number): Point[][] {
  const total = dist(a, b)
  if (total === 0) return []
  const ux = (b.x - a.x) / total
  const uy = (b.y - a.y) / total
  const out: Point[][] = []
  let t = 0
  while (t < total) {
    const end = Math.min(t + dashLen, total)
    out.push([
      { x: a.x + ux * t, y: a.y + uy * t },
      { x: a.x + ux * end, y: a.y + uy * end },
    ])
    t = end + gapLen
  }
  return out
}

/** Move each point toward the average of its neighbors (1 pass). */
export function smoothPoints(pts: Point[], strength = 1): Point[] {
  if (pts.length < 3) return pts
  const out = pts.map((p) => ({ ...p }))
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const c = pts[i + 1]
    out[i] = {
      x: b.x + ((a.x + c.x) / 2 - b.x) * strength,
      y: b.y + ((a.y + c.y) / 2 - b.y) * strength,
    }
  }
  return out
}

/**
 * Round the corners of a closed polygon with arcs.
 * Each vertex is replaced by a quarter-ish arc (radius `radius`, clamped to
 * half the adjacent edges). Consecutive corners share the straight edge
 * between their arc endpoints, so the resulting polyline stays closed.
 */
export function roundCorners(poly: Point[], radius: number): Point[] {
  const n = poly.length
  if (n < 3 || radius <= 0) return poly.map((p) => ({ ...p }))
  const out: Point[] = []
  const ARC_STEPS = 4
  for (let i = 0; i < n; i++) {
    const cur = poly[i]
    const prev = poly[(i - 1 + n) % n]
    const next = poly[(i + 1) % n]
    const d1 = dist(cur, prev)
    const d2 = dist(cur, next)
    const r = Math.min(radius, d1 / 2, d2 / 2)
    if (r <= 0) {
      out.push({ ...cur })
      continue
    }
    const toPrev = { x: (prev.x - cur.x) / d1, y: (prev.y - cur.y) / d1 }
    const toNext = { x: (next.x - cur.x) / d2, y: (next.y - cur.y) / d2 }
    const a1 = Math.atan2(toPrev.y, toPrev.x)
    const a2 = Math.atan2(toNext.y, toNext.x)
    let diff = a2 - a1
    while (diff > Math.PI) diff -= 2 * Math.PI
    while (diff <= -Math.PI) diff += 2 * Math.PI
    // p1: point on incoming edge at distance r (start of the arc)
    out.push({ x: cur.x + Math.cos(a1) * r, y: cur.y + Math.sin(a1) * r })
    for (let s = 1; s < ARC_STEPS; s++) {
      const ang = a1 + (diff * s) / ARC_STEPS
      out.push({ x: cur.x + Math.cos(ang) * r, y: cur.y + Math.sin(ang) * r })
    }
    // p2 (arc end) is emitted as the next corner's p1 — no gap, no overlap
  }
  return out
}

/** Shrink a polygon toward its centroid (used for the inner outline pass). */
export function insetPolygon(poly: Point[], amount: number): Point[] {
  if (amount <= 0) return poly.map((p) => ({ ...p }))
  let cx = 0, cy = 0
  for (const p of poly) { cx += p.x; cy += p.y }
  cx /= poly.length
  cy /= poly.length
  return poly.map((p) => {
    const dx = p.x - cx
    const dy = p.y - cy
    const len = Math.hypot(dx, dy) || 1
    return { x: p.x - (dx / len) * amount, y: p.y - (dy / len) * amount }
  })
}

/**
 * Rough stroke for a CLOSED shape. Unlike roughLine, jitter is applied
 * per-edge with amplitude tapering to zero at both endpoints, so every
 * vertex stays exactly on its polygon corner and the loop always closes
 * (last segment ends precisely at the first point).
 *
 * Pass `cornerRadius > 0` to round corners first (see roundCorners).
 */
export function roughClosedShape(
  points: Point[],
  opts: StrokeOptions & { cornerRadius?: number } = {},
): Point[][] {
  const n = points.length
  if (n < 2) return []
  const roughness = clamp01(opts.roughness ?? 1)
  const seed = opts.seed ?? 'closed'
  const rnd = makeRng(seed)
  const strokeWidth = opts.strokeWidth ?? 2
  const cornerRadius = opts.cornerRadius ?? 0
  const bowing = opts.bowing ?? 1

  const poly = cornerRadius > 0 ? roundCorners(points, cornerRadius) : points
  const amt = (strokeWidth * 0.35 + 0.4) * roughness * bowing

  const segments: Point[][] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const d = dist(a, b)
    const steps = Math.max(1, Math.min(14, Math.round(d / 10)))
    let prevPt = a
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      // sin(π·t): 0 at both endpoints → corners stay connected, edges wobble
      const taper = Math.sin(Math.PI * t)
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      const jit = jitter(p, a, b, amt * taper, rnd)
      segments.push([prevPt, jit])
      prevPt = jit
    }
    // final point of the edge is exactly `b` (taper 0) — guaranteed closure
  }
  return segments
}

export interface RoughFill {
  /** Fill curves: list of polylines (hachure strokes). */
  lines: Point[][]
}

/**
 * Hachure / cross-hatch fill for a convex-ish polygon.
 * p0 = bounding box min, p1 = max, angle in radians.
 */
export function hachureFill(
  poly: Point[],
  opts: StrokeOptions & { angle?: number } = {},
): Point[][] {
  const seed = opts.seed ?? 'fill'
  const rnd = makeRng(seed)
  const gap = opts.hachureGap ?? 8
  const roughness = clamp01(opts.roughness ?? 1)
  const strokeWidth = opts.strokeWidth ?? 2
  const angle = opts.angle ?? -Math.PI / 4

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) + 4
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dir = { x: cos, y: sin }
  const perp = unitPerp(dir)
  const perpDot = (p: Point) => (p.x - cx) * perp.x + (p.y - cy) * perp.y

  const steps = Math.max(1, Math.floor((diag * 2) / gap))
  const lines: Point[][] = []
  for (let i = -steps; i <= steps; i++) {
    const off = (i / steps) * diag * 2
    const a: Point = {
      x: cx + dir.x * -diag + perp.x * off,
      y: cy + dir.y * -diag + perp.y * off,
    }
    const b: Point = {
      x: cx + dir.x * diag + perp.x * off,
      y: cy + dir.y * diag + perp.y * off,
    }
    const clipped = clipSegments(a, b, poly)
    for (const seg of clipped) {
      // jitter the fill stroke a little for hand feel
      const amt = (strokeWidth * 0.3 + 0.5) * roughness
      const j1 = jitter(seg[0], { x: a.x, y: a.y }, seg[1], amt, rnd)
      const j2 = jitter(seg[1], seg[0], { x: b.x, y: b.y }, amt, rnd)
      lines.push([j1, j2])
    }
  }
  return lines
}

export function crossHatchFill(
  poly: Point[],
  opts: StrokeOptions = {},
): Point[][] {
  const seed = opts.seed ?? 'cross'
  const rnd = makeRng(seed)
  const gap = opts.hachureGap ?? 10
  const roughness = clamp01(opts.roughness ?? 1)
  const strokeWidth = opts.strokeWidth ?? 2

  const pass1 = hachureFill(poly, { ...opts, angle: -Math.PI / 4, seed: seed + ':a' })
  const pass2 = hachureFill(poly, { ...opts, angle: Math.PI / 4, seed: seed + ':b' })
  const all = [...pass1, ...pass2]
  // re-jitter both passes with the SAME rng sequence for a consistent feel
  return all.map((seg) => {
    const amt = (strokeWidth * 0.3 + 0.5) * roughness
    return [
      jitter(seg[0], seg[0], seg[1], amt, rnd),
      jitter(seg[1], seg[0], seg[1], amt, rnd),
    ]
  })
}

function clipSegments(a: Point, b: Point, poly: Point[]): Point[][] {
  // simple convex-polygon clip via intersection points + midpoint test
  const { clipSegmentToPolygon } = { clipSegmentToPolygon: clipSegPoly }
  return clipSegmentToPolygon(a, b, poly)
}

function clipSegPoly(a: Point, b: Point, poly: Point[]): Point[][] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy || 1
  const ts = new Set<number>([0, 1])
  for (let i = 0; i < poly.length; i++) {
    const hit = segSegIntersection(a, b, poly[i], poly[(i + 1) % poly.length])
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
    if (pointInPoly(mid, poly)) {
      out.push([
        { x: a.x + dx * t0, y: a.y + dy * t0 },
        { x: a.x + dx * t1, y: a.y + dy * t1 },
      ])
    }
  }
  return out
}

function segSegIntersection(
  p1: Point, p2: Point, p3: Point, p4: Point,
): Point | null {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-9) return null
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { x: p1.x + t * d1x, y: p1.y + t * d1y }
}

function pointInPoly(p: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export { angleOf }
