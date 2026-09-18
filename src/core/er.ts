/**
 * ER 图（实体关系图）生成器。
 * 布局：实体在网格上排布，关系以边连接，支持 1:1 / 1:N / N:M 标注。
 */

import type { ConnectorNode } from './connectors.js'
import { routeEdgeBundle } from './edge-bundle.js'

export interface ErEntity {
  key: string
  label: string
  /** 字段列表。 */
  fields: { name: string; type?: string; key?: boolean }[]
  fill?: string
  /** 布局用尺寸（不传则按字段数自动估算）。 */
  width?: number
  height?: number
}

export interface ErRelation {
  from: string
  to: string
  /** 基数标注，如 "1" / "N" / "M"。 */
  fromCard?: string
  toCard?: string
  label?: string
  type?: 'straight' | 'orthogonal' | 'bezier'
}

export interface ErDiagram {
  width: number
  height: number
  entities: Record<string, { x: number; y: number; width: number; height: number }>
  relations: {
    from: string
    to: string
    fromCard?: string
    toCard?: string
    label?: string
    type: 'straight' | 'orthogonal' | 'bezier'
    /** 连线路径点（裁剪到实体边缘）。 */
    points: { x: number; y: number }[]
  }[]
}

export interface ErOptions {
  columnGap?: number
  rowGap?: number
  padding?: number
  fieldHeight?: number
  headerHeight?: number
}

export function planErDiagram(
  entities: ErEntity[],
  relations: ErRelation[],
  opts: ErOptions = {},
): ErDiagram {
  const { columnGap = 100, rowGap = 90, padding = 60, fieldHeight = 26, headerHeight = 40 } = opts

  const sizeOf = (e: ErEntity) => ({
    // 宽度 = 表名（居中标题）与字段行（主键图标 + 字段名 + 类型）的最大者
    w: e.width ?? Math.max(
      180,
      e.label.length * 15 + 40, // 表名 15px 字宽
      Math.max(...e.fields.map((f) => (f.key ? 20 : 0) + f.name.length * 7.5 + (f.type ? f.type.length * 7.5 + 10 : 0)), 10) + 30,
    ),
    // 高度 = 头部 + 属性列表。显式 height 若小于字段列表所需，按字段列表所需上修，
    // 避免字段溢出盒子与下一行实体重叠。
    h: Math.max(
      e.height ?? 0,
      headerHeight + e.fields.length * fieldHeight,
    ),
  })

  // 网格排布：每列宽度 = 该列实体最大宽，每行高度 = 该行实体最大高。
  // 各实体按列/行前缀和定位，保证宽窄/高低不一的实体互不重叠。
  const sizes = entities.map((e) => sizeOf(e))
  const cols = Math.max(1, Math.ceil(Math.sqrt(entities.length)))
  const colWidths = Array(cols).fill(0) as number[]
  const rowHeights: number[] = []
  entities.forEach((_, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    colWidths[col] = Math.max(colWidths[col], sizes[i].w)
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, sizes[i].h)
  })
  // 前缀和：第 c 列起始 x / 第 r 行起始 y
  const colX: number[] = [0]
  for (let c = 1; c < cols; c++) colX[c] = colX[c - 1] + colWidths[c - 1] + columnGap
  const rowY: number[] = [0]
  for (let r = 1; r < rowHeights.length; r++) rowY[r] = rowY[r - 1] + rowHeights[r - 1] + rowGap

  const rects = new Map<string, { x: number; y: number; width: number; height: number }>()
  let maxX = 0, maxY = 0
  entities.forEach((e, i) => {
    const { w, h } = sizes[i]
    const col = i % cols
    const row = Math.floor(i / cols)
    // 列内水平居中（窄实体在宽实体下方也对齐美观）
    const x = padding + colX[col] + (colWidths[col] - w) / 2
    const y = padding + rowY[row]
    rects.set(e.key, { x, y, width: w, height: h })
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  })

  // ---- 碰撞检测 + 推挤调整：任何两实体矩形相交时，把后置实体向右/向下推出 ----
  // 网格前缀和已避免常规重叠；此兜底覆盖显式 width/height 与自动估算不一致、
  // 或用户传入超大尺寸导致列内放不下等极端情况。
  const overlapOf = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => ({
    ox: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    oy: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  })
  const keys = entities.map((e) => e.key)
  for (let pass = 0; pass < 4; pass++) {
    let moved = false
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = rects.get(keys[i])!
        const b = rects.get(keys[j])!
        const { ox, oy } = overlapOf(a, b)
        if (ox <= 0 || oy <= 0) continue
        // 相交：优先向右推（保持行对齐），推不开再向下推
        if (ox < oy) {
          b.x = a.x + a.width + columnGap
          b.width = b.width // 只平移不缩放
        } else {
          b.y = a.y + a.height + rowGap
        }
        moved = true
        maxX = Math.max(maxX, b.x + b.width)
        maxY = Math.max(maxY, b.y + b.height)
      }
    }
    if (!moved) break
  }

  const nodeMap = new Map<string, ConnectorNode>()
  for (const e of entities) {
    const r = rects.get(e.key)!
    nodeMap.set(e.key, { key: e.key, shape: 'rectangle', ...r })
  }

  // 关系路由（成组路由：同侧自动错开 + 近平行线分离）
  const bundle = routeEdgeBundle(
    nodeMap,
    relations.map((rel) => ({
      from: rel.from,
      to: rel.to,
      type: (rel.type ?? 'straight') as 'straight' | 'orthogonal' | 'bezier',
      arrow: 'none',
    })),
  )
  const routedMap = new Map(bundle.edges.map((e) => [`${e.from}->${e.to}`, e]))

  const outRelations = relations.map((rel) => {
    const t = (rel.type ?? 'straight') as 'straight' | 'orthogonal' | 'bezier'
    const routed = routedMap.get(`${rel.from}->${rel.to}`)
    return {
      from: rel.from,
      to: rel.to,
      fromCard: rel.fromCard,
      toCard: rel.toCard,
      label: rel.label,
      type: t,
      points: routed?.points ?? [],
    }
  })

  const entitiesOut: ErDiagram['entities'] = {}
  for (const e of entities) {
    entitiesOut[e.key] = rects.get(e.key)!
  }

  return { width: maxX + padding, height: maxY + padding, entities: entitiesOut, relations: outRelations }
}
