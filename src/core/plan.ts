/**
 * 统一图表管线（perf.md 流程）：
 *
 *   1) 用户指定图类型 + 描述          → create_diagram(type, title, description, ...)
 *   2) 大模型给出节点/边数组          → PlanNode[] + PlanEdge[]（name/description/type/width/height/x/y; source/target）
 *   3) 数据契约归一化                → normalizePlan（name→key、source/target→from/to、形状/尺寸兜底）
 *   4) antv/layout 布局              → computeLayout（layered/tree/grid/circular）
 *   5) 后处理：环 / 位置检查 / 碰撞   → planDiagram（自环移除+计数、碰撞推挤、坐标归一化）
 *   6) 最终数据 + 本地缓存           → PlanStore（.ai-paint/plans/<name>.json），以输入 hash 做缓存键
 *   7) 绘制                          → draw.ts 消费 FinalPlan
 *
 * 兼容现有工具：create_flow_diagram / plan_flow_layout 走同一管线。
 */

import {
  computeLayout,
  type LayoutNodeSpec,
  type LayoutEdgeSpec,
  type LayoutKind,
  type LayoutOptions,
} from './layout.js'
import type { ShapeType } from './shapes.js'
import { SHAPE_TYPES } from './shapes.js'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashSeed } from './geometry.js'

// ---------------------------------------------------------------------------
// 数据契约（perf.md）
// ---------------------------------------------------------------------------

/** 节点：大模型给出的原始字段。name/description/type 由 LLM 填写；width/height 建议填，位置由布局决定。 */
export interface PlanNode {
  /** 节点名（唯一标识）。 */
  name: string
  /** 节点描述（供渲染/备查，通常不直接画出来）。 */
  description?: string
  /** 节点类型（= 绘制形状，映射到 ShapeType）。 */
  type?: string
  /** 节点宽（px）。默认 200。 */
  width?: number
  /** 节点高（px）。默认 72。 */
  height?: number
  /** 初始位置（布局后会被覆盖；x/y 不传即 0）。 */
  x?: number
  y?: number
  /** 填充色。 */
  fill?: string
  /** 所属层 key（create_diagram type=architecture 时使用）。 */
  layer?: string
  /** ER 图字段列表。 */
  fields?: { name: string; type?: string; key?: boolean }[]
}

/** 边：大模型给出的关联关系。 */
export interface PlanEdge {
  /** 源节点名（必须与某个 PlanNode.name 一致）。 */
  source: string
  /** 目标节点名。 */
  target: string
  label?: string
  /** 连线类型 straight/orthogonal/bezier/smooth/arc。 */
  type?: string
  dashed?: boolean
  /** ER 基数标注（from/to 端）。 */
  from_card?: string
  to_card?: string
}

// ---------------------------------------------------------------------------
// 归一化后的中间结构（传给布局/绘制层）
// ---------------------------------------------------------------------------

export interface NormalizedNode {
  key: string
  name: string
  description?: string
  shape: ShapeType
  width: number
  height: number
  fill?: string
  layer?: string
  fields?: { name: string; type?: string; key?: boolean }[]
}

export interface NormalizedEdge {
  from: string
  to: string
  label?: string
  type?: 'straight' | 'orthogonal' | 'bezier' | 'smooth' | 'arc'
  dashed?: boolean
  fromCard?: string
  toCard?: string
}

// ---------------------------------------------------------------------------
// 最终计划（布局 + 后处理 + 供绘制消费）
// ---------------------------------------------------------------------------

export interface FinalPlan {
  name: string
  kind: LayoutKind
  /** 布局方向：TB（上→下）/ LR（左→右）。菱形节点桩点选择依赖此值。 */
  direction: 'LR' | 'TB'
  title?: string
  description?: string
  sceneWidth: number
  sceneHeight: number
  /** key → 节点矩形（布局坐标，已归一化到 padding 起点）。 */
  nodes: Record<string, { x: number; y: number; width: number; height: number }>
  /** 节点表（含形状/标签/字段）。 */
  nodeTable: Record<string, NormalizedNode>
  /** 节点数组（顺序稳定）。 */
  nodeList: NormalizedNode[]
  edges: NormalizedEdge[]
  /** 输入指纹（缓存键）。 */
  fingerprint: string
  /** 自环被移除的边数（自环由绘制层单独画，不计入布局）。 */
  removedSelfLoops: number
  /** 碰撞推挤修正次数（>0 说明发生过碰撞并已解决）。 */
  collisionFixes: number
  /** 布局阶段识别出的回边（构成环的边，不参与 dagre 布局，绘制层补画并优化桩点）。 */
  backEdges?: { from: string; to: string }[]
  createdAt: string
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /** 是否补全自环为可绘制边（默认 true，保留 self-loop 供绘制层画环）。 */
  keepSelfLoops?: boolean
}

const DEF_W = 200
const DEF_H = 72

/** 形状名归一化：接受宽松写法（"decision"→diamond、"start/end"→ellipse、"database"→cylinder 等）。 */
const SHAPE_ALIASES: Record<string, ShapeType> = {
  start: 'ellipse',
  end: 'ellipse',
  decision: 'diamond',
  process: 'rectangle',
  database: 'cylinder',
  storage: 'cylinder',
  actor: 'actor',
  cloud: 'cloud',
  note: 'note',
  doc: 'document',
  document: 'document',
  file: 'document',
  api: 'interface',
  interface: 'interface',
  gateway: 'interface',
  parallelogram: 'parallelogram',
  trapezoid: 'trapezoid',
  hexagon: 'hexagon',
  star: 'star',
  heart: 'heart',
  cross: 'cross',
}

function normalizeShape(type?: string): ShapeType {
  const raw = (type ?? '').trim().toLowerCase()
  if (!raw) return 'rectangle'
  if (SHAPE_TYPES.includes(raw as ShapeType)) return raw as ShapeType
  const alias = SHAPE_ALIASES[raw]
  if (alias) return alias
  // 子串匹配（"rounded rectangle" / "rounded-rectangle" 等）
  if (raw.includes('rounded')) return 'rounded-rectangle'
  if (raw.includes('ellipse') || raw.includes('circle') || raw.includes('oval')) return 'ellipse'
  if (raw.includes('diamond') || raw.includes('rhombus')) return 'diamond'
  if (raw.includes('cylind') || raw.includes('db') || raw.includes('storage')) return 'cylinder'
  if (raw.includes('parallelogram')) return 'parallelogram'
  if (raw.includes('trapezoid')) return 'trapezoid'
  if (raw.includes('triang')) return 'triangle'
  if (raw.includes('hexagon')) return 'hexagon'
  if (raw.includes('pentagon')) return 'pentagon'
  if (raw.includes('note') || raw.includes('sticky')) return 'note'
  if (raw.includes('doc')) return 'document'
  if (raw.includes('cloud')) return 'cloud'
  if (raw.includes('actor') || raw.includes('person') || raw.includes('user')) return 'actor'
  if (raw.includes('star')) return 'star'
  if (raw.includes('arrow')) return raw.includes('left') ? 'arrow-left' : raw.includes('double') ? 'double-arrow' : 'arrow-right'
  return 'rectangle'
}

function num(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def
  return Math.max(min, Math.min(max, n))
}

interface RawField {
  name: string
  type?: string
  key?: boolean
}

/** 把 PlanNode[] 归一化为 NormalizedNode[]（name→key，缺省形状/尺寸兜底）。 */
export function normalizeNodes(raw: unknown): NormalizedNode[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('nodes 必须是非空数组')
  }
  const seen = new Set<string>()
  return raw.map((n, i) => {
    const o = (n ?? {}) as Record<string, unknown>
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : `node${i + 1}`
    if (seen.has(name)) throw new Error(`节点名重复: "${name}"`)
    seen.add(name)
    const width = num(o.width, DEF_W, 24, 2000)
    const height = num(o.height, DEF_H, 20, 1200)
    let fields: RawField[] | undefined
    if (Array.isArray(o.fields)) {
      fields = o.fields.flatMap((f) => {
        const fo = (f ?? {}) as Record<string, unknown>
        if (typeof fo.name !== 'string' || !fo.name) return []
        return [
          {
            name: fo.name,
            type: typeof fo.type === 'string' ? fo.type : undefined,
            key: fo.key === true,
          },
        ]
      })
    }
    return {
      key: name,
      name,
      description: typeof o.description === 'string' ? o.description : undefined,
      shape: normalizeShape(typeof o.type === 'string' ? o.type : undefined),
      width,
      height,
      fill: typeof o.fill === 'string' && o.fill ? o.fill : undefined,
      layer: typeof o.layer === 'string' && o.layer ? o.layer : undefined,
      fields,
    }
  })
}

interface RawEdge {
  from: string
  to: string
  label?: string
  type?: NormalizedEdge['type']
  dashed: boolean
  fromCard?: string
  toCard?: string
}

/** 把 PlanEdge[] 归一化为 NormalizedEdge[]（source/target→from/to）。 */
export function normalizeEdges(raw: unknown): NormalizedEdge[] {
  if (!Array.isArray(raw)) return []
  const EDGE_TYPES = ['straight', 'orthogonal', 'bezier', 'smooth', 'arc']
  const out: RawEdge[] = []
  for (const e of raw) {
    const o = (e ?? {}) as Record<string, unknown>
    const from = typeof o.source === 'string' ? o.source.trim() : ''
    const to = typeof o.target === 'string' ? o.target.trim() : ''
    if (!from || !to) continue
    const type = typeof o.type === 'string' && EDGE_TYPES.includes(o.type) ? (o.type as NormalizedEdge['type']) : undefined
    out.push({
      from,
      to,
      label: typeof o.label === 'string' && o.label ? o.label : undefined,
      type,
      dashed: o.dashed === true,
      fromCard: typeof o.from_card === 'string' && o.from_card ? o.from_card : undefined,
      toCard: typeof o.to_card === 'string' && o.to_card ? o.to_card : undefined,
    })
  }
  return out
}

export function normalizePlan(nodes: unknown, edges: unknown): {
  nodeList: NormalizedNode[]
  edgeList: NormalizedEdge[]
} {
  return { nodeList: normalizeNodes(nodes), edgeList: normalizeEdges(edges) }
}

/** 把 NormalizedEdge 转成布局边。 */
export function toLayoutEdges(edges: NormalizedEdge[]): LayoutEdgeSpec[] {
  return edges
    .filter((e) => e.from !== e.to)
    .map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label,
      type: e.type,
      dashed: e.dashed,
    }))
}

/** 把 NormalizedNode 转成布局节点。 */
export function toLayoutNodes(nodes: NormalizedNode[]): LayoutNodeSpec[] {
  return nodes.map((n) => ({
    key: n.key,
    label: n.name,
    shape: n.shape,
    width: n.width,
    height: n.height,
    fill: n.fill,
  }))
}

// ---------------------------------------------------------------------------
// 碰撞检测与推挤
// ---------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function overlapOf(a: Rect, b: Rect): { ox: number; oy: number } {
  return {
    ox: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    oy: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  }
}

/**
 * 碰撞推挤：两两检测节点矩形，相交时把后置节点向右/向下推出（最多 8 轮）。
 * 布局引擎（dagre/grid）输出一般不重叠，此兜底覆盖显式尺寸过大 / 环回退等极端情况。
 * @returns 修正次数
 */
export function resolveCollisions(
  rects: Record<string, Rect>,
  opts: { gap?: number; order?: string[] } = {},
): number {
  const gap = opts.gap ?? 20
  const keys = opts.order ?? Object.keys(rects)
  let fixes = 0
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = rects[keys[i]]
        const b = rects[keys[j]]
        if (!a || !b) continue
        const { ox, oy } = overlapOf(a, b)
        if (ox <= 0 || oy <= 0) continue
        if (ox < oy) b.x = a.x + a.width + gap
        else b.y = a.y + a.height + gap
        fixes++
        moved = true
      }
    }
    if (!moved) break
  }
  return fixes
}

/** 矩形是否越出画布（未归一化前用于判断位置检查）。 */
function boundsOf(rects: Record<string, Rect>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of Object.values(rects)) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 0
    maxY = 0
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 坐标归一化：把矩形整体平移到 (padding, padding) 起点（无负坐标）。
 * 返回平移量；平移后 sceneWidth/Height = max + padding。
 */
export function normalizeOrigin(
  rects: Record<string, Rect>,
  padding: number,
): { dx: number; dy: number; sceneWidth: number; sceneHeight: number } {
  const b = boundsOf(rects)
  const dx = padding - b.minX
  const dy = padding - b.minY
  for (const r of Object.values(rects)) {
    r.x += dx
    r.y += dy
  }
  return {
    dx,
    dy,
    sceneWidth: b.maxX - b.minX + padding * 2,
    sceneHeight: b.maxY - b.minY + padding * 2,
  }
}

// ---------------------------------------------------------------------------
// 规划主流程
// ---------------------------------------------------------------------------

export interface PlanOptions extends LayoutOptions {
  /** 规划名（场景名，缓存与绘制用）。 */
  name?: string
  title?: string
  description?: string
  /** 布局类型，默认 layered。 */
  kind?: LayoutKind
  /** 导出/缓存开关。默认 true。 */
  cache?: boolean
}

export interface PlanResult {
  plan: FinalPlan
  /** 命中缓存（输入指纹相同）。 */
  fromCache: boolean
}

const DEFAULT_LAYOUT_OPTS: LayoutOptions = { columnGap: 80, rowGap: 50, padding: 60 }

function layoutOpts(opts: PlanOptions): LayoutOptions {
  return {
    kind: opts.kind ?? 'layered',
    columnGap: opts.columnGap ?? DEFAULT_LAYOUT_OPTS.columnGap,
    rowGap: opts.rowGap ?? DEFAULT_LAYOUT_OPTS.rowGap,
    padding: opts.padding ?? DEFAULT_LAYOUT_OPTS.padding,
    orthogonal: opts.orthogonal ?? true,
    direction: opts.direction ?? 'TB',
  }
}

function fingerprintOf(nodes: unknown, edges: unknown, kind: string, opts: PlanOptions = {}): string {
  // 布局方向/间距影响最终坐标，必须纳入指纹，否则 TB/LR 会命中同一缓存
  const stable = JSON.stringify({
    nodes,
    edges,
    kind,
    direction: opts.direction ?? 'TB',
    columnGap: opts.columnGap ?? 80,
    rowGap: opts.rowGap ?? 50,
    padding: opts.padding ?? 60,
  })
  return hashSeed(stable).toString(36)
}

/**
 * 统一规划入口：
 *   normalize → layout（antv）→ 环处理（自环移除计数）→ 碰撞推挤 → 坐标归一化 → 缓存。
 * 任何图类型（layered/tree/grid/circular）都走这里。
 */
export async function planDiagram(
  rawNodes: unknown,
  rawEdges: unknown,
  opts: PlanOptions = {},
): Promise<PlanResult> {
  const { nodeList, edgeList } = normalizePlan(rawNodes, rawEdges)
  const kind = opts.kind ?? 'layered'
  const padding = opts.padding ?? 60
  const fingerprint = fingerprintOf(rawNodes, rawEdges, kind, opts)

  // ---- 缓存（本地 .ai-paint/plans/） ----
  const fromCache = opts.cache !== false
  if (fromCache) {
    const hit = PlanStore.read(fingerprint)
    if (hit) return { plan: hit, fromCache: true }
  }

  // ---- 布局 ----
  const layoutNodes = toLayoutNodes(nodeList)
  const layoutEdges = toLayoutEdges(edgeList)
  const layout = await computeLayout(layoutNodes, layoutEdges, layoutOpts(opts))

  // ---- 自环统计（自环不参与布局，由绘制层单独画环） ----
  const removedSelfLoops = edgeList.filter((e) => e.from === e.to).length

  // ---- 位置检查 + 碰撞推挤 ----
  const rects: Record<string, Rect> = {}
  const order: string[] = []
  for (const n of nodeList) {
    const r = layout.nodes[n.key]
    if (r) {
      rects[n.key] = { x: r.x, y: r.y, width: r.width, height: r.height }
      order.push(n.key)
    }
  }
  const collisionFixes = resolveCollisions(rects, { gap: 20, order })

  // ---- 坐标归一化（非负、padding 起点、scene 尺寸） ----
  const { sceneWidth, sceneHeight } = normalizeOrigin(rects, padding)

  const nodeTable: Record<string, NormalizedNode> = {}
  for (const n of nodeList) nodeTable[n.key] = n

  const plan: FinalPlan = {
    name: opts.name ?? 'default',
    kind,
    direction: layoutOpts(opts).direction ?? 'TB',
    title: opts.title,
    description: opts.description,
    sceneWidth,
    sceneHeight,
    nodes: rects,
    nodeTable,
    nodeList,
    edges: edgeList,
    fingerprint,
    removedSelfLoops,
    collisionFixes,
    backEdges: layout.backEdges,
    createdAt: new Date().toISOString(),
  }

  if (fromCache) PlanStore.write(plan)
  return { plan, fromCache: false }
}

// ---------------------------------------------------------------------------
// 本地缓存（.ai-paint/plans/<fingerprint>.json）
// ---------------------------------------------------------------------------

const CACHE_SUBDIR = 'plans'

function plansDir(): string {
  const dir = join(process.cwd(), '.ai-paint', CACHE_SUBDIR)
  return dir
}

export const PlanStore = {
  /** 读缓存：命中返回已存的 FinalPlan。 */
  read(fingerprint: string): FinalPlan | undefined {
    try {
      const raw = readFileSync(join(plansDir(), `${fingerprint}.json`), 'utf8')
      const parsed = JSON.parse(raw) as FinalPlan
      if (parsed && typeof parsed === 'object' && parsed.fingerprint === fingerprint && parsed.nodes) {
        return parsed
      }
    } catch {
      /* miss */
    }
    return undefined
  },

  write(plan: FinalPlan): void {
    try {
      mkdirSync(plansDir(), { recursive: true })
      writeFileSync(join(plansDir(), `${plan.fingerprint}.json`), JSON.stringify(plan, null, 2), 'utf8')
    } catch (err) {
      console.error(`[ai-paint] failed to persist plan: ${(err as Error).message}`)
    }
  },

  list(): { fingerprint: string; name: string; kind: string; nodes: number; edges: number; createdAt: string }[] {
    try {
      const files = readdirSync(plansDir()).filter((f) => f.endsWith('.json'))
      return files.map((f) => {
        try {
          const raw = readFileSync(join(plansDir(), f), 'utf8')
          const p = JSON.parse(raw) as FinalPlan
          return {
            fingerprint: p.fingerprint ?? f.replace(/\.json$/, ''),
            name: p.name ?? '',
            kind: p.kind ?? 'layered',
            nodes: Object.keys(p.nodes ?? {}).length,
            edges: (p.edges ?? []).length,
            createdAt: p.createdAt ?? '',
          }
        } catch {
          return { fingerprint: f.replace(/\.json$/, ''), name: '', kind: 'layered', nodes: 0, edges: 0, createdAt: '' }
        }
      })
    } catch {
      return []
    }
  },

  delete(fingerprint: string): boolean {
    try {
      rmSync(join(plansDir(), `${fingerprint}.json`), { force: true })
      return true
    } catch {
      return false
    }
  },
}

/** 从已缓存计划重建场景用的辅助：读缓存或返回 undefined。 */
export function readCachedPlan(fingerprint: string): FinalPlan | undefined {
  return PlanStore.read(fingerprint)
}
