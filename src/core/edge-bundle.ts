/**
 * 边的成组路由（edge bundling）：
 * 1) 为同一节点同一侧的多条边分配【错开槽位】（扇形展开），避免多条线共用同一锚点
 * 2) 槽位按目标位置排序（沿节点边垂直方向），扇出的连线方向有序、不交叉
 * 3) 检测“槽位相同或真正重叠”的平行边，升级为贝塞尔曲线错开
 *
 * 这是 create_flow_diagram / create_er_diagram / create_architecture_diagram
 * 等批量绘制场景使用的入口；routeEdge（单条）不处理槽位，由本模块协调。
 */

import {
  routeEdge,
  needsSeparation,
  EDGE_SPACING,
  pickSideForShape,
  backedgeEntrySide,
  backedgeExitSide,
  type ConnectorNode,
  type EdgeType,
  type ArrowHead,
  type RoutedEdge,
  type DiamondBranch,
  type Side,
} from './connectors.js'
import { dist } from './geometry.js'
import type { Point } from './geometry.js'

export type { ConnectorNode, EdgeType, ArrowHead, RoutedEdge }

export interface EdgeRequest {
  from: string
  to: string
  type?: EdgeType
  dashed?: boolean
  label?: string
  arrow?: ArrowHead | boolean
  /** 本条边的正交最小转折数（覆盖全局 opts.minBends）。用于回边强制 U/Z 型绕行。 */
  minBends?: number
  /** 布局方向：TB（上→下）/ LR（左→右）。菱形节点桩点选择依赖此值。 */
  direction?: 'LR' | 'TB'
  /** 菱形出边分支标记（是/否）。 */
  branch?: DiamondBranch
  /** 回边（构成环、从下游回到上游的边）。目标入点选垂直主布局方向的侧。 */
  backedge?: boolean
  /** 架构图：源/目标模块所在的层框（层感知路由用）。 */
  fromLayer?: { x: number; y: number; width: number; height: number }
  toLayer?: { x: number; y: number; width: number; height: number }
  allLayers?: { x: number; y: number; width: number; height: number }[]
}

export interface BundleOptions {
  /** 正交路由最少转折数：0 = 允许 L 型；≥1 = 强制 ≥3 段 U/Z 型（架构图风格）。 */
  minBends?: number
  /** 正交路由中间通道错开量（相邻平行边的通道间隔）。默认 EDGE_SPACING。 */
  channelGap?: number
  /** 入/出分离：同一节点同一侧既有入边又有出边时，把入边槽位整体偏移，
   *  避免进出锚点落在同一位置。默认 false。 */
  separateInOut?: boolean
  /** 全局布局方向默认值（TB/LR），被未单独指定 direction 的 EdgeRequest 继承。 */
  direction?: 'LR' | 'TB'
  /** 额外的路由障碍物（如架构图的层框 frame）：仅参与避障，不作为锚点候选。
   *  按边返回，因为层框必须对「起点或终点位于其中的边」豁免 —— 否则边永远
   *  出不了自己的层框，正交路由会整体判定阻塞并退回不避障的兜底路径。 */
  extraObstaclesFor?: (fromKey: string, toKey: string) => ConnectorNode[]
}

export interface RoutedBundle {
  edges: (RoutedEdge & { key: string })[]
}

/**
 * 回边走哪一侧走廊（必须与 externalBackedgeRoute 的判定一致）。
 * 按「源+目标的横向中心相对全图中心」选，取离两端都近的那侧。
 */
function backedgeLaneSide(
  nodeMap: Map<string, ConnectorNode>,
  fromKey: string,
  toKey: string,
  direction: 'LR' | 'TB',
): Side {
  const nodes = [...nodeMap.values()]
  if (direction === 'LR') {
    let minY = Infinity
    let maxY = -Infinity
    for (const n of nodes) {
      minY = Math.min(minY, n.y)
      maxY = Math.max(maxY, n.y + n.height)
    }
    const f = nodeMap.get(fromKey)
    const t = nodeMap.get(toKey)
    if (!f || !t) return 'bottom'
    return (f.y + f.height / 2 + t.y + t.height / 2) / 2 >= (minY + maxY) / 2 ? 'bottom' : 'top'
  }
  let minX = Infinity
  let maxX = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    maxX = Math.max(maxX, n.x + n.width)
  }
  const f = nodeMap.get(fromKey)
  const t = nodeMap.get(toKey)
  if (!f || !t) return 'right'
  return (f.x + f.width / 2 + t.x + t.width / 2) / 2 >= (minX + maxX) / 2 ? 'right' : 'left'
}

/** 节点中心。 */
function centerOf(n: ConnectorNode): { x: number; y: number } {
  return { x: n.x + n.width / 2, y: n.y + n.height / 2 }
}

/** 生成 n 个不含 0 的扇出槽位（升序，围绕 0 尽量对称）：
 * n=1 → [1]；n=2 → [-1,1]；n=3 → [-1,1,2]；n=4 → [-2,-1,1,2] */
function fanOutSlots(n: number): number[] {
  const seq: number[] = []
  for (let k = 1; seq.length < n; k++) {
    seq.push(k)
    if (seq.length < n) seq.push(-k)
  }
  return seq.sort((a, b) => a - b)
}

/** 沿节点边垂直方向的坐标（用于槽位排序）。 */
function slotOrderCoord(n: ConnectorNode, side: 'top' | 'bottom' | 'left' | 'right'): number {
  const c = centerOf(n)
  // 左右边 → 按 y 排序（垂直错开）；上下边 → 按 x 排序（水平错开）
  return side === 'left' || side === 'right' ? c.y : c.x
}

/** 线段共线重叠长度：两条线段在同一直线上且投影重叠 ≥ MIN_OVERLAP 才算「重合」。 */
function collinearOverlapLen(a1: Point, a2: Point, b1: Point, b2: Point, tol = 0.8): number {
  // 方向向量
  const d1x = a2.x - a1.x
  const d1y = a2.y - a1.y
  const d2x = b2.x - b1.x
  const d2y = b2.y - b1.y
  const len1 = Math.hypot(d1x, d1y)
  const len2 = Math.hypot(d2x, d2y)
  if (len1 < 1e-6 || len2 < 1e-6) return 0
  const u1x = d1x / len1
  const u1y = d1y / len1
  // 1) 方向一致（夹角 < ~1.2°，用单位向量叉积）
  const cross = Math.abs(u1x * d2y - u1y * d2x) / len2
  if (cross > Math.sin((1.2 * Math.PI) / 180)) return 0
  // 2) 同一直线：b1 落在 a 所在直线上（点到直线距离 < tol）
  const perp = Math.abs(d1x * (b1.y - a1.y) - d1y * (b1.x - a1.x)) / len1
  if (perp > tol) return 0
  // 3) 主导轴上投影重叠
  const horiz = Math.abs(d1y) <= Math.abs(d1x)
  const a0 = horiz ? Math.min(a1.x, a2.x) : Math.min(a1.y, a2.y)
  const a1p = horiz ? Math.max(a1.x, a2.x) : Math.max(a1.y, a2.y)
  const b0 = horiz ? Math.min(b1.x, b2.x) : Math.min(b1.y, b2.y)
  const b1p = horiz ? Math.max(b1.x, b2.x) : Math.max(b1.y, b2.y)
  const ov = Math.min(a1p, b1p) - Math.max(a0, b0)
  return Math.max(0, ov)
}

/** 两条边路径是否在空间上重合（线段共线重叠或过近交叉）。 */
export function edgesOverlap(
  a: { points: Point[] },
  b: { points: Point[] },
  minOverlap = 24,
): boolean {
  const segsOf = (e: { points: Point[] }) => {
    const segs: [Point, Point][] = []
    for (let i = 0; i < e.points.length - 1; i++) {
      const p1 = e.points[i]
      const p2 = e.points[i + 1]
      if (dist(p1, p2) < 1e-6) continue
      segs.push([p1, p2])
    }
    return segs
  }
  const segsA = segsOf(a)
  const segsB = segsOf(b)
  for (const s1 of segsA) {
    for (const s2 of segsB) {
      // 共线重叠 → 真重合
      if (collinearOverlapLen(s1[0], s1[1], s2[0], s2[1]) >= minOverlap) return true
    }
  }
  return false
}

/**
 * 路由一组边（批量）：
 * - 每个节点每侧的多条边【分配错开槽位】（slot 以 0 为中心，±1、±2…），
 *   同一侧的边从边中心向两侧扇形展开，间距 ≥ EDGE_SPACING
 * - 槽位按目标/源位置排序，保证扇出方向有序、交叉最少
 * - 若两条边槽位真正重叠且方向平行（needsSeparation），把后一条升级为 bezier
 * @param nodes 节点表（key → ConnectorNode）
 * @param requests 边请求列表
 */
export function routeEdgeBundle(
  nodes: Map<string, ConnectorNode> | Record<string, ConnectorNode>,
  requests: EdgeRequest[],
  opts: BundleOptions = {},
): RoutedBundle {
  const nodeMap = nodes instanceof Map ? nodes : new Map(Object.entries(nodes))
  const minBends = opts.minBends ?? 0
  const channelGap = opts.channelGap ?? EDGE_SPACING
  // 全局方向默认值，被未单独指定 direction 的请求继承
  const globalDirection = opts.direction ?? 'TB'
  const requestsWithDir = requests.map((r) => ({ ...r, direction: r.direction ?? globalDirection }))

  // ---- 1. 预路由一次以确定各边起止侧 ----
  const routed = requestsWithDir.map((req): { req: EdgeRequest; fromSide: 'top' | 'bottom' | 'left' | 'right'; toSide: 'top' | 'bottom' | 'left' | 'right' } | null => {
    const fromN = nodeMap.get(req.from)
    const toN = nodeMap.get(req.to)
    if (!fromN || !toN) return null
    const fC = centerOf(fromN)
    const tC = centerOf(toN)
    // 选边规则与 connectors.pickSide 保持一致：分层图优先走主方向侧，
    // 避免横向位移略大时误选水平桩点导致连线斜穿整图。
    const pick = (fc: { x: number; y: number }, tc: { x: number; y: number }): 'top' | 'bottom' | 'left' | 'right' => {
      const dx = tc.x - fc.x
      const dy = tc.y - fc.y
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)
      const dir = req.direction ?? globalDirection
      const MAIN_AXIS_MIN = 8
      if (dir === 'TB' && ady > MAIN_AXIS_MIN) return dy > 0 ? 'bottom' : 'top'
      if (dir === 'LR' && adx > MAIN_AXIS_MIN) return dx > 0 ? 'right' : 'left'
      if (adx >= ady) return dx >= 0 ? 'right' : 'left'
      return dy >= 0 ? 'bottom' : 'top'
    }
    // 自环边：不参与选边（由最终路由按 selfSide 生成环）
    // 菱形（决策节点）：按布局方向选桩点（是走主方向，否走侧向）
    // 回边：源出点 + 目标入点都选垂直主布局方向的侧（菱形保留分支语义）
    const direction = req.direction ?? 'TB'
    const fromSide = req.from === req.to
      ? 'right'
      : req.backedge
        ? fromN.shape === 'diamond'
          ? pickSideForShape(fromN, toN, true, pick(fC, tC), direction, req.branch)
          : backedgeExitSide(fC, tC, direction)
        : pickSideForShape(fromN, toN, true, pick(fC, tC), direction, req.branch)
    const toSide = req.from === req.to
      ? 'right'
      : req.backedge
        ? backedgeEntrySide(fC, tC, direction)
        : pickSideForShape(toN, fromN, false, pick(tC, fC), direction)
    return { req, fromSide, toSide }
  }).filter((x): x is NonNullable<typeof x> => x !== null)

  // ---- 1.5 回边目标侧重分配：尽量选目标节点【入边最少】的侧边 ----
  // 统计每个节点每侧的入边数（非回边优先占位），回边优先落到占用最少的侧。
  // 候选优先级：垂直主布局方向的侧（TB → left/right，LR → top/bottom）优先；
  // 若两侧都已被占用，再考虑主方向侧（top/bottom / left/right），
  // 使回边尽量落在"还没连接过的侧边"，视觉更均衡。
  const inCountBySide = new Map<string, Map<Side, number>>() // nodeId → { side: count }
  const countIn = (nodeId: string, side: Side) => {
    let m = inCountBySide.get(nodeId)
    if (!m) { m = new Map(); inCountBySide.set(nodeId, m) }
    m.set(side, (m.get(side) ?? 0) + 1)
  }
  // 先统计非回边的入边（固定侧，优先占位）
  for (const r of routed) {
    if (r.req.from === r.req.to || r.req.backedge) continue
    countIn(r.req.to, r.toSide)
  }
  // 回边：通道（gutter）由 routeEdge 按整图包围盒决定，但【锚点槽位】仍需协调 ——
  // 多条回边汇入同一节点时，如果都用中心锚点，箭头会叠在同一个点上。
  // 回边不参与下面的通用槽位分配（那套按"对齐/非对齐"排序，对回边没意义），
  // 这里直接按汇入序号给对称槽位（±1、±2 …），借 slotTo 传下去。
  // 按【走廊侧】分组，而不是按目标节点 —— 多条回边即使汇入不同节点，
  // 只要走同一侧走廊就会叠在同一条竖线上。这里按侧分组后给每条边一个序号，
  // 由 externalBackedgeRoute 用该序号把走廊逐条外扩。
  const backedgeSeq = new Map<number, number>() // routed 索引 → 该走廊内的序号
  const laneGroups = new Map<Side, number[]>()
  routed.forEach((r, i) => {
    if (r.req.from === r.req.to || !r.req.backedge) return
    const laneSide = backedgeLaneSide(nodeMap, r.req.from, r.req.to, globalDirection)
    if (!laneGroups.has(laneSide)) laneGroups.set(laneSide, [])
    laneGroups.get(laneSide)!.push(i)
    countIn(r.req.to, r.toSide)
  })
  // 同一走廊内按序号交错展开：0 → 0，1 → +1，2 → -1，3 → +2 …，
  // 保证相邻回边的走廊间距恒为 EDGE_SPACING，且对称分布在基准线两侧。
  for (const idxs of laneGroups.values()) {
    idxs.forEach((ri, ord) => {
      const slot = ord === 0 ? 0 : (ord % 2 === 1 ? 1 : -1) * Math.ceil(ord / 2)
      backedgeSeq.set(ri, slot)
    })
  }

  // ---- 2. 槽位分配：同一节点同一侧的边按目标位置排序，错开成扇形 ----
  // 目标/源节点与"连接方向"是否对齐（节点中心在该边法线上）：
  // 对齐的边拿走中心槽位 0，画成完美直线；非对齐的边围绕它向两侧扇出。
  const nodeCenter = new Map<string, { x: number; y: number }>()
  for (const n of nodeMap.values()) nodeCenter.set(n.key, centerOf(n))

  const byOut = new Map<string, number[]>()
  const byIn = new Map<string, number[]>()
  routed.forEach((r, i) => {
    // 自环边不参与槽位扇出（各自成环）
    if (r.req.from === r.req.to) return
    const ok = `${r.req.from}:${r.fromSide}`
    const ik = `${r.req.to}:${r.toSide}`
    if (!byOut.has(ok)) byOut.set(ok, [])
    if (!byIn.has(ik)) byIn.set(ik, [])
    byOut.get(ok)!.push(i)
    byIn.get(ik)!.push(i)
  })

  const slotFrom = new Map<number, number>()
  const slotTo = new Map<number, number>()
  const assign = (
    outMap: Map<number, number>,
    groups: Map<string, number[]>,
    coordOf: (r: NonNullable<(typeof routed)[number]>) => number,
    sideIdx: 'from' | 'to',
  ) => {
    for (const idxs of groups.values()) {
      // 注意：一条边两端各自独立对齐（起端对齐看 from 端，末端对齐看 to 端）。
      // 对齐轴：top/bottom 侧锚点沿 x 错开 → 直线需要 x 相同；left/right 侧沿 y 错开 → 直线需要 y 相同。
      const myAlign = sideIdx === 'from'
        ? (r: NonNullable<(typeof routed)[number]>) => {
            const fromC = nodeCenter.get(r.req.from)!
            const toC = nodeCenter.get(r.req.to)!
            const A = r.fromSide === 'top' || r.fromSide === 'bottom' ? 'x' : 'y'
            return Math.abs(fromC[A] - toC[A]) < 0.5
          }
        : (r: NonNullable<(typeof routed)[number]>) => {
            const fromC = nodeCenter.get(r.req.from)!
            const toC = nodeCenter.get(r.req.to)!
            const A = r.toSide === 'top' || r.toSide === 'bottom' ? 'x' : 'y'
            return Math.abs(fromC[A] - toC[A]) < 0.5
          }
      const aligned = idxs.filter((i) => myAlign(routed[i]))
      const nonAligned = idxs.filter((i) => !myAlign(routed[i]))
      if (aligned.length > 0) {
        // 若有多条对齐边（同列多源→同目标），第一条中心，其余按位置错开（避免覆盖）
        aligned.forEach((i, pos) => {
          outMap.set(i, pos === 0 ? 0 : pos)
        })
        // 非对齐边围绕中心向两侧扇出（用无 0 槽位）
        const free = fanOutSlots(nonAligned.length)
        const sorted = [...nonAligned].sort((a, b) => coordOf(routed[a]) - coordOf(routed[b]))
        sorted.forEach((i, pos) => outMap.set(i, free[pos]))
      } else {
        if (idxs.length <= 1) {
          outMap.set(idxs[0], 0) // 单条边 → 中心锚点
          continue
        }
        // 无对齐边：按位置排序，0 为中心（n=2 → -0.5,+0.5；n=3 → -1,0,+1）
        const sorted = [...idxs].sort((a, b) => coordOf(routed[a]) - coordOf(routed[b]))
        const total = sorted.length
        sorted.forEach((i, pos) => {
          outMap.set(i, pos - (total - 1) / 2)
        })
      }
    }
  }

  // 出口槽位：按目标节点沿 fromSide 垂直方向的坐标排序
  assign(
    slotFrom,
    byOut,
    (r) => slotOrderCoord(nodeMap.get(r.req.to)!, r.toSide as 'top' | 'bottom' | 'left' | 'right'),
    'from',
  )
  // 入口槽位：按源节点沿 toSide 垂直方向的坐标排序
  assign(
    slotTo,
    byIn,
    (r) => slotOrderCoord(nodeMap.get(r.req.from)!, r.fromSide as 'top' | 'bottom' | 'left' | 'right'),
    'to',
  )

  // ---- 2.5 入/出分离：同一节点同一侧既有入边又有出边时，把入边槽位整体偏移半档，
  //     使进出锚点不落在同一位置（否则一条出边从槽位 0 出发、一条入边也停槽位 0，
  //     视觉上重叠）。半档偏移（±0.5）保留对齐判定的错开，又不会破坏直线对齐。 ----
  if (opts.separateInOut) {
    const sideTraffic = new Map<string, { inCount: number; outCount: number }>()
    routed.forEach((r, i) => {
      if (r.req.from === r.req.to) return // 自环不参与
      const outKey = `${r.req.from}:${r.fromSide}`
      const inKey = `${r.req.to}:${r.toSide}`
      let o = sideTraffic.get(outKey)
      if (!o) { o = { inCount: 0, outCount: 0 }; sideTraffic.set(outKey, o) }
      o.outCount++
      let p = sideTraffic.get(inKey)
      if (!p) { p = { inCount: 0, outCount: 0 }; sideTraffic.set(inKey, p) }
      p.inCount++
    })
    routed.forEach((r, i) => {
      if (r.req.from === r.req.to) return
      const outKey = `${r.req.from}:${r.fromSide}`
      const inKey = `${r.req.to}:${r.toSide}`
      const outSide = sideTraffic.get(outKey)
      const inSide = sideTraffic.get(inKey)
      // 同侧既有入又有出 → 入边整体偏移 +0.5（出边保持 0 中心对齐直线）
      if (inSide && inSide.inCount > 0 && inSide.outCount > 0) {
        slotTo.set(i, (slotTo.get(i) ?? 0) + 0.5)
      }
      // 出边侧若也有入边，同样保证错开（入边已偏移，出边可保持）
      void outSide
    })
  }

  // ---- 3. 检测真正重叠的平行边，标记需分离（升级为 bezier） ----
  // 槽位已错开 → 只有槽位相同（重叠）且方向平行的边才需要分离
  const separated = new Set<number>()
  const finalPoints = routed.map((r, i) =>
    routeEdge(nodeMap.get(r.req.from)!, nodeMap.get(r.req.to)!, {
      type: r.req.type ?? 'straight',
      dashed: r.req.dashed,
      arrow: r.req.arrow,
      minBends: r.req.minBends ?? minBends,
      slotFrom: slotFrom.get(i) ?? 0,
      slotTo: slotTo.get(i) ?? 0,
      bendIdx: Math.round(slotFrom.get(i) ?? 0),
    }),
  )
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      const a = routed[i]
      const b = routed[j]
      if (a.req.from === a.req.to || b.req.from === b.req.to) continue // 自环边不参与平行边分离
      // 曲线边（arc/bezier/smooth）的 points 只是弦（fromP→toP），真实路径是
      // pathD 曲线——用弦做共线检测会把互为反向的两条曲线误判为“重叠”而错误升级。
      // 曲线边的分离交给槽位扇出与自身弯曲即可，不参与弦共线升级。
      const aCurve = a.req.type === 'arc' || a.req.type === 'bezier' || a.req.type === 'smooth'
      const bCurve = b.req.type === 'arc' || b.req.type === 'bezier' || b.req.type === 'smooth'
      if (aCurve || bCurve) continue
      const sameSide = a.fromSide === b.fromSide && a.toSide === b.toSide
      // 槽位不同 → 已在空间上错开，无需分离
      const slotDist = Math.abs((slotFrom.get(i) ?? 0) - (slotFrom.get(j) ?? 0))
      // 触发条件：
      //  1) 同侧且槽位重叠 + 空间过近（原 needsSeparation）
      //  2) 任意两条边的路径线段【共线重合】（edgesOverlap）—— 无论是否同侧
      const needSeparate = sameSide && slotDist < 1 && needsSeparation(finalPoints[i], finalPoints[j])
      const overlap = !sameSide || slotDist >= 1 ? edgesOverlap(finalPoints[i], finalPoints[j]) : false
      if (needSeparate || overlap) {
        separated.add(j) // 后一条升级
      }
    }
  }

  // ---- 3.5 绝对锚点去冲突（架构图层间路由专需）----
  // 上面的槽位是「相对同一模块」的序号，不同模块的槽位 0 各自落在中心线上。
  // 但层间路由的垂直段按绝对 x 绘制，两个不同模块锚点 x 相同时，
  // 垂直段会完全重叠（实测 user→redis 与 product→mysql 重叠 172px）。
  // 这里按「同一层间空隙 + 同侧（出/入）」分组，把冲突锚点沿 x 推开。
  const absAnchor = new Map<number, { out?: number; in?: number }>()
  {
    type Rec = { idx: number; side: 'out' | 'in'; x: number; min: number; max: number }
    const groups = new Map<string, Rec[]>()
    const anchorOf = (mod: ConnectorNode, slot: number) => {
      const c = mod.x + mod.width / 2
      return Math.max(
        mod.x + EDGE_SPACING,
        Math.min(mod.x + mod.width - EDGE_SPACING, c + slot * EDGE_SPACING),
      )
    }
    routed.forEach((r, i) => {
      if (r.req.from === r.req.to) return
      const fl = r.req.fromLayer
      const tl = r.req.toLayer
      if (!fl || !tl) return
      if (fl.x === tl.x && fl.y === tl.y && fl.width === tl.width) return
      const fromAbove = fl.y + fl.height <= tl.y
      const toAbove = tl.y + tl.height <= fl.y
      if (!fromAbove && !toAbove) return

      const fromMod = nodeMap.get(r.req.from)
      const toMod = nodeMap.get(r.req.to)
      if (!fromMod || !toMod) return
      const [upper, lower] = fromAbove ? [fromMod, toMod] : [toMod, fromMod]
      const [upperLayer, lowerLayer] = fromAbove ? [fl, tl] : [tl, fl]
      // 分组键用【上层框】而不是「层间空隙」：
      // 跨多层连线（如 业务层→数据层，跨过中间件层）与相邻层连线的空隙不同，
      // 它们的垂直段却同样从上层框底部出发，会在同一段区间内重叠。
      // 按上层框分组才能捕获这类冲突。
      const [uSlot, lSlot] = fromAbove
        ? [slotFrom.get(i) ?? 0, slotTo.get(i) ?? 0]
        : [slotTo.get(i) ?? 0, slotFrom.get(i) ?? 0]

      for (const [side, mod, slot] of [
        ['out', upper, uSlot],
        ['in', lower, lSlot],
      ] as const) {
        // 出线按【上层框】分组；入线按【下层框】分组（入线垂直段贴着下层框顶边）
        const layerKey = side === 'out' ? `${upperLayer.y}` : `${lowerLayer.y}`
        const key = `${layerKey}#${side}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push({
          idx: i,
          side,
          x: anchorOf(mod, slot),
          min: mod.x + EDGE_SPACING,
          max: mod.x + mod.width - EDGE_SPACING,
        })
      }
    })

    // 同组内按 x 排序，相邻间距不足 EDGE_SPACING 时把后者推到位（不超出模块边界）
    for (const recs of groups.values()) {
      recs.sort((a, b) => a.x - b.x)
      for (let k = 1; k < recs.length; k++) {
        const need = recs[k - 1].x + EDGE_SPACING
        if (recs[k].x < need - 0.5) recs[k].x = Math.min(recs[k].max, need)
      }
      for (const rec of recs) {
        const cur = absAnchor.get(rec.idx) ?? {}
        absAnchor.set(rec.idx, { ...cur, [rec.side]: rec.x })
      }
    }
  }

  // ---- 4. 最终路由 ----
  const allNodes = [...nodeMap.values()]
  const edges: (RoutedEdge & { key: string })[] = []
  // 自环边：同一节点的多个环依次分配 top/right/bottom/left 四面
  const selfCount = new Map<string, number>()
  routed.forEach((r, i) => {
    const { req } = r
    const isSelf = req.from === req.to
    // 重合升级：原来是直线 → 用正交绕行；已经是曲线/正交 → 保持/换 bezier 弯曲
    let type = req.type ?? 'straight'
    if (separated.has(i)) {
      type = type === 'straight' ? 'orthogonal' : type === 'orthogonal' ? 'orthogonal' : 'bezier'
    }
    // 回边不走通用槽位分配（见上文），改为按「汇入序号」给对称槽位：
    // 第 1 条落 -1，第 2 条落 +1，第 3 条落 -2 …，保证箭头沿目标边均匀散开。
    let slotF = slotFrom.get(i) ?? 0
    let slotT = slotTo.get(i) ?? 0
    if (req.backedge && !isSelf) {
      const slot = backedgeSeq.get(i) ?? 0
      slotT = slot
      slotF = slot // 源端也用同样偏移，走廊两侧对称展开
    }
    const selfN = isSelf ? (selfCount.get(req.from) ?? 0) : 0
    if (isSelf) selfCount.set(req.from, selfN + 1)
    const selfSide = isSelf ? (['right', 'bottom', 'left', 'top'][selfN % 4] as 'top' | 'right' | 'bottom' | 'left') : undefined
    const edge = routeEdge(nodeMap.get(req.from)!, nodeMap.get(req.to)!, {
      type,
      dashed: req.dashed,
      label: req.label,
      arrow: req.arrow,
      minBends: req.minBends ?? minBends,
      slotFrom: slotF,
      slotTo: slotT,
      // 通道错开：同一走廊的多条边按槽位偏移中间水平段
      channelShift: slotF * channelGap,
      bendIdx: Math.round(slotF),
      selfSide,
      direction: req.direction,
      branch: req.branch,
      backedge: req.backedge,
      fromLayer: req.fromLayer,
      toLayer: req.toLayer,
      // 经 3.5 全局去冲突后的绝对锚点（覆盖相对槽位）
      absFromX: absAnchor.get(i)?.out,
      absToX: absAnchor.get(i)?.in,
      allLayers: req.allLayers,
      // 用预路由协调后的桩点（回边目标侧已选占用最少的侧）
      fromSide: r.fromSide,
      toSide: r.toSide,
      // 正交避障：排除 from/to 自身；额外障碍物（层框）一并参与绕行。
      // 层框对「端点所在的框」豁免，否则边无法离开自己的层。
      obstacles: [...allNodes, ...(opts.extraObstaclesFor?.(req.from, req.to) ?? [])].filter(
        (n) => n.key !== req.from && n.key !== req.to,
      ),
    })
    edges.push({ ...edge, key: `${req.from}->${req.to}` })
  })

  return { edges }
}
