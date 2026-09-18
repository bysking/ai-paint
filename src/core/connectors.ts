/**
 * 连接线系统（参考 AntV X6 的 edge 类型）：
 *   - straight     直线
 *   - orthogonal   正交折线（曼哈顿走线）
 *   - bezier       三次贝塞尔（平滑 S 形）
 *   - smooth       多点平滑曲线（Catmull-Rom → 贝塞尔）
 *   - arc          弧线（两点间大圆弧）
 *
 * 连接点规则：
 *   - 连接点锚定到节点【边线中心】（上/下/左/右四方向），而非任意轮廓交点
 *   - 多连线从同一边出发时自动【扇出错开】（沿边线中心向两侧展开，间距 ≥ EDGE_SPACING）
 *   - 平行且相近的连线自动【合并判断】：过近则用贝塞尔曲线弯曲错开，避免两条线贴在一起
 *
 * 支持箭头（triangle / circle / diamond / none）与虚线。
 */

import type { Point } from './geometry.js'
import { dist, distToSegment } from './geometry.js'
import type { ShapeType } from './shapes.js'
import { shapeGeometry } from './shapes.js'

export type EdgeType = 'straight' | 'orthogonal' | 'bezier' | 'smooth' | 'arc'
export type ArrowHead = 'none' | 'triangle' | 'circle' | 'diamond'
export type Side = 'top' | 'bottom' | 'left' | 'right'

export interface ConnectorNode {
  key: string
  shape: ShapeType
  x: number
  y: number
  width: number
  height: number
}

export interface Connector {
  from: string
  to: string
  type?: EdgeType
  dashed?: boolean
  label?: string
  arrow?: ArrowHead | boolean
}

export interface RoutedEdge {
  from: string
  to: string
  type: EdgeType
  dashed: boolean
  label?: string
  arrow: ArrowHead
  /** 裁剪后的路径点（用于 polyline / 贝塞尔控制点）。 */
  points: Point[]
  /** 路径命令（供 SVG path 直接使用）。 */
  pathD: string
  /** 起止边（top/bottom/left/right），供合并判断。 */
  fromSide: Side
  toSide: Side
  /** 箭头尖端（节点边线上，箭头主体在外侧不压边）。 */
  arrowTip: Point
  arrowAngle: number
  /** 起点侧接触点与切入角（供 ER 连线端标记绘制）。 */
  fromTip: Point
  fromAngle: number
}

export const EDGE_SPACING = 14
export const ARROW_GAP = 6

/** 判断矩形是否与某水平/垂直线段相交（含边界，用于正交避障）。 */
function segmentIntersectsRect(
  a: Point,
  b: Point,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  const pad = 4 // 避障余量
  return (
    rect.x + rect.width > minX - pad &&
    rect.x < maxX + pad &&
    rect.y + rect.height > minY - pad &&
    rect.y < maxY + pad
  )
}

/** 正交避障路由：
 * - 同行/同列 → 直线（2 段）
 * - 否则：L 型（2 段）或 U/Z 型（≥3 段）通道绕行
 * @param fromSide 起点所在边（top/bottom/left/right），用于优先"沿锚点法向出发"的 L 型
 * @param toSide   终点所在边
 * @param minBends 最少转折数（0 = 允许 L 型；≥1 = 强制 ≥3 段 U/Z 型路由，架构图风格）
 * @param channelShift 通道偏移量：同走廊的多条边按此值错开中间通道，避免长段重叠
 */
function routeOrthogonalAvoid(
  from: Point,
  to: Point,
  obstacles: ConnectorNode[],
  excludeKeys: string[],
  fromSide?: Side,
  toSide?: Side,
  minBends = 0,
  channelShift = 0,
): Point[] {
  const obs = obstacles.filter((n) => !excludeKeys.includes(n.key))
  const blocked = (a: Point, b: Point) =>
    obs.some((n) => segmentIntersectsRect(a, b, n))

  const preferVert = fromSide === 'top' || fromSide === 'bottom'
  const preferHoriz = fromSide === 'left' || fromSide === 'right'

  // 同行/同列：直接直线（避免 L 型产生零长度段）。
  // 对齐边的锚点由槽位分配归中（slot 0），两端严格对齐；容差只覆盖浮点抖动。
  // 注意：不能用过大的容差——槽位扇出会使非对齐锚点差达 EDGE_SPACING，
  // 过宽容差会把本应正交绕行的边误判为"对齐"而画成斜线。
  if (Math.abs(from.y - to.y) < 1.5 || Math.abs(from.x - to.x) < 1.5) {
    if (!blocked(from, to)) return [from, to]
  }

  // L 型两种方案：l1 = 先水平后垂直，l2 = 先垂直后水平（各 2 段）
  const l1 = [from, { x: to.x, y: from.y }, to]
  const l2 = [from, { x: from.x, y: to.y }, to]
  const ok1 = !blocked(l1[0], l1[1]) && !blocked(l1[1], l1[2])
  const ok2 = !blocked(l2[0], l2[1]) && !blocked(l2[1], l2[2])
  if (minBends < 1 && (ok1 || ok2)) {
    // 优先选"首段沿锚点边法向"的方案：
    //   fromSide = left/right → 先水平（l1）；top/bottom → 先垂直（l2）
    // 若首选方案不通，再用另一个
    if (preferHoriz && ok1) return l1
    if (preferVert && ok2) return l2
    if (ok1) return l1
    if (ok2) return l2
  }

  // 收集候选"水平通道" y：起点 y、终点 y、每个障碍的上方/下方（±gap）
  const gap = 24
  const candidatesY = new Set<number>([from.y, to.y])
  for (const n of obs) {
    candidatesY.add(n.y - gap)
    candidatesY.add(n.y + n.height + gap)
  }
  // 障碍之间的空隙中点也加入候选
  const sortedY = obs
    .flatMap((n) => [n.y, n.y + n.height])
    .sort((a, b) => a - b)
  for (let i = 0; i < sortedY.length - 1; i++) {
    if (sortedY[i + 1] - sortedY[i] > gap * 2) {
      candidatesY.add((sortedY[i] + sortedY[i + 1]) / 2)
    }
  }

  // 对每个候选通道 y：检查 from→(x,y) 竖直段、水平段 (fromX→toX at y)、
  // (to.x,y)→to 竖直段 是否都避开障碍；
  // 排序优先"贴近终点行"的通道（= 最短路径优先，避免绕远到模块上方）
  const dirX = to.x > from.x ? 1 : -1
  const channelScoreY = (y: number) => Math.abs(y - to.y)
  for (const y of [...candidatesY].sort((a, b) => channelScoreY(a) - channelScoreY(b))) {
    // 同一走廊的多条边按 channelShift 错开中间水平段（避免平行边重叠）
    const cy = y + channelShift
    // minBends 模式：跳过会退化成 L 型/直线的通道（y 与起点或终点同行）
    if (minBends >= 1 && (Math.abs(y - from.y) < 0.5 || Math.abs(y - to.y) < 0.5)) continue
    const c1 = { x: from.x, y: cy }
    const c2 = { x: to.x, y: cy }
    const seg1 = !blocked(from, c1) // 竖直
    const seg2 = !blocked(c1, c2) // 水平
    const seg3 = !blocked(c2, to) // 竖直
    if (seg1 && seg2 && seg3) {
      return [from, c1, c2, to]
    }
  }

  // 再尝试"垂直通道" x：from 与 to 若 x 接近，用 x 通道先竖再横再竖
  const candidatesX = new Set<number>([from.x, to.x])
  for (const n of obs) {
    candidatesX.add(n.x - gap)
    candidatesX.add(n.x + n.width + gap)
  }
  const sortedX = obs
    .flatMap((n) => [n.x, n.x + n.width])
    .sort((a, b) => a - b)
  for (let i = 0; i < sortedX.length - 1; i++) {
    if (sortedX[i + 1] - sortedX[i] > gap * 2) {
      candidatesX.add((sortedX[i] + sortedX[i + 1]) / 2)
    }
  }
  const dirY = to.y > from.y ? 1 : -1
  const channelScoreX = (x: number) => Math.abs(x - to.x)
  for (const x of [...candidatesX].sort((a, b) => channelScoreX(a) - channelScoreX(b))) {
    // minBends 模式：跳过会退化成 L 型/直线的通道（x 与起点或终点同列）
    if (minBends >= 1 && (Math.abs(x - from.x) < 0.5 || Math.abs(x - to.x) < 0.5)) continue
    const c1 = { x, y: from.y }
    const c2 = { x, y: to.y }
    const seg1 = !blocked(from, c1) // 水平
    const seg2 = !blocked(c1, c2) // 竖直
    const seg3 = !blocked(c2, to) // 水平
    if (seg1 && seg2 && seg3) {
      return [from, c1, c2, to]
    }
  }

  // 兜底：先横向让开再找通道（Z 字）
  const z = [
    from,
    { x: from.x + dirX * gap, y: from.y },
    { x: from.x + dirX * gap, y: to.y },
    { x: to.x - dirX * gap, y: to.y },
    to,
  ]
  let ok = true
  for (let i = 0; i < z.length - 1; i++) {
    if (blocked(z[i], z[i + 1])) { ok = false; break }
  }
  if (ok) return z
  // 最终兜底：minBends 模式下绝不允许 L 型（贴边），退而求其次用"先竖让开再绕"的 5 点路径
  if (minBends >= 1) {
    const z2 = [
      from,
      { x: from.x, y: from.y + (to.y > from.y ? gap : -gap) },
      { x: from.x + dirX * gap * 2, y: from.y + (to.y > from.y ? gap : -gap) },
      { x: from.x + dirX * gap * 2, y: to.y },
      to,
    ]
    let ok2 = true
    for (let i = 0; i < z2.length - 1; i++) {
      if (blocked(z2[i], z2[i + 1])) { ok2 = false; break }
    }
    if (ok2) return z2
    return z // 实在不行用 Z 字（仍 ≥3 段）
  }
  return preferVert ? l2 : l1
}

/** 节点四边中心点。 */
export function sideCenters(node: ConnectorNode): Record<Side, Point> {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const m = EDGE_SPACING / 2
  return {
    top: { x: cx, y: node.y + m },
    bottom: { x: cx, y: node.y + node.height - m },
    left: { x: node.x + m, y: cy },
    right: { x: node.x + node.width - m, y: cy },
  }
}

/** 判断两点连线应使用哪条边（上/下/左/右）作为连接边。 */
export function pickSide(fromCenter: Point, toCenter: Point): Side {
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (adx >= ady) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/** 菱形出边分支：是（主方向继续）/ 否（侧向分支）/ 未知。 */
export type DiamondBranch = 'yes' | 'no' | undefined

/**
 * 回边目标入点：选【垂直主布局方向】的侧，从侧面绕入不穿主链。
 *   TB（主方向上下）→ 进目标 left/right，选离源更远的那侧
 *   LR（主方向左右）→ 进目标 top/bottom，同理
 * @param sourceCenter 源（回边起点）中心
 * @param targetCenter 目标（回边终点）中心
 */
export function backedgeEntrySide(
  sourceCenter: { x: number; y: number },
  targetCenter: { x: number; y: number },
  direction: 'LR' | 'TB',
): Side {
  if (direction === 'TB') {
    return sourceCenter.x < targetCenter.x ? 'left' : 'right'
  }
  return sourceCenter.y < targetCenter.y ? 'top' : 'bottom'
}

/**
 * 回边源出点：选【垂直主布局方向】的侧，且与目标入点同侧（右出右拐 / 左出左拐）。
 *   TB → 从源 left/right 出，与目标入侧对称（目标在右 → 源右出）
 *   LR → 从源 top/bottom 出，同理
 */
export function backedgeExitSide(
  sourceCenter: { x: number; y: number },
  targetCenter: { x: number; y: number },
  direction: 'LR' | 'TB',
): Side {
  if (direction === 'TB') {
    return targetCenter.x < sourceCenter.x ? 'left' : 'right'
  }
  return targetCenter.y < sourceCenter.y ? 'top' : 'bottom'
}

/**
 * 形状感知的锚点边选择。
 * 菱形（决策节点）按布局方向连接：
 *   - 进边：TB（上→下）→ 从 top 进入；LR（左→右）→ 从 left 进入
 *   - 出边：
 *       TB：是 → bottom（向下继续主流程）；否 → right（侧向分支）
 *       LR：是 → right（向右继续主流程）；否 → bottom（侧向分支）
 *   无分支标记时用几何兜底（主方向前进走主桩点，其余走侧向）。
 * @param isFrom true = 从该节点出，false = 进该节点
 * @param direction 布局方向（TB 上→下 / LR 左→右），默认 TB
 * @param branch 菱形出边的分支标记（是/否）
 */
export function pickSideForShape(
  node: ConnectorNode,
  other: ConnectorNode,
  isFrom: boolean,
  fallback: Side,
  direction: 'LR' | 'TB' = 'TB',
  branch?: DiamondBranch,
): Side {
  if (node.shape !== 'diamond') return fallback
  const nc = { x: node.x + node.width / 2, y: node.y + node.height / 2 }
  const oc = { x: other.x + other.width / 2, y: other.y + other.height / 2 }
  // 进菱形：从主方向上游进入
  if (!isFrom) return direction === 'TB' ? 'top' : 'left'
  // 出菱形：按分支 + 布局方向分配桩点
  if (direction === 'TB') {
    // 主方向向下
    if (branch === 'yes') return 'bottom' // 是 → 向下继续
    if (branch === 'no') return 'right' // 否 → 侧向
    // 无标记：目标在下方 → 主桩点；目标偏左/偏右 → 侧向
    return oc.y >= nc.y - 1 ? 'bottom' : oc.x < nc.x ? 'left' : 'right'
  }
  // LR：主方向向右
  if (branch === 'yes') return 'right' // 是 → 向右继续
  if (branch === 'no') return 'bottom' // 否 → 侧向
  return oc.x >= nc.x - 1 ? 'right' : oc.y < nc.y ? 'top' : 'bottom'
}

/** 节点边线中心的实际连接点（按边 + 该边上已用的索引偏移错开）。
 * 连接点停在边线【外侧】ARROW_GAP（默认 6px），让箭头主体不压节点边线；
 * 箭头尖端恰好触边（由 render 端把尖端推进到边线上）。 */
export function anchorPoint(node: ConnectorNode, side: Side, slot = 0): Point {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  // slot 从 0 开始：0 = 中心，±1 = 两侧错开
  const offset = slot * EDGE_SPACING
  const g = ARROW_GAP
  switch (side) {
    case 'top':
      return { x: cx + offset, y: node.y - g }
    case 'bottom':
      return { x: cx + offset, y: node.y + node.height + g }
    case 'left':
      return { x: node.x - g, y: cy + offset }
    case 'right':
      return { x: node.x + node.width + g, y: cy + offset }
  }
}

/** 节点边线上真正的接触点（箭头尖端应落在的位置，仍在边上）。 */
export function contactPoint(node: ConnectorNode, side: Side, slot = 0): Point {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const offset = slot * EDGE_SPACING
  switch (side) {
    case 'top':
      return { x: cx + offset, y: node.y }
    case 'bottom':
      return { x: cx + offset, y: node.y + node.height }
    case 'left':
      return { x: node.x, y: cy + offset }
    case 'right':
      return { x: node.x + node.width, y: cy + offset }
  }
}

/** 正交路由：水平/垂直折线（从边线中心出发）。 */
function fmtP(p: Point): string {
  return `${fmt(p.x)} ${fmt(p.y)}`
}
function fmt(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/** 去除相邻重复点 + 共线中间点（正交路径收尾拼接后清理 6px 锚点残段）。 */
function dedupePath(pts: Point[]): Point[] {
  const uniq: Point[] = []
  for (const p of pts) {
    const last = uniq[uniq.length - 1]
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue
    uniq.push(p)
  }
  const res: Point[] = []
  for (const p of uniq) {
    const n = res.length
    if (n >= 2) {
      const a = res[n - 2]
      const b = res[n - 1]
      const collinear =
        (Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - p.x) < 1e-6) ||
        (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - p.y) < 1e-6)
      if (collinear) {
        res[n - 1] = p
        continue
      }
    }
    res.push(p)
  }
  return res
}

function buildPathD(
  type: EdgeType,
  pts: Point[],
  bendSign = 1,
): string {
  if (pts.length < 2) return ''
  const [a, b] = [pts[0], pts[pts.length - 1]]
  if (type === 'bezier' || type === 'smooth') {
    // 三次贝塞尔：控制点取连线 1/3、2/3 处，并垂直于弦方向弯曲。
    // 弯曲方向由 bendSign 决定（平行边按槽位扇开，避免两曲线重叠）。
    const d = dist(a, b)
    const bend = Math.min(50, d * 0.2)
    const nx = (b.x - a.x) / (d || 1)
    const ny = (b.y - a.y) / (d || 1)
    const px = -ny * bendSign
    const py = nx * bendSign
    const c1 = { x: a.x + (b.x - a.x) / 3 + px * bend, y: a.y + (b.y - a.y) / 3 + py * bend }
    const c2 = { x: a.x + (2 * (b.x - a.x)) / 3 + px * bend, y: a.y + (2 * (b.y - a.y)) / 3 + py * bend }
    return `M ${fmtP(a)} C ${fmtP(c1)} ${fmtP(c2)} ${fmtP(b)}`
  }
  if (type === 'arc') {
    const theta = Math.min(Math.PI * 0.9, Math.max(0.3, dist(a, b) / 60))
    const r = dist(a, b) / (2 * Math.cos(theta / 2))
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const dVec = { x: b.x - a.x, y: b.y - a.y }
    const len = dist(a, b) || 1
    const n = { x: -dVec.y / len, y: dVec.x / len }
    const h = Math.sqrt(Math.max(0, r * r - (len / 2) ** 2))
    const center = { x: mid.x + n.x * h, y: mid.y + n.y * h }
    const a1 = Math.atan2(a.y - center.y, a.x - center.x)
    const a2 = Math.atan2(b.y - center.y, b.x - center.x)
    let sweep = a2 - a1
    while (sweep < 0) sweep += 2 * Math.PI
    const largeArc = sweep > Math.PI ? 1 : 0
    return `M ${fmtP(a)} A ${fmt(r)} ${fmt(r)} 0 ${largeArc} 1 ${fmtP(b)}`
  }
  // straight / orthogonal → polyline
  return `M ${pts.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' L ')}`
}

/**
 * 平行且相近的连线合并判断：
 * 两条边如果共享同一侧连接边（同 side + 相邻 slot），且路径近似平行（端点连线方向一致），
 * 并且两者在空间中确实靠得近（横向重叠 ≥ 半程 且 垂向间距 < 2×EDGE_SPACING），
 * 才判定为“过近”，返回需要分离。分离手段 = 改用贝塞尔曲线并加大弯曲。
 */
export function needsSeparation(
  a: { fromSide: Side; toSide: Side; points: Point[] },
  b: { fromSide: Side; toSide: Side; points: Point[] },
): boolean {
  if (a.fromSide !== b.fromSide || a.toSide !== b.toSide) return false
  const dirOf = (e: { points: Point[] }) => {
    const p = e.points
    const d = dist(p[0], p[p.length - 1])
    if (d < 1e-6) return 0
    const v = {
      x: (p[p.length - 1].x - p[0].x) / d,
      y: (p[p.length - 1].y - p[0].y) / d,
    }
    return Math.round(Math.atan2(v.y, v.x) * 100)
  }
  const d1 = dirOf(a)
  const d2 = dirOf(b)
  // 方向差 < 15° 视为平行
  const diff = Math.abs(((d1 - d2 + 180) % 360) - 180)
  if (diff >= 15) return false

  // 空间接近度：两条端点连线如果横向重叠太少或间距太大，不需要分离
  const [ax1, ax2] = [a.points[0].x, a.points[a.points.length - 1].x].sort((m, n) => m - n)
  const [bx1, bx2] = [b.points[0].x, b.points[b.points.length - 1].x].sort((m, n) => m - n)
  const overlap = Math.min(ax2, bx2) - Math.max(ax1, bx1)
  const span = Math.max(ax2 - ax1, bx2 - bx1)
  if (span > 0 && overlap < span * 0.5) return false
  const [ay1, ay2] = [a.points[0].y, a.points[a.points.length - 1].y].sort((m, n) => m - n)
  const [by1, by2] = [b.points[0].y, b.points[b.points.length - 1].y].sort((m, n) => m - n)
  const dy = Math.max(0, Math.max(ay1, by1) - Math.min(ay2, by2))
  if (dy > EDGE_SPACING * 2) return false
  return true
}

/**
 * 路由一条边：从节点边线中心出发（四方向），多连线自动错开。
 * 箭头主体停在边线外侧（ARROW_GAP），尖端恰好触边。
 * @param slotFrom / slotTo 该节点此侧已使用的编号（0=中心，±1 两侧）
 * @param obstacles 正交避障：除 from/to 外需要绕开的节点
 */
export function routeEdge(
  from: ConnectorNode,
  to: ConnectorNode,
  cfg: {
    type?: EdgeType
    dashed?: boolean
    label?: string
    arrow?: ArrowHead | boolean
    slotFrom?: number
    slotTo?: number
    obstacles?: ConnectorNode[]
    /** 正交路由最少转折数：0 = 允许 L 型；≥1 = 强制 ≥3 段 U/Z 型（架构图风格）。 */
    minBends?: number
    /** 同锚点扇出的边序号（用于平行边弯曲方向交替）。 */
    bendIdx?: number
    /** 正交中间通道偏移：同一走廊的多条边按此值错开水平段。 */
    channelShift?: number
    /** 自环边伸出方向（top/right/bottom/left）。默认 right。 */
    selfSide?: Side
    /** 布局方向：TB（上→下）/ LR（左→右）。菱形节点桩点选择依赖此值。 */
    direction?: 'LR' | 'TB'
    /** 菱形出边分支标记（是/否）。 */
    branch?: DiamondBranch
    /** 回边（构成环、从下游回到上游的边）。目标入点选垂直主布局方向的侧：
     *  TB → 进目标 left/right；LR → 进目标 top/bottom。 */
    backedge?: boolean
    /** 显式指定起点桩点（路由协调后覆盖自动选边）。 */
    fromSide?: Side
    /** 显式指定终点桩点（路由协调后覆盖自动选边）。 */
    toSide?: Side
  } = {},
): RoutedEdge {
  const type = cfg.type ?? 'straight'
  const fCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const tCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 }

  // 0) 自环边（from === to）：从节点一侧伸出，绕回同侧，再入同节点。
  //    以右侧为例：起点右边缘上 1/3 高，弯出去再回到右边缘下 2/3 高。
  if (from.key === to.key) {
    const cx = from.x + from.width / 2
    const cy = from.y + from.height / 2
    const side = cfg.selfSide ?? 'right'
    const exit = side === 'left' || side === 'right'
    // 环伸出的距离
    const loop = Math.max(28, Math.min(from.width, from.height) * 0.5)
    let fromC: Point
    let toC: Point
    let c1: Point
    let c2: Point
    if (exit) {
      const h1 = from.y + from.height * 0.3
      const h2 = from.y + from.height * 0.7
      const x = side === 'right' ? from.x + from.width : from.x
      fromC = { x, y: h1 }
      toC = { x, y: h2 }
      const dx = side === 'right' ? loop : -loop
      c1 = { x: x + dx, y: h1 - loop * 0.3 }
      c2 = { x: x + dx, y: h2 + loop * 0.3 }
    } else {
      const w1 = from.x + from.width * 0.3
      const w2 = from.x + from.width * 0.7
      const y = side === 'bottom' ? from.y + from.height : from.y
      fromC = { x: w1, y }
      toC = { x: w2, y }
      const dy = side === 'bottom' ? loop : -loop
      c1 = { x: w1 - loop * 0.3, y: y + dy }
      c2 = { x: w2 + loop * 0.3, y: y + dy }
    }
    const arrow: ArrowHead = cfg.arrow === undefined || cfg.arrow === true ? 'triangle' : cfg.arrow === false ? 'none' : cfg.arrow
    const pathD = `M ${fmt(fromC.x)} ${fmt(fromC.y)} C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(toC.x)} ${fmt(toC.y)}`
    const angleIn = exit
      ? Math.atan2(0, side === 'right' ? 1 : -1) // 水平进入
      : Math.atan2(side === 'bottom' ? 1 : -1, 0)
    const fromAngle = exit
      ? Math.atan2(0, side === 'right' ? 1 : -1)
      : Math.atan2(side === 'bottom' ? 1 : -1, 0)
    return {
      from: from.key,
      to: to.key,
      type: 'bezier',
      dashed: cfg.dashed ?? false,
      label: cfg.label,
      arrow,
      points: [fromC, toC],
      pathD,
      fromSide: side,
      toSide: side,
      arrowTip: toC,
      arrowAngle: angleIn,
      fromTip: fromC,
      fromAngle,
    }
  }

  // 1) 选边（按中心连线方向决定上/下/左/右；菱形按决策节点约定 + 布局方向覆盖）
  const direction = cfg.direction ?? 'TB'
  // 回边：源出点 + 目标入点都选【垂直主布局方向】的侧，且同侧对称（右出右拐/左出左拐）。
  //   菱形节点保留分支语义（是→主方向，否→侧向），其余节点按规范侧向出。
  //   若上层已协调好 fromSide/toSide（回边目标侧避免拥堵），直接采用。
  let fromSide: Side
  let toSide: Side
  if (cfg.fromSide && cfg.toSide) {
    fromSide = cfg.fromSide
    toSide = cfg.toSide
  } else if (cfg.backedge) {
    fromSide =
      from.shape === 'diamond'
        ? pickSideForShape(from, to, true, pickSide(fCenter, tCenter), direction, cfg.branch)
        : backedgeExitSide(fCenter, tCenter, direction)
    toSide = backedgeEntrySide(fCenter, tCenter, direction)
  } else {
    fromSide = pickSideForShape(from, to, true, pickSide(fCenter, tCenter), direction, cfg.branch)
    toSide = pickSideForShape(to, from, false, pickSide(tCenter, fCenter), direction)
  }

  // 2) 连接点 = 边线中心 + 错开偏移（停在外侧 ARROW_GAP）
  const fromP = anchorPoint(from, fromSide, cfg.slotFrom ?? 0)
  const toP = anchorPoint(to, toSide, cfg.slotTo ?? 0)

  // 正交路由：minBends≥1 恒生效（架构图不允许 L 型——L 型会贴节点上/下边线）。
  // 同行/同列直线由 routeOrthogonalAvoid 的锚点短路处理（锚点唯一后同行节点锚点必同行）
  const effMinBends = type === 'orthogonal' ? (cfg.minBends ?? 0) : 0

  let points: Point[]
  let effType = type
  if (type === 'orthogonal') {
    const exclude = [from.key, to.key]
    points = routeOrthogonalAvoid(fromP, toP, cfg.obstacles ?? [], exclude, fromSide, toSide, effMinBends, cfg.channelShift ?? 0)
    // 强制 U/Z 型（minBends≥1）但正交路由只能产出退化路径（<3 段：直线/L 型，
    // 会与主链路直线重叠）→ 弧线兜底。典型场景：同一行的回边。
    if (effMinBends >= 1 && points.length < 4) {
      effType = 'arc'
      points = [fromP, toP]
    }
  } else if (type === 'straight') {
    points = [fromP, toP]
  } else {
    points = [fromP, toP] // bezier/smooth/arc 由 pathD 生成曲线
  }

  const arrow: ArrowHead = cfg.arrow === undefined || cfg.arrow === true ? 'triangle' : cfg.arrow === false ? 'none' : cfg.arrow
  // 平行边弯曲方向按"扇出序号"交替（bendIdx 由批量路由按边序分配）：
  // 偶数条向上弯、奇数条向下弯，即使锚点相同也能扇形展开不重叠
  const bendSign = (cfg.bendIdx ?? 0) % 2 === 0 ? -1 : 1
  // 绘制路径：起终点都落在节点边线上（contactPoint），线端与箭头尖端重合。
  const fromC = contactPoint(from, fromSide, cfg.slotFrom ?? 0)
  const toC = contactPoint(to, toSide, cfg.slotTo ?? 0)

  // 目标端"垂直进入小段"：入边必须有一段与目标节点连接边垂直的小段，
  // 避免斜线/曲线以倾斜角度"切"进节点侧面。正交线末段本身已垂直目标边，无需处理。
  // stubPoint 落在节点外侧 stubLen 处，末段 stubPoint→toC 沿目标边法向（垂直于边）进入。
  const stubLen = Math.max(4, Math.min(14, dist(fromC, toC) * 0.3))
  const toN: Point =
    toSide === 'left' ? { x: 1, y: 0 }
    : toSide === 'right' ? { x: -1, y: 0 }
    : toSide === 'top' ? { x: 0, y: 1 }
    : { x: 0, y: -1 }
  const stubPoint: Point = { x: toC.x - toN.x * stubLen, y: toC.y - toN.y * stubLen }

  let rawDraw: Point[]
  if (effType === 'straight') {
    // 直线：末段已垂直（同行/同列）→ 保持直线；否则在目标端插入垂直进入小段
    const d = { x: toC.x - fromC.x, y: toC.y - fromC.y }
    const alreadyPerp =
      toSide === 'left' || toSide === 'right' ? Math.abs(d.y) < 1.5 : Math.abs(d.x) < 1.5
    rawDraw = alreadyPerp ? [fromC, toC] : [fromC, stubPoint, toC]
  } else if (effType === 'orthogonal') {
    // 正交：保留全部路由点 + 两端 contact，去共线后整体正交（末段已垂直目标边）
    rawDraw = [fromC, ...points, toC]
  } else {
    // bezier/smooth/arc：曲线画到 stubPoint，末段 stubPoint→toC 直线垂直进入
    rawDraw = [fromC, stubPoint, toC]
  }
  const drawPoints = dedupePath(rawDraw)

  // pathD：
  //   - straight/orthogonal → 折线直接拼
  //   - bezier/smooth/arc   → 曲线只画到 stubPoint，再追加一段直线 stubPoint→toC
  //                           （垂直进入目标节点，避免曲线倾斜切入）
  const pathD =
    effType === 'bezier' || effType === 'smooth' || effType === 'arc'
      ? buildPathD(effType, dedupePath([fromC, ...points, stubPoint]), bendSign) +
        ` L ${fmt(toC.x)} ${fmt(toC.y)}`
      : buildPathD(effType, drawPoints, bendSign)

  // 3) 箭头尖端 = 节点边线上的接触点（线端与箭头尖端重合）
  const arrowTip = toC
  // 箭头指向 = 路径末段方向（垂直进入小段 / 正交末段 / 直线本身）：
  // 末段恒垂直于目标边，箭头因此垂直指向节点内部，贴合实际线角。
  const dpLast = drawPoints[drawPoints.length - 1]
  const dpPrev = drawPoints[drawPoints.length - 2] ?? dpLast
  const arrowAngle = Math.atan2(dpLast.y - dpPrev.y, dpLast.x - dpPrev.x)

  // 起点侧接触点与切入角（from 端）：方向取"源中心 → 接触点"（指向节点内部）
  const fromTip = fromC
  const fCenter2 = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  let fromAngle = Math.atan2(fromC.y - fCenter2.y, fromC.x - fCenter2.x)
  if (effType === 'orthogonal') {
    const first = points[0]
    const second = points[1] ?? first
    fromAngle = Math.atan2(second.y - first.y, second.x - first.x)
  }

  return {
    from: from.key,
    to: to.key,
    type: effType,
    dashed: cfg.dashed ?? false,
    label: cfg.label,
    arrow,
    points,
    pathD,
    fromSide,
    toSide,
    arrowTip,
    arrowAngle,
    fromTip,
    fromAngle,
  }
}

/** 返回边的中点（用于标签定位）。 */
export function edgeMidpoint(e: RoutedEdge): Point {
  const pts = e.points
  if (pts.length === 2) {
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
  }
  return pts[Math.floor(pts.length / 2)]
}

/**
 * 标签锚点：正交线取最长的水平段中点（标签读起来平顺，不压在竖直段上）；
 * 其它类型取整体中点。
 */
export function edgeLabelAnchor(e: RoutedEdge): Point {
  if (e.type !== 'orthogonal' || e.points.length < 3) return edgeMidpoint(e)
  let best: { len: number; x: number; y: number } | null = null
  for (let i = 0; i < e.points.length - 1; i++) {
    const a = e.points[i]
    const b = e.points[i + 1]
    if (Math.abs(a.y - b.y) > 0.5) continue // 只找水平段
    const len = Math.abs(b.x - a.x)
    if (!best || len > best.len) {
      best = { len, x: (a.x + b.x) / 2, y: a.y }
    }
  }
  return best ? { x: best.x, y: best.y } : edgeMidpoint(e)
}

export function distToEdge(e: RoutedEdge, p: Point): number {
  let best = Infinity
  for (let i = 0; i < e.points.length - 1; i++) {
    best = Math.min(best, distToSegment(p, e.points[i], e.points[i + 1]))
  }
  return best
}
