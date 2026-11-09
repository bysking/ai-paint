/**
 * ER 图（实体关系图）生成器。
 * 布局：实体在网格上排布，关系以边连接，支持 1:1 / 1:N / N:M 标注。
 */

import type { ConnectorNode, Side } from './connectors.js'
import { pickSide } from './connectors.js'
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
  /** 连线类型。默认 orthogonal（直连斜线会穿过中间的实体）。 */
  type?: 'straight' | 'orthogonal' | 'bezier'
  /** 显式指定起/终侧（不传则按几何相对位置推断）。 */
  fromSide?: 'top' | 'bottom' | 'left' | 'right'
  toSide?: 'top' | 'bottom' | 'left' | 'right'
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
    /** 路径命令（曲线类型用；渲染层复用，避免重算）。 */
    pathD: string
    fromSide: 'top' | 'bottom' | 'left' | 'right'
    toSide: 'top' | 'bottom' | 'left' | 'right'
    /** 起点侧接触点与切入角（ER 端标记绘制用）。 */
    fromTip: { x: number; y: number }
    fromAngle: number
    /** 箭头尖端（=终点侧接触点）与切入角。 */
    arrowTip: { x: number; y: number }
    arrowAngle: number
  }[]
}

export interface ErOptions {
  columnGap?: number
  rowGap?: number
  padding?: number
  fieldHeight?: number
  headerHeight?: number
  /**
   * 桩点按几何相对位置选（默认 true），而不是按分层图的主方向语义。
   *
   * 分层图（TB）里「优先走上下边」是对的，但 ER 实体是网格排布：两个实体
   * 若横向并排、纵向几乎同高，主方向语义会强行让连线走底边出、顶边进，
   * 绕出一个大 U 型，而几何就近选择本可以是一条直线。ER 的入/出端由
   * 「谁在上面、谁在下面、谁在左右」直接决定才是最自然的。
   */
  sideByGeometry?: boolean
  /**
   * 关系线默认类型（单条 relation 的 type 优先）。默认 'orthogonal'：
   * 网格里两个实体常被其它实体隔开，直连斜线会横穿过去；正交走线会绕开。
   */
  defaultRelationType?: 'straight' | 'orthogonal' | 'bezier'
}

/** 节点四边中心（回退用；缺 rect 时给一个安全值）。 */
function centerOf(n: ConnectorNode | undefined): { x: number; y: number } {
  if (!n) return { x: 0, y: 0 }
  return { x: n.x + n.width / 2, y: n.y + n.height / 2 }
}

/**
 * ER 网格里的桩点选择（一次给出两端，保证互补）。
 *
 * 为什么不能直接用分层图的 pickSide：那是「TB → 优先上下边」的主方向语义，
 * 在网格布局里，横向并排的两张表会被强行要求走底边出、顶边进，绕出一个大 U 型；
 * 而它们本可以是一条水平直线（ER 里最常见的 1:N 相邻表就是这个形态）。
 *
 * 规则（按优先级）：
 *   1. 两实体在 x 方向投影重叠（上下堆叠）→ 竖直连接（下出上入）；
 *   2. 两实体在 y 方向投影重叠（左右并排）→ 水平连接（右出左入）；
 *   3. 斜对角（两个方向都不重叠）→ 取中心位移较大的轴。
 * 前两条让「同列/同行的相邻实体」拿到一条完美直线，不再有绕行。
 */
function pickErSides(
  from: { x: number; y: number; width: number; height: number } | undefined,
  to: { x: number; y: number; width: number; height: number } | undefined,
): { fromSide: Side; toSide: Side } {
  if (!from || !to) return { fromSide: 'right', toSide: 'left' }
  const xOverlap = Math.min(from.x + from.width, to.x + to.width) - Math.max(from.x, to.x)
  const yOverlap = Math.min(from.y + from.height, to.y + to.height) - Math.max(from.y, to.y)

  // 上下堆叠 → 竖直
  if (xOverlap > 0 && yOverlap <= 0) {
    return to.y >= from.y ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' }
  }
  // 左右并排 → 水平
  if (yOverlap > 0 && xOverlap <= 0) {
    return to.x >= from.x ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' }
  }
  // 斜对角：取中心位移较大的轴
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' }
  }
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' }
}

export function planErDiagram(
  entities: ErEntity[],
  relations: ErRelation[],
  opts: ErOptions = {},
): ErDiagram {
  const {
    columnGap = 100,
    rowGap = 90,
    padding = 60,
    fieldHeight = 26,
    headerHeight = 40,
    sideByGeometry = true,
    defaultRelationType = 'orthogonal',
  } = opts

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

  // 关系路由（成组路由：同侧自动错开 + 近平行线分离 + 正交避障）。
  // 关键点：
  //   1. type 默认 orthogonal —— 网格里两实体常被别的实体隔开，直连斜线会穿过去；
  //   2. 显式传 fromSide/toSide —— routeEdgeBundle 默认按「分层主方向」选边
  //      （TB → 优先上下边），ER 是网格，应按几何就近选边，否则横向并排的两个
  //      实体会绕出大 U 型；
  //   3. 障碍物 = 全部实体（排除两端）—— 正交路由据此绕开中间实体。
  const relationsMeta = relations.map((rel) => {
    const from = rects.get(rel.from)
    const to = rects.get(rel.to)
    // sideByGeometry=false → 退回分层图主方向语义（TB 优先上下边）
    const sides = sideByGeometry && from && to
      ? pickErSides(from, to)
      : (() => {
          const fc = from ? { x: from.x + from.width / 2, y: from.y + from.height / 2 } : { x: 0, y: 0 }
          const tc = to ? { x: to.x + to.width / 2, y: to.y + to.height / 2 } : { x: 0, y: 0 }
          return { fromSide: pickSide(fc, tc, 'TB'), toSide: pickSide(tc, fc, 'TB') }
        })()
    return {
      rel,
      type: (rel.type ?? defaultRelationType) as 'straight' | 'orthogonal' | 'bezier',
      fromSide: rel.fromSide ?? sides.fromSide,
      toSide: rel.toSide ?? sides.toSide,
    }
  })

  const allNodes = [...nodeMap.values()]
  const bundle = routeEdgeBundle(
    nodeMap,
    relationsMeta.map((m) => ({
      from: m.rel.from,
      to: m.rel.to,
      type: m.type,
      arrow: 'none',
      // ER 网格：桩点按几何就近（显式 fromSide/toSide），不走分层主方向语义
      direction: 'LR' as const,
      fromSide: m.fromSide,
      toSide: m.toSide,
      // 注意：这里不能传 minBends —— 相邻实体的直线/2 段路径是最优解，
      // 强制 ≥3 段会把它们变成绕行的大 U 型。正交避障本身就保证不穿实体。
    })),
    {
      // 中间实体作为障碍，正交线绕开而不是穿过去
      extraObstaclesFor: (fromKey, toKey) =>
        allNodes.filter((n) => n.key !== fromKey && n.key !== toKey),
    },
  )
  const routedMap = new Map(bundle.edges.map((e) => [`${e.from}->${e.to}`, e]))

  const outRelations = relations.map((rel, i) => {
    const meta = relationsMeta[i]
    const routed = routedMap.get(`${rel.from}->${rel.to}`)
    return {
      from: rel.from,
      to: rel.to,
      fromCard: rel.fromCard,
      toCard: rel.toCard,
      label: rel.label,
      type: meta.type,
      points: routed?.points ?? [],
      pathD: routed?.pathD ?? '',
      fromSide: routed?.fromSide ?? meta.fromSide,
      toSide: routed?.toSide ?? meta.toSide,
      fromTip: routed?.fromTip ?? routed?.points[0] ?? { x: 0, y: 0 },
      fromAngle: routed?.fromAngle ?? 0,
      arrowTip: routed?.arrowTip ?? routed?.points[routed.points.length - 1] ?? { x: 0, y: 0 },
      arrowAngle: routed?.arrowAngle ?? 0,
    }
  })

  const entitiesOut: ErDiagram['entities'] = {}
  for (const e of entities) {
    entitiesOut[e.key] = rects.get(e.key)!
  }

  return { width: maxX + padding, height: maxY + padding, entities: entitiesOut, relations: outRelations }
}
