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

import {
  AntVDagreLayout,
  GridLayout,
  CircularLayout,
  type GraphData,
} from '@antv/layout'
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

export async function computeLayout(
  nodes: LayoutNodeSpec[],
  edges: LayoutEdgeSpec[],
  opts: LayoutOptions = {},
): Promise<LayoutResult> {
  const kind = opts.kind ?? 'layered'
  const columnGap = opts.columnGap ?? 80
  const rowGap = opts.rowGap ?? 50
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
      const data = toGraphData(nodes, edges)
      result = await runGrid(data, nodeSize, columnGap, rowGap)
      break
    }
    case 'circular': {
      const data = toGraphData(nodes, edges)
      result = await runCircular(data, nodeSize)
      break
    }
    case 'tree': {
      // 树形：dagre 分层 + LR/TB 方向，紧凑节点间距（树通常无环）
      const data = toGraphData(nodes, edges)
      result = await runDagre(data, nodeSize, direction, Math.max(30, columnGap), Math.max(40, rowGap))
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
  for (const n of nodes) {
    const c = result.nodes.get(n.key)
    if (!c) continue
    const { w, h } = sizeOf(n.key)
    const x = c.x - w / 2 - minX + padding
    const y = c.y - h / 2 - minY + padding
    rects.set(n.key, { x, y, width: w, height: h })
  }

  const centers: Record<string, { x: number; y: number }> = {}
  const out: LayoutResult['nodes'] = {}
  for (const n of nodes) {
    const r = rects.get(n.key)
    if (!r) continue
    out[n.key] = r
    centers[n.key] = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }
  return {
    kind,
    sceneWidth: result.width + padding,
    sceneHeight: result.height + padding,
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
    // dagre 的 nodesep = 同层节点间距（对应 columnGap 语义），ranksep = 层间距（对应 rowGap）
    nodesep: columnGap,
    ranksep: rowGap,
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

async function runGrid(
  data: GraphData,
  nodeSize: (n: { id: string }) => { w: number; h: number },
  columnGap: number,
  rowGap: number,
): Promise<RawResult> {
  const layout = new GridLayout({
    nodeSize: (n: { id?: unknown }) => {
      const { w, h } = nodeSize({ id: String(n?.id ?? '') })
      return [w, h]
    },
    preventOverlap: true,
    condense: true,
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

async function runCircular(
  data: GraphData,
  nodeSize: (n: { id: string }) => { w: number; h: number },
): Promise<RawResult> {
  const n = data.nodes.length
  const maxNode = data.nodes.reduce((m, x) => {
    const { w, h } = nodeSize(x as { id: string })
    return Math.max(m, w, h)
  }, 0)
  const radius = Math.max(150, (n * maxNode) / (2 * Math.PI) + 60)
  const layout = new CircularLayout({
    nodeSize: (x: { id?: unknown }) => {
      const { w, h } = nodeSize({ id: String(x?.id ?? '') })
      return [w, h]
    },
    radius,
    startAngle: -Math.PI / 2,
  })
  await layout.execute(data)
  const nodes = new Map<string, { x: number; y: number }>()
  let maxR = 0
  layout.forEachNode((nd) => {
    nodes.set(String(nd.id), { x: nd.x, y: nd.y })
    maxR = Math.max(maxR, Math.hypot(nd.x, nd.y))
  })
  layout.destroy()
  // circular 以 (0,0) 为中心；返回包围盒半径，供上层按 padding 平移
  return { nodes, width: (maxR + maxNode) * 2, height: (maxR + maxNode) * 2 }
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
