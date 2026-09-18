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
}

export interface RoutedBundle {
  edges: (RoutedEdge & { key: string })[]
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
    const pick = (fc: { x: number; y: number }, tc: { x: number; y: number }): 'top' | 'bottom' | 'left' | 'right' => {
      const dx = tc.x - fc.x
      const dy = tc.y - fc.y
      if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
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
  // 回边：优先选垂直主方向侧中入边最少者；若两侧都占满，回退主方向侧
  const backedgeDir = globalDirection
  for (const r of routed) {
    if (r.req.from === r.req.to || !r.req.backedge) continue
    const toN = nodeMap.get(r.req.to)
    if (!toN) continue
    const m = inCountBySide.get(r.req.to)
    const perpendicular: Side[] = backedgeDir === 'TB' ? ['left', 'right'] : ['top', 'bottom']
    const mainDir: Side[] = backedgeDir === 'TB' ? ['top', 'bottom'] : ['left', 'right']
    const perpCounts = perpendicular
      .map((s) => ({ side: s, n: m?.get(s) ?? 0 }))
      .sort((a, b) => a.n - b.n)
    // 垂直侧若有一侧未占用 → 选占用最少者；否则退到主方向侧最少者
    const bestPerp = perpCounts[0]
    let chosen: Side
    if (bestPerp.n === 0) {
      chosen = bestPerp.side
    } else {
      const mainCounts = mainDir
        .map((s) => ({ side: s, n: m?.get(s) ?? 0 }))
        .sort((a, b) => a.n - b.n)
      chosen = mainCounts[0].side
    }
    r.toSide = chosen
    countIn(r.req.to, chosen)
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
    const slotF = slotFrom.get(i) ?? 0
    const slotT = slotTo.get(i) ?? 0
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
      // 用预路由协调后的桩点（回边目标侧已选占用最少的侧）
      fromSide: r.fromSide,
      toSide: r.toSide,
      // 正交避障：排除 from/to 自身
      obstacles: allNodes.filter((n) => n.key !== req.from && n.key !== req.to),
    })
    edges.push({ ...edge, key: `${req.from}->${req.to}` })
  })

  return { edges }
}
