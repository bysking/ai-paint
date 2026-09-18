import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roughClosedShape, roundCorners, roughLine, hachureFill, crossHatchFill } from '../dist/core/rough.js'
import { dist } from '../dist/core/geometry.js'

test('roughClosedShape 保证闭合：每个顶点都被线段端点命中', () => {
  const rect = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ]
  const segs = roughClosedShape(rect, { seed: 't1', roughness: 1.2, strokeWidth: 2 })
  for (const v of rect) {
    const hit = segs.some(
      ([a, b]) =>
        (Math.abs(a.x - v.x) < 1e-6 && Math.abs(a.y - v.y) < 1e-6) ||
        (Math.abs(b.x - v.x) < 1e-6 && Math.abs(b.y - v.y) < 1e-6),
    )
    assert.ok(hit, `顶点 (${v.x},${v.y}) 未被任何线段端点命中`)
  }
})

test('roundCorners 消除直角尖角', () => {
  const rect = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ]
  const rounded = roundCorners(rect, 12)
  // 圆角后的多边形不应包含原始尖角点
  const hasSharp = rounded.some(
    (p) =>
      (p.x === 0 && p.y === 0) ||
      (p.x === 100 && p.y === 0) ||
      (p.x === 100 && p.y === 60) ||
      (p.x === 0 && p.y === 60),
  )
  assert.equal(hasSharp, false)
  assert.ok(rounded.length > rect.length, '圆角后点数应增加')
})

test('roughLine 抖动范围受 roughness 控制', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0 },
  ]
  const low = roughLine(pts, { seed: 's', roughness: 0.1, strokeWidth: 2 })
  const high = roughLine(pts, { seed: 's', roughness: 2, strokeWidth: 2 })
  const maxDev = (segs) =>
    Math.max(...segs.map(([a, b]) => Math.max(Math.abs(a.y), Math.abs(b.y))))
  assert.ok(maxDev(high) >= maxDev(low), 'roughness 大 → 抖动更大')
})

test('hachureFill 生成的填充线都落在多边形内', () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ]
  const lines = hachureFill(poly, { seed: 'f', roughness: 1 })
  assert.ok(lines.length > 3, '应有若干填充线')
  for (const [a, b] of lines) {
    assert.ok(a.x >= -1 && a.x <= 101 && a.y >= -1 && a.y <= 61, '填充线应在边界内')
    assert.ok(b.x >= -1 && b.x <= 101 && b.y >= -1 && b.y <= 61, '填充线应在边界内')
  }
})

test('crossHatchFill 双方向', () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 80, y: 40 },
    { x: 0, y: 40 },
  ]
  const lines = crossHatchFill(poly, { seed: 'x', roughness: 1 })
  // 至少两组方向（正负 45°）
  const angles = new Set(lines.map(([a, b]) => Math.round(Math.atan2(b.y - a.y, b.x - a.x) * 100)))
  assert.ok(angles.size >= 2, 'cross-hatch 应有多个方向')
})

test('确定性：相同 seed 产生相同抖动', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 5 },
    { x: 30, y: 0 },
  ]
  const a = roughLine(pts, { seed: 'det', roughness: 1 })
  const b = roughLine(pts, { seed: 'det', roughness: 1 })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('dist 距离计算', () => {
  assert.equal(dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
})
