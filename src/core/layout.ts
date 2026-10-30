/**
 * 布局系统 —— 基于 @antv/layout 2.x（AntV 官方图布局算法库）
 *   - layered    分层布局（流程/有向图）→ AntVDagreLayout（rankdir 支持 TB/LR）
 *   - tree       树形布局 → AntVDagreLayout（树是有向分层图的特例）
 *   - grid       网格布局 → GridLayout
 *   - circular   环形布局 → CircularLayout
 *
 * 流程图（layered）严格使用 AntVDagreLayout：
 *   先检测环并【移除回边】得到无环子图 → AntVDagreLayout 布局节点坐标，
 *   环边（回退/迭代边）不参与布局，由绘制层最后补画。
 *
 * 所有布局只计算坐标，不写场景 —— 返回 { nodes: Record<key, rect> }，
 * 渲染层/工具层再据坐标生成元素。
 *
 * @antv/layout 的 execute() 是异步的，computeLayout 同步包装为 async；
 * 调用方（diagram-tools 的 handler 均为 async）无需其他改动。
 */

import { AntVDagreLayout, type GraphData } from '@antv/layout'
import type { ConnectorNode } from './connectors.ts'
import type { ShapeType } from './shapes.ts'

export interface LayoutNodeSpec {
  key: string
  label?: string
  shape?: ShapeType
  width?: number
  height?: number
  fill?: string
}

export interface LayoutEdgeSpec {
  from: string
  to: string
  label?: string
  type?: 'straight' | 'orthogonal' | 'bezier' | 'smooth' | 'arc'
  dashed?: boolean
}

export type LayoutKind = 'layered' | 'tree' | 'grid' | 'circular'

export interface LayoutOptions {
  kind?: LayoutKind
  /** 分层/树：列间距。网格：水平间距。 */
  columnGap?: number
  /** 分层/树：行间距。网格：垂直间距。 */
  rowGap?: number
  padding?: number
  orthogonal?: boolean
  /** 树布局时是否垂直方向。 */
  direction?: 'LR' | 'TB'
}

export interface LayoutResult {
  kind: LayoutKind
  sceneWidth: number
  sceneHeight: number
  /** key → 最终外接盒（top-left）。 */
  nodes: Record<string, { x: number; y: number; width: number; height: number }>
  centers: Record<string, { x: number; y: number }>
  /** 布局阶段识别出的回边（构成环、被移除后布局的边）。绘制层据此补画并优化桩点。 */
  backEdges?: { from: string; to: string }[]
}

const DEF_W = 200
const DEF_H = 72

/**
 * @antv/layout 的间距放大系数（实测值，与节点尺寸无关）。
 * AntVDagreLayout 把节点尺寸扩展为 [w + 2*nodesep, h + 2*ranksep]，
 * 于是实际视觉间隙 = 同层 3×nodesep、跨层 2×ranksep。
 * 传入前先除以该系数，使 columnGap / rowGap 的语义等于真实像素间隙。
 */
const GAP_SCALE_NODE = 3
const GAP_SCALE_RANK = 2

/** 默认视觉间隙（px）：同层节点水平间距 / 相邻层垂直间距。 */
export const DEF_COLUMN_GAP = 60
export const DEF_ROW_GAP = 70

export async function computeLayout(
  nodes: LayoutNodeSpec[],
  edges: LayoutEdgeSpec[],
  opts: LayoutOptions = {},
): Promise<LayoutResult> {
  const kind = opts.kind ?? 'layered'
  const columnGap = opts.columnGap ?? DEF_COLUMN_GAP
  const rowGap = opts.rowGap ?? DEF_ROW_GAP
  const padding = opts.padding ?? 60
  const direction = opts.direction ?? 'TB'
  const sizeOf = (k: string) => {
    const n = nodes.find((x) => x.key === k)
    return { w: n?.width ?? DEF_W, h: n?.height ?? DEF_H }
  }

  // 注意：不把 size 塞进节点数据 —— dagre 的 formatSizeFn 优先读数据 size 且按"直径"语义解释，
  // 会导致不同尺寸节点列宽错乱；统一走 nodeSize 函数（返回 [宽, 高]）最可靠。
  const nodeSize = (n: { id: string }) => sizeOf(String(n.id))

  let result: { nodes: Map<string, { x: number; y: number }>; width: number; height: number }
  let backEdges: { from: string; to: string }[] = []

  switch (kind) {
    case 'grid': {
      result = runGrid(nodes, nodeSize, columnGap, rowGap)
      break
    }
    case 'circular': {
      result = runCircular(nodes, nodeSize)
      break
    }
    case 'tree': {
      // 树形：dagre 分层 + LR/TB 方向。与 layered 共用同一套间距语义，
      // 不在内部做 Math.max 兜底（那会让用户传入的值失真）。
      const data = toGraphData(nodes, edges)
      result = await runDagre(data, nodeSize, direction, columnGap, rowGap)
      break
    }
    default: {
      // layered：严格用 AntVDagreLayout。
      // 先检测环并移除回边 → 对无环子图布局；环边不参与布局，由绘制层最后补画。
      backEdges = findBackEdges(nodes, edges)
      const backKeys = new Set(backEdges.map((e) => `${e.from}->${e.to}`))
      const dagEdges = edges.filter((e) => e.from !== e.to && !backKeys.has(`${e.from}->${e.to}`))
      const data = toGraphData(nodes, dagEdges)
      result = await runDagre(data, nodeSize, direction, columnGap, rowGap)
      break
    }
  }

  // dagre/grid 输出节点中心坐标 → 转 top-left 外接盒，并统一平移到 padding 起始
  const rects = new Map<string, { x: number; y: number; width: number; height: number }>()
  let minX = Infinity
  let minY = Infinity
  for (const n of nodes) {
    const c = result.nodes.get(n.key)
    if (!c) continue
    const { w, h } = sizeOf(n.key)
    const x = c.x - w / 2
    const y = c.y - h / 2
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0 }
  let contentMaxX = -Infinity
  let contentMaxY = -Infinity
  for (const n of nodes) {
    const c = result.nodes.get(n.key)
    if (!c) continue
    const { w, h } = sizeOf(n.key)
    const x = c.x - w / 2 - minX + padding
    const y = c.y - h / 2 - minY + padding
    rects.set(n.key, { x, y, width: w, height: h })
    contentMaxX = Math.max(contentMaxX, x + w)
    contentMaxY = Math.max(contentMaxY, y + h)
  }

  const centers: Record<string, { x: number; y: number }> = {}
  const out: LayoutResult['nodes'] = {}
  for (const n of nodes) {
    const r = rects.get(n.key)
    if (!r) continue
    out[n.key] = r
    centers[n.key] = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }
  // 画布 = 内容包围盒 + 两侧 padding。用实际 rects 反算，
  // 而不是直接信 result.width —— 各布局引擎返回的 width 语义不一致
  // （dagre 返回末节点中心、circular 返回包围盒边长），直接相加会漏掉半侧留白。
  const contentW = Number.isFinite(contentMaxX) ? contentMaxX - padding : 0
  const contentH = Number.isFinite(contentMaxY) ? contentMaxY - padding : 0
  return {
    kind,
    sceneWidth: contentW + padding * 2,
    sceneHeight: contentH + padding * 2,
    nodes: out,
    centers,
    backEdges,
  }
}

interface RawResult {
  nodes: Map<string, { x: number; y: number }>
  width: number
  height: number
}

/** 构建 @antv/layout 的 GraphData（自环边排除）。 */
function toGraphData(nodes: LayoutNodeSpec[], edges: LayoutEdgeSpec[]): GraphData {
  return {
    nodes: nodes.map((n) => ({ id: n.key })),
    edges: edges
      .filter((e) => e.from !== e.to)
      .map((e, i) => ({ id: `e${i}`, source: e.from, target: e.to })),
  }
}

async function runDagre(
  data: GraphData,
  nodeSize: (n: { id: string }) => { w: number; h: number },
  direction: 'LR' | 'TB',
  columnGap: number,
  rowGap: number,
): Promise<RawResult> {
  const layout = new AntVDagreLayout({
    nodeSize: (n: { id?: unknown }) => {
      const { w, h } = nodeSize({ id: String(n?.id ?? '') })
      return [w, h]
    },
    rankdir: direction,
    // @antv/layout 的间距补偿：它在 index.js 里把节点尺寸扩成
    //   width  = 原宽 + 2 * nodesep
    //   height = 原高 + 2 * ranksep
    // 因此 dagre 内部真正生效的间隙是「同层 3×nodesep / 跨层 2×ranksep」
    // （同层还叠加了 dagre 自身的 nodesep，跨层则是上下两半 ranksep 之和）。
    // 这里反算回传，保证对外暴露的 columnGap / rowGap 就是【实际像素间隙】。
    nodesep: columnGap / GAP_SCALE_NODE,
    ranksep: rowGap / GAP_SCALE_RANK,
    // 默认 ranker（network-simplex）：分层质量最好。
    directed: true,
    multigraph: true,
  })
  await layout.execute(data)
  const nodes = new Map<string, { x: number; y: number }>()
  let maxX = 0
  let maxY = 0
  layout.forEachNode((n) => {
    nodes.set(String(n.id), { x: n.x, y: n.y })
    maxX = Math.max(maxX, n.x)
    maxY = Math.max(maxY, n.y)
  })
  layout.destroy()
  return { nodes, width: maxX, height: maxY }
}

/**
 * 网格布局：按列宽/行高各自取最大值排布（类似 ER 图的网格前缀和）。
 *
 * 不用 @antv/layout 的 GridLayout —— 实测它的 `nodeSpacing` 选项完全未参与
 * 定位计算（无论传 10 还是 200，实际间隙恒为 10px），无法表达用户指定的间距。
 * 自己排布可以保证 columnGap / rowGap 就是真实像素间隙，且宽窄不一的
 * 节点不会互相挤压。
 */
function runGrid(
  nodes: LayoutNodeSpec[],
  nodeSize: (n: { id: string }) => { w: number; h: number },
  columnGap: number,
  rowGap: number,
): RawResult {
  const out = new Map<string, { x: number; y: number }>()
  if (nodes.length === 0) return { nodes: out, width: 0, height: 0 }

  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  const sizes = nodes.map((n) => nodeSize({ id: n.key }))
  const colWidths = Array<number>(cols).fill(0)
  const rowHeights: number[] = []
  nodes.forEach((n, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    colWidths[col] = Math.max(colWidths[col], sizes[i].w)
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, sizes[i].h)
  })

  // 前缀和：第 c 列左边缘 / 第 r 行上边缘
  const colX = [0]
  for (let c = 1; c < cols; c++) colX[c] = colX[c - 1] + colWidths[c - 1] + columnGap
  const rowY = [0]
  for (let r = 1; r < rowHeights.length; r++) rowY[r] = rowY[r - 1] + rowHeights[r - 1] + rowGap

  let maxX = 0
  let maxY = 0
  nodes.forEach((n, i) => {
    const { w, h } = sizes[i]
    const col = i % cols
    const row = Math.floor(i / cols)
    // 列内水平居中，行内顶部对齐（不同高度的节点重心更稳）
    const x = colX[col] + (colWidths[col] - w) / 2
    const y = rowY[row]
    // 与 dagre 输出保持一致：返回中心坐标，由外层统一转成 top-left
    out.set(n.key, { x: x + w / 2, y: y + h / 2 })
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  })
  return { nodes: out, width: maxX, height: maxY }
}

/**
 * 环形布局：节点均匀分布在同一个圆上（自己算，不用 @antv/layout 的 CircularLayout）。
 *
 * CircularLayout 会把 radius 与 centerSize 等选项组合成一个"螺旋"分布，
 * 实测 8 个同尺寸节点的中心到圆心距离在 119~323 之间乱跳 —— 节点根本不在同一个圆上，
 * 连线全部缠绕重叠。自己按极坐标算能严格保证一致性。
 */
function runCircular(
  nodes: LayoutNodeSpec[],
  nodeSize: (n: { id: string }) => { w: number; h: number },
): RawResult {
  const out = new Map<string, { x: number; y: number }>()
  const n = nodes.length
  if (n === 0) return { nodes: out, width: 0, height: 0 }
  if (n === 1) {
    const { w, h } = nodeSize({ id: nodes[0].key })
    out.set(nodes[0].key, { x: w / 2, y: h / 2 })
    return { nodes: out, width: w, height: h }
  }

  // 半径：保证相邻节点弦长 ≥ 最大节点外接圆直径，避免圆周上互相挤压
  const maxNode = nodes.reduce((m, nd) => {
    const { w, h } = nodeSize({ id: nd.key })
    return Math.max(m, Math.max(w, h))
  }, 0)
  const chordNeeded = maxNode * 1.25
  const radius = Math.max(chordNeeded / (2 * Math.sin(Math.PI / n)), maxNode * 1.2)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  nodes.forEach((nd, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n
    const { w, h } = nodeSize({ id: nd.key })
    // 与 dagre/grid 一致：返回中心坐标，由外层统一转 top-left
    const cx = Math.cos(angle) * radius
    const cy = Math.sin(angle) * radius
    out.set(nd.key, { x: cx, y: cy })
    minX = Math.min(minX, cx - w / 2)
    minY = Math.min(minY, cy - h / 2)
    maxX = Math.max(maxX, cx + w / 2)
    maxY = Math.max(maxY, cy + h / 2)
  })
  // 上层用 sceneWidth/2 作为几何中心来定位，因此返回的尺寸必须是
  // 「以原点为中心的包围盒边长」= 2×max(|min|, |max|)，而不是 max-min。
  // 用 max-min 会让原点偏移到包围盒左上角，节点看起来不在同一个圆上。
  const halfW = Math.max(Math.abs(minX), Math.abs(maxX))
  const halfH = Math.max(Math.abs(minY), Math.abs(maxY))
  return { nodes: out, width: halfW * 2, height: halfH * 2 }
}

/** 便捷函数：把 LayoutResult 转成 ConnectorNode 列表（供路由）。 */
export function layoutToConnectorNodes(layout: LayoutResult, shapes: Record<string, ShapeType> = {}): ConnectorNode[] {
  const out: ConnectorNode[] = []
  for (const [key, r] of Object.entries(layout.nodes)) {
    out.push({ key, shape: shapes[key] ?? 'rectangle', x: r.x, y: r.y, width: r.width, height: r.height })
  }
  return out
}

/**
 * 找回边（构成环的边，DFS 三色法）。
 * 移除这些边后剩余图为 DAG，可安全交给 AntVDagreLayout 布局；
 * 回边由绘制层最后补画（正交/弧线绕行）。
 */
function findBackEdges(nodes: LayoutNodeSpec[], edges: LayoutEdgeSpec[]): LayoutEdgeSpec[] {
  const adj = new Map<string, LayoutEdgeSpec[]>()
  for (const n of nodes) adj.set(n.key, [])
  for (const e of edges) {
    if (e.from === e.to) continue
    if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from)!.push(e)
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(nodes.map((n) => [n.key, WHITE]))
  const back: LayoutEdgeSpec[] = []
  const dfs = (u: string): void => {
    color.set(u, GRAY)
    for (const e of adj.get(u) ?? []) {
      const c = color.get(e.to) ?? WHITE
      if (c === GRAY) back.push(e) // 指向灰色节点 = 回边
      else if (c === WHITE) dfs(e.to)
    }
    color.set(u, BLACK)
  }
  for (const n of nodes) {
    if ((color.get(n.key) ?? WHITE) === WHITE) dfs(n.key)
  }
  return back
}
