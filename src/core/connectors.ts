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
  /** 是否为分支边（菱形的是/否分支）：标签放在靠近起点的位置。 */
  branchLabel?: boolean
}

export const EDGE_SPACING = 14
export const ARROW_GAP = 6

/**
 * 连线两端与节点边框之间的空隙（px）。
 *
 * 箭头尖端、线条起点都从边框外推这个距离。太小（≤2）时实心箭头会和节点描边
 * 糊成一团；太大又会让连线看起来"没接上"。10px 在 2px 描边下视觉最舒服。
 */
export const END_GAP = 10

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

/**
 * 判断两点连线应使用哪条边（上/下/左/右）作为连接边。
 *
 * 关键：分层图里相邻层天然是「主方向」关系（TB → 上下，LR → 左右）。
 * 若只按 |dx| vs |dy| 取较大者，当横向位移略大于纵向时（例如右上→左下），
 * 会选出「左出右入」的水平桩点，连线于是斜穿整张大图、压过中间所有节点
 * （ER 图实测 order→item：dx=-280 / dy=156，被误判成水平连接）。
 *
 * 因此先看主方向位移是否足够（> MAIN_AXIS_MIN），够就走主方向的侧边；
 * 只有近同行/同列时才退回「较大位移」的兜底判断。
 */
export function pickSide(fromCenter: Point, toCenter: Point, direction: 'LR' | 'TB' = 'TB'): Side {
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  const MAIN_AXIS_MIN = 8
  if (direction === 'TB' && ady > MAIN_AXIS_MIN) return dy > 0 ? 'bottom' : 'top'
  if (direction === 'LR' && adx > MAIN_AXIS_MIN) return dx > 0 ? 'right' : 'left'
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
 * 外侧回边走廊：让回边沿整张图的外侧绕行，而不是穿过图形内部。
 *
 * 分层图的环路（如「审批驳回 → 重新提交」）如果直接连斜线或走内部正交通道，
 * 会横跨多个层级、压过中间所有节点和连线，视觉上极难跟随。
 * 业界通行做法（graphviz / ELK / mermaid）是把回边引到图的外侧 gutter，
 * 沿画布边缘竖直走一段再收回目标节点。
 *
 * @returns points 正交路径点（首尾为节点边线上的接触点）；side 走廊所在侧
 */
export function externalBackedgeRoute(
  from: ConnectorNode,
  to: ConnectorNode,
  allNodes: ConnectorNode[],
  direction: 'LR' | 'TB' = 'TB',
  gutter = 40,
  slot = 0,
): { points: Point[]; side: Side } {
  const fromC = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const toC = { x: to.x + to.width / 2, y: to.y + to.height / 2 }

  if (direction === 'TB') {
    let minX = Infinity
    let maxX = -Infinity
    for (const n of allNodes) {
      minX = Math.min(minX, n.x)
      maxX = Math.max(maxX, n.x + n.width)
    }
    // 走廊选【离源和目标都更近】的那一侧：取两端横向中心的中点与全图中心比较。
    // 不能用"任一在右就走右"——两节点分居两侧时会绕远路横跨整图。
    // 此判定必须与 edge-bundle 的 backedgeLaneSide 完全一致（槽位按它分组）。
    const onRight = (fromC.x + toC.x) / 2 >= (minX + maxX) / 2
    // 走廊按 slot 逐条外扩：slot 为 n 个序号时均匀分布在 [0, n-1]，
    // 换算成以 0 为中心的外扩量，避免多条回边走同一条竖线。
    const laneX = (onRight ? maxX : minX) + (onRight ? 1 : -1) * (gutter + Math.abs(slot) * EDGE_SPACING)
    const side: Side = onRight ? 'right' : 'left'
    // 端点落在节点左右边的【中间区域】，按 slot 在边内均匀散开 ——
    // 用"中点 + slot×间距"再 clamp 会让多条边挤到同一端（clamp 后重合）。
    const spread = (span: number) => {
      if (slot === 0) return 0
      const maxOff = Math.max(0, span / 2 - 10)
      const t = Math.max(-1, Math.min(1, slot / 3))
      return t * maxOff
    }
    const exitX = onRight ? from.x + from.width : from.x
    const entryX = onRight ? to.x + to.width : to.x
    const exitY = fromC.y + spread(from.height)
    const entryY = toC.y + spread(to.height)
    return {
      side,
      points: [
        { x: exitX, y: exitY },
        { x: laneX, y: exitY },
        { x: laneX, y: entryY },
        { x: entryX, y: entryY },
      ],
    }
  }

  let minY = Infinity
  let maxY = -Infinity
  for (const n of allNodes) {
    minY = Math.min(minY, n.y)
    maxY = Math.max(maxY, n.y + n.height)
  }
  const onBottom = (fromC.y + toC.y) / 2 >= (minY + maxY) / 2
  const laneY = (onBottom ? maxY : minY) + (onBottom ? 1 : -1) * (gutter + Math.abs(slot) * EDGE_SPACING)
  const side: Side = onBottom ? 'bottom' : 'top'
  const exitY = onBottom ? from.y + from.height : from.y
  const entryY = onBottom ? to.y + to.height : to.y
  const spread = (span: number) => {
    if (slot === 0) return 0
    const maxOff = Math.max(0, span / 2 - 10)
    const t = Math.max(-1, Math.min(1, slot / 3))
    return t * maxOff
  }
  const exitX = fromC.x + spread(from.width)
  const entryX = toC.x + spread(to.width)
  return {
    side,
    points: [
      { x: exitX, y: exitY },
      { x: exitX, y: laneY },
      { x: entryX, y: laneY },
      { x: entryX, y: entryY },
    ],
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 把 externalBackedgeRoute 的路径点组装成 RoutedEdge。 */
function routeBackedgeViaGutter(
  from: ConnectorNode,
  to: ConnectorNode,
  allNodes: ConnectorNode[],
  cfg: {
    dashed?: boolean
    label?: string
    arrow?: ArrowHead | boolean
    backedgeGutter?: number
    slotTo?: number
  },
  direction: 'LR' | 'TB',
): RoutedEdge {
  const lane = externalBackedgeRoute(
    from,
    to,
    allNodes,
    direction,
    cfg.backedgeGutter ?? 40,
    cfg.slotTo ?? 0,
  )
  const pts = lane.points
  const arrowTipC = pts[pts.length - 1]
  const isSideLane = lane.side === 'left' || lane.side === 'right'
  return {
    from: from.key,
    to: to.key,
    type: 'orthogonal',
    dashed: cfg.dashed ?? false,
    label: cfg.label,
    arrow:
      cfg.arrow === undefined || cfg.arrow === true
        ? 'triangle'
        : cfg.arrow === false
          ? 'none'
          : cfg.arrow,
    points: pts,
    pathD: buildPathD('orthogonal', pts),
    fromSide: lane.side,
    toSide: lane.side,
    arrowTip: arrowTipC,
    // 末端恒垂直于目标边进入（侧走廊 → 水平入；上下走廊 → 垂直入），
    // 否则箭头会斜切节点边线。
    arrowAngle: isSideLane
      ? Math.atan2(0, lane.side === 'right' ? -1 : 1)
      : Math.atan2(lane.side === 'bottom' ? -1 : 1, 0),
    fromTip: pts[0],
    fromAngle: Math.atan2(pts[0].y - pts[1].y, pts[0].x - pts[1].x),
  }
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

/** 节点边线上真正的接触点（几何交点，仍在边框上）。 */
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

/**
 * 把连接点沿「离开节点」的法向再外推 gap 像素。
 *
 * 箭头尖端原本贴在边框上，视觉上非常拥挤 —— 尤其架构图里模块密集、边框又粗，
 * 箭头会和边框糊在一起。统一走这个函数，避免各处手写 ±gap。
 */
export function pullOut(point: Point, side: Side, gap: number): Point {
  switch (side) {
    case 'top':
      return { x: point.x, y: point.y - gap }
    case 'bottom':
      return { x: point.x, y: point.y + gap }
    case 'left':
      return { x: point.x - gap, y: point.y }
    case 'right':
      return { x: point.x + gap, y: point.y }
  }
}

/**
 * 层感知路由（架构图专用）：连线先垂直穿过源层框底边，再在层框之间的
 * 空隙里水平位移，最后垂直进入目标层框顶边。
 *
 * 为什么不能用通用正交避障：层框把目标模块整个包住，任何「先水平再竖直」
 * 的路径都会在进入层框后横穿层框内部。层框在语义上是**容器**，不是障碍物，
 * 连线只应该穿过它的上下边。
 *
 * 两条错开规则（都是为了避免连线重合）：
 *   1. slotFrom/slotTo —— 同一模块的多条出边/入边，锚点沿模块底/顶边扇开，
 *      否则 4 条出边会共用同一条垂直段（实测完全重叠 48px）。
 *   2. channel —— 同一层间空隙里多条边的水平段按序号上下错开。
 *
 * @param slotFrom 源端锚点序号（同源扇出）
 * @param slotTo   目标端锚点序号（同目标汇入）
 * @param channel  层间空隙的通道序号
 */
export function routeAcrossLayers(
  from: ConnectorNode,
  to: ConnectorNode,
  fromLayer?: { x: number; y: number; width: number; height: number },
  toLayer?: { x: number; y: number; width: number; height: number },
  slotFrom = 0,
  slotTo = 0,
  channel = 0,
  absFromX?: number,
  absToX?: number,
  allLayers?: { x: number; y: number; width: number; height: number }[],
): Point[] | undefined {
  if (!fromLayer || !toLayer) return undefined
  // 同层连线（或层框完全重合）：不适用层间路由，交给通用逻辑
  if (
    fromLayer.x === toLayer.x &&
    fromLayer.y === toLayer.y &&
    fromLayer.width === toLayer.width
  ) {
    return undefined
  }
  const fromIsAbove = fromLayer.y + fromLayer.height <= toLayer.y
  const toIsAbove = toLayer.y + toLayer.height <= fromLayer.y
  if (!fromIsAbove && !toIsAbove) return undefined // 非上下排列

  const [upperMod, lowerMod] = fromIsAbove ? [from, to] : [to, from]
  const [upperLayer, lowerLayer] = fromIsAbove ? [fromLayer, toLayer] : [toLayer, fromLayer]
  const [upperSlot, lowerSlot] = fromIsAbove ? [slotFrom, slotTo] : [slotTo, slotFrom]

  // 锚点：模块中心 + 槽位偏移，并夹在模块边内（避免锚点跑到模块外面）
  const anchorX = (mod: ConnectorNode, slot: number) => {
    const c = mod.x + mod.width / 2
    const lo = mod.x + EDGE_SPACING
    const hi = mod.x + mod.width - EDGE_SPACING
    return Math.max(lo, Math.min(hi, c + slot * EDGE_SPACING))
  }
  // 绝对锚点（由 edge-bundle 的全局去冲突步骤算好）优先于相对槽位
  const absUpper = fromIsAbove ? absFromX : absToX
  const absLower = fromIsAbove ? absToX : absFromX
  const startX = absUpper ?? anchorX(upperMod, upperSlot)
  const endX = absLower ?? anchorX(lowerMod, lowerSlot)

  // 进出层框的位置要【内缩一个内边距】，不能正好压在层框边框上。
  // 否则垂直段会与层框的水平边框共线，视觉上连线和边框糊成一条。
  const layerInset = 12
  const exitY = upperLayer.y + upperLayer.height - layerInset // 源层框底边内侧
  const enterY = lowerLayer.y + layerInset // 目标层框顶边内侧
  const gapSpan = enterY - exitY
  if (gapSpan < 48) return undefined // 空隙太窄，退化为直线

  // 通道在中线附近按序号错开，避免多条边的水平段叠成一束。
  // 限制在 [exitY+layerInset, enterY-layerInset] 内，保证水平段不压任何层框边框。
  const usable = Math.max(0, gapSpan / 2 - layerInset - 8)
  const shift = Math.max(-usable, Math.min(usable, channel * EDGE_SPACING))
  const midY = Math.max(exitY + layerInset, Math.min(enterY - layerInset, exitY + gapSpan / 2 + shift))

  const start = pullOut({ x: startX, y: upperMod.y + upperMod.height }, 'bottom', END_GAP)
  const end = pullOut({ x: endX, y: lowerMod.y }, 'top', END_GAP)

  // 跨层时，垂直段要穿过中间的层框（例如「业务层 → 数据层」跨过中间件层）。
  // 直接从上框底边垂直拉到下框顶边会横穿中间层框内部，视觉上像连线穿过了那一层。
  // 处理：找出中间的层框，把垂直段拆成「框前一段 + 穿过框 + 框后一段」，
  // 并在每个层框内的中位处加一个途经点，使连线保持垂直、不贴着框边。
  const between = (allLayers ?? [])
    .filter((l) => l.y > exitY && l.y + l.height < enterY)
    .filter((l) => !(l.x === upperLayer.x && l.y === upperLayer.y))
    .sort((a, b) => a.y - b.y)

  // 垂直段按 y 单调推进：先到各中间层框的内侧（同样内缩 layerInset，不压边框），
  // 再到空隙中线，最后进目标框。中间层框内保持同一 x，不横向移动。
  const raw: Point[] = [start, { x: startX, y: exitY }]
  for (const l of between) {
    raw.push(
      { x: startX, y: l.y + layerInset },
      { x: startX, y: l.y + l.height - layerInset },
    )
  }
  // 水平位移必须落在「最后一个中间层框的底边 [之外 layerInset]」与
  // 「目标层框顶边内侧」之间，否则会压在中间层框的边框上（实测 y 正好等于框底边）。
  const lastLayerBottom = between.length
    ? between[between.length - 1].y + between[between.length - 1].height
    : upperLayer.y + upperLayer.height
  const minShiftY = lastLayerBottom + layerInset
  const maxShiftY = enterY - layerInset
  // 若中间层框与目标框之间放不下位移段，说明层间距不足：
  // 此时把位移段放到最后一个中间层框【内部】靠下的位置（仍保持内缩），
  // 而不是压到边框上。
  const shiftY =
    minShiftY <= maxShiftY
      ? Math.max(minShiftY, Math.min(maxShiftY, midY))
      : lastLayerBottom - layerInset
  raw.push({ x: startX, y: shiftY }, { x: endX, y: shiftY }, { x: endX, y: enterY }, end)

  // 起终点 x 相同时中段退化为零长度，过滤掉重复点
  const pts = raw.filter((p, i) => {
    if (i === 0) return true
    const q = raw[i - 1]
    return Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5
  })
  return fromIsAbove ? pts : [...pts].reverse()
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
    /** 回边外侧走廊距节点包围盒的留白（px）。默认 40。 */
    backedgeGutter?: number
    /** 显式指定起点桩点（路由协调后覆盖自动选边）。 */
    fromSide?: Side
    /** 显式指定终点桩点（路由协调后覆盖自动选边）。 */
    toSide?: Side
    /** 架构图层感知路由：源/目标模块所在的层框。两者上下相邻时，
     *  连线沿「出源层框 → 框间空隙水平位移 → 入目标层框」走。 */
    fromLayer?: { x: number; y: number; width: number; height: number }
    toLayer?: { x: number; y: number; width: number; height: number }
    /** 全局去冲突后的绝对锚点 x（覆盖相对槽位） */
    absFromX?: number
    absToX?: number
    /** 架构图全部层框（跨多层连线时用于避开中间层） */
    allLayers?: { x: number; y: number; width: number; height: number }[]
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
        ? pickSideForShape(from, to, true, pickSide(fCenter, tCenter, direction), direction, cfg.branch)
        : backedgeExitSide(fCenter, tCenter, direction)
    toSide = backedgeEntrySide(fCenter, tCenter, direction)
  } else {
    fromSide = pickSideForShape(from, to, true, pickSide(fCenter, tCenter, direction), direction, cfg.branch)
    toSide = pickSideForShape(to, from, false, pickSide(tCenter, fCenter, direction), direction)
  }

  // 层感知路由（架构图）：优先于通用正交路由。层框是容器而非障碍，
  // 连线必须在框与框之间的空隙里完成水平位移。
  if (cfg.fromLayer || cfg.toLayer) {
    // slotFrom/slotTo 让同源扇出、同目标汇入的边在模块边上错开锚点；
    // slotTo 同时充当层间空隙的通道序号（汇入同一目标的边天然需要错开）。
    const layered = routeAcrossLayers(
      from,
      to,
      cfg.fromLayer,
      cfg.toLayer,
      cfg.slotFrom ?? 0,
      cfg.slotTo ?? 0,
      cfg.slotTo ?? 0,
      cfg.absFromX,
      cfg.absToX,
      cfg.allLayers,
    )
    if (layered && layered.length >= 2) {
      const arrow =
        cfg.arrow === undefined || cfg.arrow === true
          ? 'triangle'
          : cfg.arrow === false
            ? 'none'
            : cfg.arrow
      const tip = layered[layered.length - 1]
      const prev = layered[layered.length - 2] ?? tip
      const fromP = layered[0]
      const fromN = layered[1] ?? tip

      // 曲线类型：保留层间距路由算出的出入点（保证不穿层框），
      // 但把中间段画成曲线。直接用贝塞尔连接首尾会横穿层框，所以按「曲线族」处理：
      //   bezier/smooth —— 在出入点之间用三次贝塞尔，控制点沿垂直方向拉开
      //   arc           —— 两点间圆弧
      // 两者都只替换【中间】的折线段，首末端仍垂直出入节点。
      const curveType = type === 'bezier' || type === 'smooth' || type === 'arc' ? type : undefined
      if (curveType && layered.length >= 4) {
        // 曲线只能发生在【层框之间的空隙】里。
        // 若从源模块直接拉曲线，控制点会把曲线拱进层框内部、贴着层框边框走。
        // 因此：首段垂直直线到「离开源层框」的位置 → 空隙内画曲线 → 末段垂直线进入目标。
        // 跨多层时，曲线只能放在「最后一个中间层框之后」的空隙，
        // 否则会从中间层框内部画过去。
        const enterPt = layered[layered.length - 2] // 已内缩的目标层框入线点
        // 找出路径里位于中间层框内的 y 区间，取最后一个的底边作为曲线起点
        const midYs = layered.slice(1, -2).map((p) => p.y)
        const curveStartY = midYs.length ? Math.max(...midYs) : layered[1].y
        const a = { x: fromP.x, y: curveStartY }
        const b = { x: tip.x, y: enterPt.y }
        const span = Math.abs(b.y - a.y)
        // 弯曲量限制在空隙高度内，避免曲线越界
        const bend = Math.min(span * 0.45, Math.max(16, span * 0.3))

        let midD: string
        if (curveType === 'arc') {
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
          const r = Math.max(len / 2 + 1, len / 2 + bend * 0.4)
          midD = `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(b.x)} ${fmt(b.y)}`
        } else {
          // 三次贝塞尔：控制点留在空隙内，形成平滑 S 形
          const c1 = { x: a.x, y: a.y + bend }
          const c2 = { x: b.x, y: b.y - bend }
          midD = `C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(b.x)} ${fmt(b.y)}`
        }
        return {
          from: from.key,
          to: to.key,
          type: curveType,
          dashed: cfg.dashed ?? false,
          label: cfg.label,
          arrow,
          // points 保留正交关键点（标签定位/命中检测用），pathD 是真实曲线：
          // 起点 → 垂直小段 → 曲线中段 → 垂直小段 → 终点
          points: layered,
          pathD: `M ${fmt(fromP.x)} ${fmt(fromP.y)} L ${fmt(a.x)} ${fmt(a.y)} ${midD} L ${fmt(tip.x)} ${fmt(tip.y)}`,
          fromSide: 'bottom',
          toSide: 'top',
          arrowTip: tip,
          arrowAngle: Math.atan2(tip.y - prev.y, tip.x - prev.x),
          fromTip: fromP,
          fromAngle: Math.atan2(fromN.y - fromP.y, fromN.x - fromP.x),
        }
      }

      return {
        from: from.key,
        to: to.key,
        type: 'orthogonal',
        dashed: cfg.dashed ?? false,
        label: cfg.label,
        arrow,
        points: layered,
        pathD: buildPathD('orthogonal', layered),
        fromSide: 'bottom',
        toSide: 'top',
        arrowTip: tip,
        arrowAngle: Math.atan2(tip.y - prev.y, tip.x - prev.x),
        fromTip: layered[0],
        fromAngle: Math.atan2(prev.y - tip.y, prev.x - tip.x),
      }
    }
  }

  // 2) 连接点：边线交点向外推 END_GAP，让箭头与边框之间留出呼吸空间。
  //    points 与绘制路径必须用同一基准，否则两者会错开几像素。
  const fromP = pullOut(contactPoint(from, fromSide, cfg.slotFrom ?? 0), fromSide, END_GAP)
  const toP = pullOut(contactPoint(to, toSide, cfg.slotTo ?? 0), toSide, END_GAP)

  // 正交路由：minBends≥1 恒生效（架构图不允许 L 型——L 型会贴节点上/下边线）。
  // 同行/同列直线由 routeOrthogonalAvoid 的锚点短路处理（锚点唯一后同行节点锚点必同行）
  const effMinBends = type === 'orthogonal' ? (cfg.minBends ?? 0) : 0

  let points: Point[]
  let effType = type

  // 回边：走图外侧走廊，不穿主链。内部正交通道总会被中间层的节点/连线挡住，
  // 横跨多个层级后视觉上极难跟随。
  if (cfg.backedge && cfg.obstacles && cfg.obstacles.length > 0) {
    return routeBackedgeViaGutter(from, to, [from, to, ...cfg.obstacles], cfg, direction)
  }

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
  // 绘制路径：起终点从边框外推 END_GAP，箭头主体与节点描边之间留出空隙。
  const fromC = pullOut(contactPoint(from, fromSide, cfg.slotFrom ?? 0), fromSide, END_GAP)
  const toC = pullOut(contactPoint(to, toSide, cfg.slotTo ?? 0), toSide, END_GAP)

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
    // 菱形分支边（是/否）：标签贴近起点，便于对应分支方向
    branchLabel: from.shape === 'diamond' && cfg.branch !== undefined,
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
 *
 * 返回的锚点会再沿「该段法向」偏移 LABEL_OFFSET，让文字落在线的旁边而不是
 * 压在线条上（mermaid / graphviz 的常规做法）。水平段向上偏移，竖直段向右偏移。
 */
export const LABEL_OFFSET = 9

export function edgeLabelAnchor(e: RoutedEdge): Point {
  // 分支边（菱形出边，带"是/否"）：标签贴近起点，读者一眼能对应到分支方向。
  if (e.branchLabel) {
    const pts = e.points
    if (pts.length >= 2) {
      const a = pts[0]
      const b = pts[1]
      const horiz = Math.abs(a.y - b.y) <= 0.5
      const vert = Math.abs(a.x - b.x) <= 0.5
      // 放在首段的【前 60% 处】：既贴近分支起点，又不会顶到走廊竖线上。
      const t = 0.6
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      if (horiz) return { x, y: y - LABEL_OFFSET }
      if (vert) return { x: x + LABEL_OFFSET, y }
      // 斜线段（菱形分支出线常常是斜的）：沿线段法向偏移，否则标签会压在线上。
      // 偏移量要足够大 —— 13px 字体的半高约 6.5px，加上文字基线偏移，
      // 法向距离需 ≥ 14px 才能让文字整体离开线条。
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      // 法向取「指向外侧」的一侧：右分支向右上、左分支向左上
      const nx = dy / len
      const ny = -dx / len
      const sign = nx >= 0 ? 1 : -1
      const off = LABEL_OFFSET + 8
      return { x: x + nx * sign * off, y: y + ny * sign * off }
    }
  }
  if (e.type !== 'orthogonal' || e.points.length < 3) {
    const m = edgeMidpoint(e)
    return { x: m.x, y: m.y - LABEL_OFFSET }
  }
  let best: { len: number; x: number; y: number; horiz: boolean } | null = null
  for (let i = 0; i < e.points.length - 1; i++) {
    const a = e.points[i]
    const b = e.points[i + 1]
    const horiz = Math.abs(a.y - b.y) <= 0.5
    const len = horiz ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)
    if (!best || len > best.len) {
      best = { len, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, horiz }
    }
  }
  if (!best) return edgeMidpoint(e)
  // 水平段向上偏、竖直段向右偏，避免文字压在线上
  return best.horiz
    ? { x: best.x, y: best.y - LABEL_OFFSET }
    : { x: best.x + LABEL_OFFSET, y: best.y }
}

export function distToEdge(e: RoutedEdge, p: Point): number {
  let best = Infinity
  for (let i = 0; i < e.points.length - 1; i++) {
    best = Math.min(best, distToSegment(p, e.points[i], e.points[i + 1]))
  }
  return best
}
