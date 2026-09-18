/**
 * 多形状图元：在矩形/椭圆/菱形基础上扩展常见图形。
 * 每个形状返回一组“顶点多边形”（供 rough 描边与填充复用），
 * 以及可选的辅助绘制（如圆柱的椭圆顶盖、actor 的头/身体线）。
 *
 * 形状语义沿用 Excalidraw 风格：x/y 为外接盒左上角，width/height 为外接盒尺寸。
 */

import type { Point } from './geometry.ts'

export type ShapeType =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'rounded-rectangle'
  | 'cylinder'
  | 'parallelogram'
  | 'trapezoid'
  | 'triangle'
  | 'note'
  | 'star'
  | 'hexagon'
  | 'pentagon'
  | 'arrow-right'
  | 'arrow-left'
  | 'double-arrow'
  | 'actor'
  | 'interface'
  | 'document'
  | 'cloud'
  | 'cross'
  | 'heart'

export const SHAPE_TYPES: ShapeType[] = [
  'rectangle', 'rounded-rectangle', 'ellipse', 'diamond', 'triangle', 'cylinder',
  'parallelogram', 'trapezoid', 'note', 'star', 'hexagon', 'pentagon', 'arrow-right',
  'arrow-left', 'double-arrow', 'actor', 'interface', 'document', 'cloud', 'cross', 'heart',
]

export interface ShapeGeometry {
  /** 主轮廓多边形（闭合，供 rough 描边 / 填充）。 */
  outline: Point[]
  /** 附加辅助图形（如圆柱顶盖椭圆、actor 头部圆）。polygon/ellipse 渲染为填充；stroke 渲染为描边折线。 */
  extras?: {
    kind: 'polygon' | 'ellipse' | 'stroke'
    points?: Point[]
    cx?: number
    cy?: number
    rx?: number
    ry?: number
  }[]
}

function R(box: { x: number; y: number; width: number; height: number }): number {
  return Math.min(12, box.width / 2, box.height / 2)
}

export function shapeGeometry(shape: ShapeType, box: { x: number; y: number; width: number; height: number }): ShapeGeometry {
  const { x, y, width: w, height: h } = box
  const cx = x + w / 2
  const cy = y + h / 2

  switch (shape) {
    case 'rectangle':
    case 'rounded-rectangle':
      return {
        outline: [
          { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
        ],
      }
    case 'ellipse':
      return { outline: ellipsePoints(cx, cy, w / 2, h / 2) }
    case 'diamond':
      return {
        outline: [
          { x: cx, y }, { x: x + w, y: cy }, { x: cx, y: y + h }, { x, y: cy },
        ],
      }
    case 'triangle':
      return {
        outline: [
          { x: cx, y }, { x: x + w, y: y + h }, { x, y: y + h },
        ],
      }
    case 'cylinder': {
      const r = w / 2
      const ry = Math.max(4, Math.min(h * 0.2, r * 0.35))
      const yTop = cy - h / 2
      const yBot = cy + h / 2
      // 外轮廓（标准圆柱侧影）：
      //   左侧直线（下 → 上）→ 顶盖上半椭圆（左角 → 顶部 → 右角，向上凸）
      //   → 右侧直线（上 → 下）→ 底盖下半椭圆（右角 → 底部 → 左角，向下凸）
      // 四角严格落在 box 角点，无对角跳变。
      const outline: Point[] = []
      const N = 12
      outline.push({ x, y: yBot }, { x, y: yTop })
      for (let i = 0; i <= N; i++) {
        const t = Math.PI - (i / N) * Math.PI // π → 0（左 → 右）
        outline.push({ x: cx + r * Math.cos(t), y: yTop - ry * Math.sin(t) })
      }
      outline.push({ x: x + w, y: yBot })
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI // 0 → π（右 → 左）
        outline.push({ x: cx + r * Math.cos(t), y: yBot + ry * Math.sin(t) })
      }
      // 顶盖椭圆用于填充
      return { outline, extras: [{ kind: 'ellipse', cx, cy: yTop, rx: r, ry }] }
    }
    case 'parallelogram': {
      const off = Math.min(w * 0.2, h * 0.6)
      return {
        outline: [
          { x: x + off, y }, { x: x + w, y }, { x: x + w - off, y: y + h }, { x, y: y + h },
        ],
      }
    }
    case 'trapezoid':
      return {
        outline: [
          { x: x + w * 0.15, y }, { x: x + w * 0.85, y }, { x: x + w, y: y + h }, { x, y: y + h },
        ],
      }
    case 'note': {
      const fold = Math.min(w * 0.25, h * 0.4)
      return {
        outline: [
          { x, y }, { x: x + w - fold, y }, { x: x + w, y: y + fold },
          { x: x + w, y: y + h }, { x, y: y + h },
        ],
        extras: [
          {
            kind: 'polygon',
            points: [
              { x: x + w - fold, y }, { x: x + w, y: y + fold }, { x: x + w - fold, y: y + fold },
            ],
          },
        ],
      }
    }
    case 'star': {
      const outer = (i: number) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 10
        return { x: cx + (w / 2) * Math.cos(a), y: cy + (h / 2) * Math.sin(a) }
      }
      const inner = (i: number) => {
        const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / 10
        return { x: cx + (w * 0.38) * Math.cos(a), y: cy + (h * 0.38) * Math.sin(a) }
      }
      const outline: Point[] = []
      for (let i = 0; i < 10; i++) {
        outline.push(i % 2 === 0 ? outer(i / 2) : inner(Math.floor(i / 2)))
      }
      return { outline }
    }
    case 'hexagon':
      return {
        outline: [
          { x: x + w * 0.25, y }, { x: x + w * 0.75, y },
          { x: x + w, y: cy }, { x: x + w * 0.75, y: y + h },
          { x: x + w * 0.25, y: y + h }, { x, y: cy },
        ],
      }
    case 'pentagon':
      return {
        outline: [
          { x: cx, y },
          { x: x + w, y: y + h * 0.36 },
          { x: x + w * 0.78, y: y + h },
          { x: x + w * 0.22, y: y + h },
          { x, y: y + h * 0.36 },
        ],
      }
    case 'arrow-right':
    case 'arrow-left':
    case 'double-arrow': {
      const dir = shape === 'arrow-left' ? -1 : 1
      const head = Math.min(w * 0.35, h * 0.5)
      const tail = Math.min(w * 0.15, h * 0.3)
      const leftHead = shape === 'arrow-left' || shape === 'double-arrow'
      const rightHead = shape === 'arrow-right' || shape === 'double-arrow'
      const pts: Point[] = []
      if (leftHead) pts.push({ x: x + head, y }, { x: x, y: cy }, { x: x + head, y: y + h })
      else pts.push({ x: x + tail, y }, { x, y: cy }, { x: x + tail, y: y + h })
      pts.push(
        { x: x + w - head, y: y + h },
        { x: x + w, y: cy },
        { x: x + w - head, y },
      )
      if (!rightHead) pts.push({ x: x + w - tail, y })
      // 修正顺序：保证多边形顺序一致（从左上角开始逆时针）
      const startIdx = pts.findIndex((p) => p.x === (leftHead ? x + head : x + tail) && p.y === y)
      const ordered = [...pts.slice(startIdx), ...pts.slice(0, startIdx)]
      void dir
      return { outline: ordered }
    }
    case 'actor': {
      // UML actor：头圆（可填充）+ 身体线条（肩线/躯干/腿）
      const headR = Math.min(w * 0.24, h * 0.14)
      const neckY = y + headR * 2
      const bodyTop = neckY + headR * 0.6
      const bodyBot = y + h
      const bodyH = Math.max(10, bodyBot - bodyTop)
      const shoulder = headR * 1.5
      const hipY = bodyTop + bodyH * 0.5
      const legSpread = headR * 1.1
      return {
        outline: ellipsePoints(cx, y + headR, headR, headR),
        extras: [
          // 肩线 / 躯干 / 双腿（描边折线）
          { kind: 'stroke', points: [{ x: cx - shoulder, y: bodyTop }, { x: cx + shoulder, y: bodyTop }] },
          { kind: 'stroke', points: [{ x: cx, y: bodyTop }, { x: cx, y: hipY }] },
          { kind: 'stroke', points: [{ x: cx, y: hipY }, { x: cx - legSpread, y: bodyBot }] },
          { kind: 'stroke', points: [{ x: cx, y: hipY }, { x: cx + legSpread, y: bodyBot }] },
        ],
      }
    }
    case 'interface':
      return {
        outline: [
          { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
        ],
      }
    case 'document': {
      // 左侧波浪卷边
      const wave = (t: number) => {
        const xx = x + w * 0.08 * Math.sin(t * Math.PI * 2)
        const yy = y + t * h
        return { x: xx, y: yy }
      }
      const outline: Point[] = [
        { x, y }, { x: x + w, y },
        { x: x + w, y: y + h }, { x: x + w * 0.15, y: y + h },
      ]
      for (let i = 1; i < 6; i++) {
        const p = wave(i / 6)
        outline.push(p)
      }
      outline.push({ x: x + w * 0.08, y }, { x: x + w * 0.1, y })
      return { outline }
    }
    case 'cloud': {
      const outline: Point[] = []
      const lobes = 6
      const step = (2 * Math.PI) / lobes
      const rx = w / 2
      const ry = h / 2
      for (let i = 0; i < lobes; i++) {
        const a0 = i * step
        const a1 = a0 + step
        const r0 = i % 2 === 0 ? rx * 1.1 : rx * 0.75
        const r1 = i % 2 === 0 ? rx * 0.75 : rx * 1.1
        const n = 6
        for (let j = 0; j < n; j++) {
          const t = j / n
          const a = a0 + (a1 - a0) * t
          const r = r0 + (r1 - r0) * t
          outline.push({ x: cx + r * Math.cos(a), y: cy + ry * Math.sin(a) * (r / rx) })
        }
      }
      return { outline }
    }
    case 'cross': {
      const tw = w * 0.28
      const th = h * 0.28
      return {
        outline: [
          { x: cx - tw / 2, y },
          { x: cx + tw / 2, y },
          { x: cx + tw / 2, y: cy - th / 2 },
          { x: x + w, y: cy - th / 2 },
          { x: x + w, y: cy + th / 2 },
          { x: cx + tw / 2, y: cy + th / 2 },
          { x: cx + tw / 2, y: y + h },
          { x: cx - tw / 2, y: y + h },
          { x: cx - tw / 2, y: cy + th / 2 },
          { x, y: cy + th / 2 },
          { x, y: cy - th / 2 },
          { x: cx - tw / 2, y: cy - th / 2 },
        ],
      }
    }
    case 'heart': {
      const outline: Point[] = []
      const n = 40
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2
        // 心形参数方程（缩放至 box）
        const sx = 16 * Math.sin(t) ** 3
        const sy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
        outline.push({
          x: cx + (sx / 17) * (w / 2),
          y: cy - (sy / 16) * (h / 2) - h * 0.05,
        })
      }
      return { outline }
    }
    default:
      return {
        outline: [
          { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
        ],
      }
  }
}

/** 圆角矩形辅助（供渲染层在 rounded-rectangle 上做柔和圆角）。 */
export function roundedBoxPoints(box: { x: number; y: number; width: number; height: number }, radius: number): Point[] {
  const r = Math.min(radius, box.width / 2, box.height / 2)
  const { x, y, width: w, height: h } = box
  const pts: Point[] = []
  const steps = 4
  const corners: [number, number, number][] = [
    [x + r, y, 0],
    [x + w, y, Math.PI / 2],
    [x + w, y + h, Math.PI],
    [x, y + h, (3 * Math.PI) / 2],
  ]
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i < steps; i++) {
      const a = a0 + (i / steps) * (Math.PI / 2)
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
    }
  }
  return pts
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Point[] {
  const pts: Point[] = []
  const steps = 48
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) })
  }
  return pts
}
