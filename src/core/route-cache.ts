/**
 * 冻结路由（frozen route）：把「规划阶段算出的最终连线路径」写进 edge 元素，
 * 渲染层（SVG）与 Excalidraw 导出优先复用它，不再重算。
 *
 * 为什么需要：
 *   架构图 / ER 图的规划器（planArchitectureDiagram / planErDiagram）已经用
 *   routeEdgeBundle 算过一遍路径（含槽位扇出、层感知路由、正交避障），但绘制层
 *   把路径丢掉了 —— edge.data 里只留 from/to/type，于是渲染层用另一次
 *   routeEdgeBundle 重算。两次调用的参数并不一致（架构图规划用 minBends:1、
 *   渲染用 minBends:0；规划不带层框信息、渲染带），结果就是「规划时算得好好的
 *   路径」被一份更差的路径覆盖，边看起来贴边 / 斜穿。
 *
 * 做法：计划里把 RoutedEdge 连同两端节点当时的矩形一起冻结进 edge.data.route；
 * 渲染前先校验「两端节点的相对关系未变」——允许整体平移（居中、fitSceneContent
 * 都会整体平移），不允许单独移动或改尺寸。校验通过就把整条路径平移复用，
 * 否则退回重新路由，保证交互编辑（update_element 移动节点）后连线仍然跟随。
 */

import type { ArrowHead, ConnectorNode, EdgeType, RoutedEdge, Side } from './connectors.js'
import type { Point } from './geometry.js'

/**
 * 冻结所需的最小字段集。
 * 用结构子类型（而非直接要求 RoutedEdge）是为了让规划器自己的输出类型
 * （ErDiagram.relations / ArchDiagram.links）也能直接冻结 —— 它们已经携带
 * 完整路径，只是没有 dashed/label/arrow 这几个「非几何」字段（渲染层从
 * edge.data 取，不参与冻结）。
 */
export interface FreezableRoute {
  points: { x: number; y: number }[]
  pathD: string
  type: EdgeType
  fromSide: Side
  toSide: Side
  arrowTip: Point
  arrowAngle: number
  fromTip: Point
  fromAngle: number
  /** 分支边（菱形是/否）：标签贴近起点。 */
  branchLabel?: boolean
}

export interface FrozenRoute {
  /** 路由时 from 节点的外接盒 [x, y, width, height]。 */
  from: [number, number, number, number]
  /** 路由时 to 节点的外接盒 [x, y, width, height]。 */
  to: [number, number, number, number]
  points: [number, number][]
  pathD: string
  type: EdgeType
  fromSide: Side
  toSide: Side
  arrowTip: [number, number]
  arrowAngle: number
  fromTip: [number, number]
  fromAngle: number
  /** 分支边（菱形是/否）：标签贴近起点。 */
  branchLabel?: boolean
}

/** 位置比较容差（px）：覆盖浮点抖动与 0.01 级舍入。 */
const TOL = 0.5
/** 两端平移量必须一致，容差同上。 */
const DELTA_TOL = 0.5

function rectOf(n: ConnectorNode): [number, number, number, number] {
  return [n.x, n.y, n.width, n.height]
}

function isNumPair(v: unknown): boolean {
  return Array.isArray(v) && v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))
}

function asRect(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length < 4) return null
  const r = v.map(Number)
  return r.every(Number.isFinite) ? (r as [number, number, number, number]) : null
}

/** 把一条已算好的路由冻结为可序列化的数据。 */
export function freezeRoute(routed: FreezableRoute, from: ConnectorNode, to: ConnectorNode): FrozenRoute {
  return {
    from: rectOf(from),
    to: rectOf(to),
    points: routed.points.map((p): [number, number] => [p.x, p.y]),
    pathD: routed.pathD,
    type: routed.type,
    fromSide: routed.fromSide,
    toSide: routed.toSide,
    arrowTip: [routed.arrowTip.x, routed.arrowTip.y],
    arrowAngle: routed.arrowAngle,
    fromTip: [routed.fromTip.x, routed.fromTip.y],
    fromAngle: routed.fromAngle,
    branchLabel: routed.branchLabel,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 平移 pathD 中的所有绝对坐标。
 *
 * 不能只平移 points —— bezier / arc / smooth 的 points 只是弦（起终点），
 * 真实曲线在 pathD 里（`C` 控制点、`A` 半径与终点）。按命令逐段解析：
 *   M/L/C：每两个数字是一组坐标
 *   A：`rx ry rot largeArc sweep x y` —— 只有最后两个是坐标，前五个必须原样保留，
 *      否则半径被平移会画出畸形的弧（这也是 fit.ts 里解析 pathD 时踩过的坑）。
 */
export function translatePathD(d: string, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return d
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return d
  return d.replace(/([MLCA])([^MLCA]*)/g, (whole, cmd: string, rest: string) => {
    const nums = (rest.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    if (cmd === 'A') {
      if (nums.length < 7) return whole
      nums[nums.length - 2] = round2(nums[nums.length - 2] + dx)
      nums[nums.length - 1] = round2(nums[nums.length - 1] + dy)
    } else {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        nums[i] = round2(nums[i] + dx)
        nums[i + 1] = round2(nums[i + 1] + dy)
      }
    }
    // 每个数字前补一个空格：命令字母可以直接跟在数字后（SVG 合法），
    // 但省略分隔会让 pathD 难以阅读，也不利于后续正则解析。
    return cmd + nums.map((n) => ` ${n}`).join('')
  })
}

/**
 * 尝试复用冻结路由。返回 null 表示已失效（节点被单独移动 / 改尺寸 / 数据损坏），
 * 调用方应退回重新路由。
 *
 * @param frozen edge.data.route（来自 JSON，需完整校验）
 * @param meta   非几何信息（dashed / label / arrow）由元素 data 提供，不参与冻结
 */
export function reviveRoute(
  frozen: unknown,
  from: ConnectorNode,
  to: ConnectorNode,
  meta: { dashed?: boolean; label?: string; arrow?: ArrowHead } = {},
): RoutedEdge | null {
  if (!frozen || typeof frozen !== 'object') return null
  const f = frozen as Partial<FrozenRoute>
  const rf = asRect(f.from)
  const rt = asRect(f.to)
  if (!rf || !rt) return null

  // 尺寸变化 → 锚点需要重算，路由失效
  if (Math.abs(from.width - rf[2]) > TOL || Math.abs(from.height - rf[3]) > TOL) return null
  if (Math.abs(to.width - rt[2]) > TOL || Math.abs(to.height - rt[3]) > TOL) return null

  // 只允许整体平移：两端的位移必须一致，否则说明有节点被单独移动过
  const dx = from.x - rf[0]
  const dy = from.y - rf[1]
  if (Math.abs(to.x - rt[0] - dx) > DELTA_TOL || Math.abs(to.y - rt[1] - dy) > DELTA_TOL) return null

  if (!Array.isArray(f.points) || f.points.length < 2 || !f.points.every(isNumPair)) return null
  if (typeof f.pathD !== 'string' || !f.pathD) return null
  if (!isNumPair(f.arrowTip) || !isNumPair(f.fromTip)) return null
  if (typeof f.arrowAngle !== 'number' || typeof f.fromAngle !== 'number') return null
  if (typeof f.type !== 'string' || !f.fromSide || !f.toSide) return null

  const shift = (p: [number, number]) => ({ x: round2(p[0] + dx), y: round2(p[1] + dy) })
  return {
    from: from.key,
    to: to.key,
    type: f.type,
    dashed: meta.dashed ?? false,
    label: meta.label,
    arrow: meta.arrow ?? 'triangle',
    points: f.points.map(shift),
    pathD: translatePathD(f.pathD, dx, dy),
    fromSide: f.fromSide,
    toSide: f.toSide,
    arrowTip: shift(f.arrowTip as [number, number]),
    arrowAngle: f.arrowAngle,
    fromTip: shift(f.fromTip as [number, number]),
    fromAngle: f.fromAngle,
    branchLabel: f.branchLabel,
  }
}
