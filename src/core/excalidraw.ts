/**
 * Excalidraw v2 导出器 —— 把 Scene 转成可编辑的 .excalidraw 文件（JSON）。
 *
 * `.excalidraw` 文件本质是 Excalidraw v2 的 JSON：
 *   { type: 'excalidraw', version: 2, source, elements, appState, files }
 * 在 excalidraw.com / Excalidraw 桌面端 / Obsidian 等中可直接打开编辑。
 *
 * 无需引入 @excalidraw/excalidraw 或 agent-excalidraw（重依赖 + 许可问题）——
 * 这里手写元素 JSON，覆盖本项目 Scene 的全部元素类型：
 *   shape/rectangle/ellipse/diamond → 同名 Excalidraw 形状
 *   text                          → text 元素（Virgil 字体）
 *   line / draw / arrow           → line / freedraw / arrow
 *   edge                          → arrow（用 routeEdgeBundle 预路由 + endBinding 绑定目标节点）
 *   image                         → image 元素 + files 字典（dataURL）
 *   frame                         → frame 元素（children 引用）
 */

import { routeEdgeBundle, type ConnectorNode, type EdgeType } from './edge-bundle.js'
import type { Side } from './connectors.js'
import type { ShapeType } from './shapes.js'
import type { Scene, SceneElement, LineElement, ArrowElement, DrawElement } from './scene.js'
import { hashSeed } from './geometry.js'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ExcalidrawFillStyle = 'hachure' | 'cross-hatch' | 'solid'
export type ExcalidrawStrokeStyle = 'solid' | 'dashed' | 'dotted'

export interface ExcalidrawBinding {
  elementId: string
  focus: number
  gap: number
  /**
   * 端点相对目标元素的归一化位置 [fx, fy]（0-1，0=边起始角，1=边终点角）。
   * 仅正交（elbowed）箭头需要：Excalidraw 的 repairBinding 对 elbow arrow
   * 若 binding 无 fixedPoint 会判定为非法而【剥离绑定】。
   */
  fixedPoint?: [number, number]
}

export interface ExcalidrawElementBase {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  strokeColor: string
  backgroundColor: string
  fillStyle: ExcalidrawFillStyle
  strokeWidth: number
  strokeStyle: ExcalidrawStrokeStyle
  roughness: number
  opacity: number
  groupIds: string[]
  frameId: string | null
  roundness: { type: number } | null
  seed: number
  version: number
  versionNonce: number
  isDeleted: boolean
  boundElements: { id: string; type: string }[] | null
  updated: number
  link: string | null
  locked: boolean
  customData: Record<string, unknown> | null
}

export interface ExcalidrawTextElement extends ExcalidrawElementBase {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: number
  textAlign: 'left' | 'center' | 'right'
  verticalAlign: 'top' | 'middle' | 'bottom'
  containerId: string | null
  originalText: string
  lineHeight: number
  baseline: number
}

export interface ExcalidrawLineElement extends ExcalidrawElementBase {
  type: 'line' | 'arrow' | 'freedraw'
  points: [number, number][]
  lastCommittedPoint: [number, number] | null
  startBinding: ExcalidrawBinding | null
  endBinding: ExcalidrawBinding | null
  startArrowhead: string | null
  endArrowhead: string | null
  elbowed: boolean
}

export interface ExcalidrawImageElement extends ExcalidrawElementBase {
  type: 'image'
  fileId: string
  status: 'saved'
  scale: [number, number]
  crop: null
}

export interface ExcalidrawFrameElement extends ExcalidrawElementBase {
  type: 'frame'
  name: string
  children: string[]
}

export type ExcalidrawElement =
  | ExcalidrawTextElement
  | ExcalidrawLineElement
  | ExcalidrawImageElement
  | ExcalidrawFrameElement
  | (ExcalidrawElementBase & { type: string })

export interface ExcalidrawFile {
  mimeType: string
  dataURL: string
  createdAt: number
  lastRetrievedAt: number
}

export interface ExcalidrawDocument {
  type: 'excalidraw'
  version: 2
  source: string
  elements: ExcalidrawElement[]
  appState: { gridSize: number | null; viewBackgroundColor: string }
  files: Record<string, ExcalidrawFile>
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 由桩点侧计算 Excalidraw fixedPoint（端点相对目标元素的归一化位置 [fx, fy]）。
 * 正交（elbowed）箭头的 binding 必须带 fixedPoint，否则 Excalidraw 加载时剥离绑定。
 */
function fixedPointForSide(side: Side): [number, number] {
  switch (side) {
    case 'left':
      return [0, 0.5]
    case 'right':
      return [1, 0.5]
    case 'top':
      return [0.5, 0]
    case 'bottom':
      return [0.5, 1]
    default:
      return [0.5, 0.5]
  }
}

/** 确定性 seed（与渲染层同源：来自元素 id）。 */
function seedOf(id: string): number {
  return hashSeed(id) % 2147483647
}

/** Scene fill_style → Excalidraw fillStyle。 */
function fillStyleOf(el: SceneElement): ExcalidrawFillStyle {
  if (el.fill_style === 'none') return 'solid'
  if (el.fill_style === 'cross-hatch') return 'cross-hatch'
  return el.fill_style === 'solid' ? 'solid' : 'hachure'
}

function strokeStyleOf(el: SceneElement): ExcalidrawStrokeStyle {
  return el.stroke_style === 'dashed' || el.stroke_style === 'dotted' ? 'dashed' : 'solid'
}

function roundnessOf(shape: string): { type: number } | null {
  // 圆角矩形 → Excalidraw roundness type 3（圆角）；其它形状无
  return shape === 'rounded-rectangle' ? { type: 3 } : null
}

/**
 * Excalidraw v2 原生形状只有 rectangle/ellipse/diamond/line/arrow/freedraw/text/image/frame。
 * 我们 shapes.ts 的 cylinder/parallelogram/note/star/heart/cloud/document 等
 * 不是原生元素类型（document 在 v2 里是 embeddable iframe，不是纸片形状）。
 * 可编辑文件里统一回退到 rectangle（保持可编辑/可缩放），视觉形状保留在 PNG/SVG。
 */
const EXCALIDRAW_SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'diamond'])

function exShapeType(shape: string): string {
  if (EXCALIDRAW_SHAPE_TYPES.has(shape)) return shape
  if (shape === 'rounded-rectangle') return 'rectangle'
  return 'rectangle'
}

function baseOf(
  el: SceneElement,
  overrides: Partial<ExcalidrawElementBase> = {},
): ExcalidrawElementBase {
  return {
    id: el.id,
    type: el.type,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    angle: el.angle ?? 0,
    strokeColor: el.stroke_color,
    backgroundColor: el.background_color === 'transparent' ? 'transparent' : el.background_color,
    fillStyle: fillStyleOf(el),
    strokeWidth: el.stroke_width,
    strokeStyle: strokeStyleOf(el),
    roughness: el.roughness,
    opacity: el.opacity,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: seedOf(el.id),
    version: 1,
    versionNonce: seedOf(el.id + ':v'),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    customData: null,
    ...overrides,
  }
}

/** 收集 scene 中可绑定节点（shape/rectangle/ellipse/diamond）。 */
function collectNodes(scene: Scene): Map<string, ConnectorNode> {
  const nodes = new Map<string, ConnectorNode>()
  for (const el of scene.elements) {
    if (el.type === 'shape' || el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond') {
      const shape = el.type === 'shape' ? String((el.data as Record<string, unknown>)?.shape ?? 'rectangle') : el.type
      nodes.set(el.id, { key: el.id, shape: shape as ShapeType, x: el.x, y: el.y, width: el.width, height: el.height })
    }
  }
  return nodes
}

/** 文本容器：shape/rectangle/ellipse/diamond/frame（frame 也可作标题文本容器）。 */
function collectTextContainers(scene: Scene): Map<string, { x: number; y: number; width: number; height: number }> {
  const rects = new Map<string, { x: number; y: number; width: number; height: number }>()
  for (const el of scene.elements) {
    if (
      el.type === 'shape' ||
      el.type === 'rectangle' ||
      el.type === 'ellipse' ||
      el.type === 'diamond' ||
      el.type === 'frame'
    ) {
      rects.set(el.id, { x: el.x, y: el.y, width: el.width, height: el.height })
    }
  }
  return rects
}

/** 预路由所有 edge，得到与 SVG 渲染一致的路径。返回 map: edgeEl → { points, fromNodeId, toNodeId, fromShape, toShape, fromSide, toSide, elbowed }。 */
function routeEdges(
  scene: Scene,
  nodes: Map<string, ConnectorNode>,
): Map<SceneElement, { points: [number, number][]; fromNodeId: string; toNodeId: string; fromShape: string; toShape: string; fromSide: Side; toSide: Side; elbowed: boolean }> {
  const edgeEls = scene.elements.filter((el) => el.type === 'edge')
  const bundle = routeEdgeBundle(
    nodes,
    edgeEls
      .map((el) => {
        const d = el.data ?? {}
        const from = nodes.get(String(d.from ?? ''))
        const to = nodes.get(String(d.to ?? ''))
        if (!from || !to) return null
        const EDGE_TYPES: EdgeType[] = ['straight', 'orthogonal', 'bezier', 'smooth', 'arc']
        const et = d.edge_type as string
        return {
          from: from.key,
          to: to.key,
          type: (EDGE_TYPES.includes(et as EdgeType) ? et : 'straight') as EdgeType,
          dashed: Boolean(d.dashed),
          label: typeof d.label === 'string' ? d.label : undefined,
          arrow: (d.arrow as 'none' | 'triangle' | 'circle' | 'diamond') || 'triangle',
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    { separateInOut: true },
  )

  const out = new Map<SceneElement, { points: [number, number][]; fromNodeId: string; toNodeId: string; fromShape: string; toShape: string; fromSide: Side; toSide: Side; elbowed: boolean }>()
  const queue = [...bundle.edges]
  for (const el of edgeEls) {
    const d = el.data ?? {}
    const fromNode = nodes.get(String(d.from ?? ''))
    const toNode = nodes.get(String(d.to ?? ''))
    if (!fromNode || !toNode) continue
    let routed: (typeof bundle.edges)[number] | undefined
    const idx = queue.findIndex((e) => e.from === fromNode.key && e.to === toNode.key)
    if (idx >= 0) {
      routed = queue[idx]
      queue.splice(idx, 1)
    }
    if (!routed) continue
    out.set(el, {
      // routeEdgeBundle 的 points 已是 scene 坐标（绝对），Excalidraw arrow 的 points 是相对元素 x/y 的。
      // 这里直接把绝对坐标转成 Excalidraw 的相对 points，包围盒另行计算。
      points: routed.points.map((p) => [p.x, p.y] as [number, number]),
      fromNodeId: fromNode.key,
      toNodeId: toNode.key,
      fromSide: routed.fromSide,
      toSide: routed.toSide,
      elbowed: d.edge_type === 'orthogonal',
      fromShape: fromNode.shape,
      toShape: toNode.shape,
    })
  }
  return out
}

/** 计算一组绝对坐标点的包围盒。 */
function boundsOf(points: [number, number][]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// ---------------------------------------------------------------------------
// 元素转换
// ---------------------------------------------------------------------------

function toShapeElement(el: SceneElement): ExcalidrawElement {
  const shape = el.type === 'shape' ? String((el.data as Record<string, unknown>)?.shape ?? 'rectangle') : el.type
  const exType = exShapeType(shape)
  const elBase = baseOf(el, {
    type: exType,
    roundness: roundnessOf(shape),
  })
  return elBase as ExcalidrawElement
}

/** 估算文字宽度（px）。CJK 全角 ≈1em，ASCII 半角 ≈0.55em，与 validators.textWidth 一致。 */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    if (ch === '\n') continue
    const c = ch.codePointAt(0) ?? 0
    const cjk = c >= 0x3000 && c <= 0x9fff
    w += cjk ? 1 : 0.55
  }
  return Math.max(1, Math.ceil(w * fontSize))
}

function toTextElement(
  el: SceneElement,
  container: { id: string; x: number; y: number; width: number; height: number } | null,
  opts: { align?: 'center' | 'left' | 'right'; vertical?: 'middle' | 'top' | 'bottom' } = {},
): ExcalidrawTextElement {
  const d = (el.data ?? {}) as Record<string, unknown>
  const text = String(d.text ?? '')
  const fontSize = Number(d.font_size ?? 20)
  const align = (opts.align ?? d.text_align ?? 'left') as 'left' | 'center' | 'right'
  const vertical = (opts.vertical ?? 'middle') as 'middle' | 'top' | 'bottom'
  const base = baseOf(el, {
    type: 'text',
    // 文本背景透明
    backgroundColor: 'transparent',
    fillStyle: 'solid',
  })

  // 容器文字的定位：Excalidraw 的容器 text 元素 x/y 是文字 box 左上角，
  // textAlign/verticalAlign 决定文字在 box 内的对齐。
  //   - textAlign=center → 渲染时偏移 +width/2，所以 text.x = 容器中心 - 文字宽/2
  //   - textAlign=left   → 文字从容器左缘开始，text.x = 容器.x
  //   - verticalAlign=middle → text.y = 容器中心 - 文字高/2
  //   - verticalAlign=top    → text.y = 容器.y
  const tw = estimateTextWidth(text, fontSize)
  const th = Math.ceil(fontSize * 1.25)

  let tx: number
  let ty: number
  let width: number
  let height: number
  let containerId: string | null
  let textAlign: 'left' | 'center' | 'right'
  let verticalAlign: 'top' | 'middle' | 'bottom'

  if (container) {
    tx =
      align === 'center'
        ? container.x + container.width / 2 - tw / 2
        : align === 'right'
          ? container.x + container.width - tw
          : container.x
    ty = vertical === 'middle' ? container.y + container.height / 2 - th / 2 : container.y
    width = tw
    height = th
    containerId = container.id
    textAlign = align
    verticalAlign = vertical
  } else {
    // 独立文本：保留原坐标，width/height 按文字估算
    tx = el.x
    ty = el.y
    width = tw
    height = th
    containerId = null
    textAlign = align
    verticalAlign = vertical
  }

  return {
    ...base,
    x: tx,
    y: ty,
    width,
    height,
    text,
    fontSize,
    fontFamily: 1, // Virgil 手写体
    textAlign,
    verticalAlign,
    containerId,
    originalText: text,
    lineHeight: 1.25,
    baseline: Math.round(fontSize * 0.9),
  } as ExcalidrawTextElement
}

/** 判断一个点是否在矩形内（含小容差）。 */
function pointInRect(px: number, py: number, r: { x: number; y: number; width: number; height: number }): boolean {
  const tol = 1
  return px >= r.x - tol && px <= r.x + r.width + tol && py >= r.y - tol && py <= r.y + r.height + tol
}

/** 计算路径中点（绝对坐标）。 */
function pathMidpoint(points: [number, number][]): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return { x: points[0][0], y: points[0][1] }
  if (points.length === 2) {
    return {
      x: (points[0][0] + points[1][0]) / 2,
      y: (points[0][1] + points[1][1]) / 2,
    }
  }
  // 多段路径：取中间段的中点（视觉上更贴近边的中央）
  const midIdx = Math.floor((points.length - 1) / 2)
  const a = points[midIdx]
  const b = points[midIdx + 1]
  return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }
}

/**
 * 为边标签生成 Excalidraw text 元素。
 * 标签绑定到箭头（containerId = arrow id），拖动节点/箭头时文字跟随。
 * @param text 标签文本
 * @param mid 标签锚点（路径中点）
 */
function toEdgeLabelElement(text: string, mid: { x: number; y: number }, arrowId: string): ExcalidrawTextElement {
  const fontSize = 13
  const tw = estimateTextWidth(text, fontSize)
  const th = Math.ceil(fontSize * 1.25)
  const base = {
    id: `label_${arrowId}`,
    type: 'text' as const,
    x: mid.x + 8,
    y: mid.y - 8,
    width: tw,
    height: th,
    angle: 0,
    strokeColor: '#495057',
    backgroundColor: 'transparent',
    fillStyle: 'solid' as const,
    strokeWidth: 2,
    strokeStyle: 'solid' as const,
    roughness: 0,
    opacity: 100,
    groupIds: [] as string[],
    frameId: null,
    roundness: null,
    seed: 0,
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    customData: null,
  }
  return {
    ...base,
    text,
    fontSize,
    fontFamily: 1,
    textAlign: 'left',
    verticalAlign: 'middle',
    containerId: arrowId,
    originalText: text,
    lineHeight: 1.25,
    baseline: Math.round(fontSize * 0.9),
  } as ExcalidrawTextElement
}

function toLineElement(el: SceneElement): ExcalidrawLineElement {
  const pts = ((el as LineElement | ArrowElement | DrawElement).data?.points ?? []).map(([x, y]) => [x, y] as [number, number])
  const b = boundsOf(pts)
  const rel = pts.map(([x, y]) => [x - b.x, y - b.y] as [number, number])
  const isArrow = el.type === 'arrow'
  return {
    ...baseOf(el, {
      type: isArrow ? 'arrow' : el.type === 'draw' ? 'freedraw' : 'line',
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    }),
    type: isArrow ? 'arrow' : el.type === 'draw' ? 'freedraw' : 'line',
    points: rel,
    lastCommittedPoint: rel[rel.length - 1] ?? [0, 0],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: isArrow ? 'arrow' : null,
    elbowed: false,
  } as ExcalidrawLineElement
}

/** 带绑定的自由箭头（时序图 message）。 */
function toArrowElement(
  el: SceneElement,
  startBinding: ExcalidrawBinding | null,
  endBinding: ExcalidrawBinding | null,
): ExcalidrawLineElement {
  const pts = ((el as ArrowElement).data?.points ?? []).map(([x, y]) => [x, y] as [number, number])
  const b = boundsOf(pts)
  const rel = pts.map(([x, y]) => [x - b.x, y - b.y] as [number, number])
  const dashed = el.stroke_style === 'dashed'
  return {
    ...baseOf(el, {
      type: 'arrow',
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      strokeStyle: dashed ? 'dashed' : 'solid',
    }),
    type: 'arrow',
    points: rel,
    lastCommittedPoint: rel[rel.length - 1] ?? [0, 0],
    startBinding,
    endBinding,
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
  } as ExcalidrawLineElement
}

function toArrowFromEdge(
  el: SceneElement,
  route: {
    points: [number, number][]
    fromNodeId: string
    toNodeId: string
    fromShape: string
    toShape: string
    fromSide: Side
    toSide: Side
    elbowed: boolean
  },
): ExcalidrawLineElement {
  const d = (el.data ?? {}) as Record<string, unknown>
  const b = boundsOf(route.points)
  const rel = route.points.map(([x, y]) => [x - b.x, y - b.y] as [number, number])
  const arrowType = String(d.arrow ?? 'triangle')
  // Excalidraw endArrowhead: 'arrow' | 'bar' | 'circle' | null
  const endArrowhead =
    arrowType === 'none' ? null : arrowType === 'circle' ? 'circle' : arrowType === 'diamond' ? 'arrow' : 'arrow'
  const dashed = Boolean(d.dashed)

  // 官方 Excalidraw binding 格式：{ elementId, focus, gap }（PointBinding）。
  // 两端都绑定：拖动 source 或 target 节点，箭头两端都跟随。
  // focus: 0 = 指向元素中心（拖动重算时箭头停在边缘），gap 保持初始小间隙。
  // 正交（elbowed）箭头必须带 fixedPoint，否则 Excalidraw 的 repairBinding
  // 会判定绑定非法并剥离（正交箭头 = 回边/绕行边）。
  const isElbow = route.elbowed
  const binding = (elementId: string, side: Side): ExcalidrawBinding =>
    isElbow
      ? { elementId, focus: 0, gap: 8, fixedPoint: fixedPointForSide(side) }
      : { elementId, focus: 0, gap: 8 }

  return {
    ...baseOf(el, {
      type: 'arrow',
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeStyle: dashed ? 'dashed' : 'solid',
    }),
    type: 'arrow',
    points: rel,
    lastCommittedPoint: rel[rel.length - 1] ?? [0, 0],
    startBinding: binding(route.fromNodeId, route.fromSide),
    endBinding: binding(route.toNodeId, route.toSide),
    startArrowhead: null,
    endArrowhead,
    elbowed: isElbow,
  } as ExcalidrawLineElement
}

function toImageElement(el: SceneElement, files: Record<string, ExcalidrawFile>): ExcalidrawImageElement {
  const d = (el.data ?? {}) as Record<string, unknown>
  const dataUrl = String(d.data_url ?? '')
  const mimeMatch = dataUrl.match(/^data:([^;]+);/)
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png'
  const fileId = el.id
  if (dataUrl) {
    files[fileId] = {
      mimeType,
      dataURL: dataUrl,
      createdAt: Date.now(),
      lastRetrievedAt: Date.now(),
    }
  }
  return {
    ...baseOf(el, {
      type: 'image',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      roughness: 0,
    }),
    type: 'image',
    fileId,
    status: 'saved',
    scale: [1, 1],
    crop: null,
  } as ExcalidrawImageElement
}

function toFrameElement(el: SceneElement): ExcalidrawFrameElement {
  const d = (el.data ?? {}) as Record<string, unknown>
  const children = Array.isArray(d.children) ? d.children.map(String) : []
  return {
    ...baseOf(el, {
      type: 'frame',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      roughness: 0,
    }),
    type: 'frame',
    name: String(d.name ?? ''),
    children,
  } as ExcalidrawFrameElement
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 把 Scene 转成 Excalidraw v2 文档（可直接写为 .excalidraw 文件）。
 * 自动：
 *   - shape/text/line/arrow/draw/frame → 对应元素
 *   - edge → arrow + startBinding/endBinding 绑定两端节点（编辑时拖动任意一端节点箭头都跟随）
 *   - image → files 字典 + fileId 引用
 */
export function sceneToExcalidraw(scene: Scene): ExcalidrawDocument {
  const nodes = collectNodes(scene)
  const edgeRoutes = routeEdges(scene, nodes)
  const files: Record<string, ExcalidrawFile> = {}
  const elements: ExcalidrawElement[] = []

  // 文本容器表（shape/rectangle/ellipse/diamond/frame，frame 可作层标题容器）
  const containerRects = collectTextContainers(scene)

  // 记录绑定关系（稍后统一回填 boundElements）：
  //   boundArrows: 箭头 → 绑定的两端节点
  //   boundTexts:  text → 绑定的容器节点
  //   boundTextToArrow: text → 绑定的箭头（Excalidraw arrow 支持 containerId 绑定文本）
  const boundArrows: { nodeId: string; arrowId: string }[] = []
  const boundTexts: { nodeId: string; textId: string }[] = []
  const boundTextToArrow: { arrowId: string; textId: string }[] = []

  // 时序图特殊元素：participant box（shape）中心 x → id，用于 lifeline/msg 绑定
  // 参与者可以是矩形 / 圆柱（数据库）等任意 shape
  const participantBoxes: { id: string; cx: number; cy: number; x: number; y: number; width: number; height: number }[] = []
  for (const el of scene.elements) {
    if (el.type === 'shape') {
      // 参与者 box：所有 shape 都可能是（drawSequenceScene 用 shape 画 participant）
      // 用高度判断：participant box 高度 = boxHeight（56），lifeline 是 line 不算。
      participantBoxes.push({ id: el.id, cx: el.x + el.width / 2, cy: el.y + el.height / 2, x: el.x, y: el.y, width: el.width, height: el.height })
    }
  }
  // 最接近给定 x 的参与者 box
  const participantAtX = (x: number, excludeId?: string) => {
    let best: typeof participantBoxes[number] | null = null
    let bestDist = Infinity
    for (const p of participantBoxes) {
      if (p.id === excludeId) continue
      const d = Math.abs(p.cx - x)
      if (d < bestDist) {
        bestDist = d
        best = p
      }
    }
    return bestDist < 60 ? best : null // 60px 容差
  }

  // 所有参与者的垂直生命线 x（纵向线的 x 坐标）
  const lifelineXs = new Map<number, string[]>() // x → lifeline id 列表
  const lifelineById = new Map<string, { x1: number; y1: number; x2: number; y2: number }>()

  for (const el of scene.elements) {
    if (el.type === 'edge') {
      const route = edgeRoutes.get(el)
      if (!route) continue
      const arrow = toArrowFromEdge(el, route)
      boundArrows.push({ nodeId: route.fromNodeId, arrowId: el.id })
      boundArrows.push({ nodeId: route.toNodeId, arrowId: el.id })
      elements.push(arrow)
      // 边标签：为带 label 的边生成绑定到 arrow 的文本（拖动时跟随）
      const label = typeof (el.data?.label) === 'string' ? (el.data.label as string) : ''
      if (label) {
        const mid = pathMidpoint(route.points)
        const labelEl = toEdgeLabelElement(label, mid, el.id)
        boundTextToArrow.push({ arrowId: el.id, textId: labelEl.id })
        elements.push(labelEl)
      }
      continue
    }
    switch (el.type) {
      case 'shape':
      case 'rectangle':
      case 'ellipse':
      case 'diamond':
        elements.push(toShapeElement(el))
        break
      case 'text': {
        // 文本落在某个容器节点内部 → 绑定为容器文字（拖动节点文字跟随）
        // 选择面积最小的包含容器：module label 应绑到 module 而非 frame，
        // 层标题只能绑到 frame（frame 覆盖整个层）。
        // 排除自由标签（关系基数标记/消息标签/图标题）不绑定容器。
        const isFreeLabel =
          el.id.startsWith('er_card_') || el.id.startsWith('msglabel_') || el.id.startsWith('title_')
        // 架构图层标题：左对齐固定在 frame 内 → 绑到 frame（左上对齐）
        const isArchLayerTitle = el.id.startsWith('arch_layer_title_')
        // 只有「居中文本」或「架构图层标题」才绑定容器；
        // 左对齐的多行文本（ER 字段等）保持自由文字 + 分组跟随（绑定容器会被强制居中/重排）。
        const d0 = (el.data ?? {}) as Record<string, unknown>
        const textAlign0 = (d0.text_align ?? 'left') as string
        const isBindableLabel = textAlign0 === 'center' || isArchLayerTitle

        let container: { id: string; x: number; y: number; width: number; height: number } | null = null
        let textOpts: { align?: 'center' | 'left' | 'right'; vertical?: 'middle' | 'top' | 'bottom' } = {}
        if (!isFreeLabel && isBindableLabel) {
          const tcx = el.x + el.width / 2
          const tcy = el.y + el.height / 2
          let bestArea = Infinity
          for (const [sid, r] of containerRects) {
            if (pointInRect(tcx, tcy, r)) {
              const area = r.width * r.height
              if (area < bestArea) {
                bestArea = area
                container = { id: sid, ...r }
              }
            }
          }
          // 层标题左对齐绑到 frame 左上角
          if (container && isArchLayerTitle) {
            textOpts = { align: 'left', vertical: 'top' }
          }
        }
        if (container) boundTexts.push({ nodeId: container.id, textId: el.id })
        elements.push(toTextElement(el, container, textOpts))
        break
      }
      case 'line': {
        const elLine = el as LineElement
        const pts = elLine.data?.points ?? []
        // 生命线：竖直虚线（时序图），x 坐标与 participant box 中心匹配 → 分组
        const isVertical = pts.length === 2 && Math.abs(pts[0][0] - pts[1][0]) < 1.5 && pts[1][1] > pts[0][1]
        if (isVertical) {
          const lx = pts[0][0]
          const p = participantAtX(lx)
          if (p) {
            // 记录 lifeline 与 participant 的分组关系
            const list = lifelineXs.get(lx) ?? []
            list.push(el.id)
            lifelineXs.set(lx, list)
            lifelineById.set(el.id, { x1: lx, y1: pts[0][1], x2: lx, y2: pts[1][1] })
          }
        }
        elements.push(toLineElement(el))
        break
      }
      case 'arrow': {
        // 时序图 message 箭头：水平线连接两个 participant → 绑定两端
        const elArrow = el as ArrowElement
        const pts = elArrow.data?.points ?? []
        let startBind: ExcalidrawBinding | null = null
        let endBind: ExcalidrawBinding | null = null
        if (pts.length >= 2) {
          const sx = pts[0][0]
          const ex = pts[pts.length - 1][0]
          const fromP = participantAtX(sx)
          const toP = participantAtX(ex)
          if (fromP) startBind = { elementId: fromP.id, focus: 0, gap: 8 }
          if (toP) endBind = { elementId: toP.id, focus: 0, gap: 8 }
          if (fromP || toP) {
            boundArrows.push(...(fromP ? [{ nodeId: fromP.id, arrowId: el.id }] : []))
            boundArrows.push(...(toP ? [{ nodeId: toP.id, arrowId: el.id }] : []))
          }
        }
        elements.push(toArrowElement(el, startBind, endBind))
        break
      }
      case 'draw':
        elements.push(toLineElement(el))
        break
      case 'image':
        elements.push(toImageElement(el, files))
        break
      case 'frame':
        elements.push(toFrameElement(el))
        break
      default:
        break
    }
  }

  // 生命线分组：participant box + 其下的 lifeline + 激活条 + 关联的 message 箭头 同 groupIds
  //（拖动 box/lifeline 时，激活条与连接的消息线一起跟随，保持横向线钉在竖直线上）
  const groupMap = new Map<string, string[]>() // groupId → element ids
  // 记录每个 participant 的 groupId（message 箭头需要知道自己两端属于哪些组）
  const participantGroupId = new Map<string, string>()
  for (const [lx, lineIds] of lifelineXs) {
    const p = participantAtX(lx)
    if (!p) continue
    const gid = `seq_group_${lx}`
    participantGroupId.set(p.id, gid)
    // 激活条（activation_*）：中心 x 与 lifeline 对齐 → 归入同组
    const actIds = elements
      .filter((e) => e.id.startsWith('activation_') && Math.abs(e.x + e.width / 2 - lx) < 2)
      .map((e) => e.id)
    const members = [p.id, ...lineIds, ...actIds]
    groupMap.set(gid, members)
  }
  // message 箭头：加入其两端 participant 的分组（横向线随两端竖直线一起移动）
  for (const el of elements) {
    if (el.type !== 'arrow' || !el.id.startsWith('msg_')) continue
    // 水平消息线的左端 x = el.x，右端 x = el.x + el.width
    const fromP = participantAtX(el.x + 1)
    const toP = participantAtX(el.x + el.width - 1)
    const gids = new Set<string>()
    if (fromP && participantGroupId.has(fromP.id)) gids.add(participantGroupId.get(fromP.id)!)
    if (toP && participantGroupId.has(toP.id)) gids.add(participantGroupId.get(toP.id)!)
    for (const gid of gids) {
      const members = groupMap.get(gid) ?? []
      members.push(el.id)
      groupMap.set(gid, members)
    }
  }

  // ER 实体分组：header（er_header_*）+ body（er_body_*）+ 实体范围内的
  // 字段文字/分隔线/key 图标/标题 归入同一 groupIds，拖动实体整体移动。
  // header 与 body 几何匹配：同 x、body.y ≈ header.y + header.height。
  const headerEls = elements.filter((e) => e.id.startsWith('er_header_'))
  for (const header of headerEls) {
    // 找同 x、紧贴下方的 body
    const body = elements.find(
      (e) =>
        e.id.startsWith('er_body_') &&
        Math.abs(e.x - header.x) < 1 &&
        Math.abs(e.y - (header.y + header.height)) < 1,
    )
    // 实体包围盒 = header ∪ body
    const minX = header.x
    const minY = header.y
    const maxX = body ? Math.max(header.x + header.width, body.x + body.width) : header.x + header.width
    const maxY = body ? Math.max(header.y + header.height, body.y + body.height) : header.y + header.height
    // 落在实体包围盒内的 er_* 元素（中心点判断）
    const gid = `er_group_${header.id}`
    const members: string[] = [header.id]
    if (body) members.push(body.id)
    for (const el of elements) {
      if (el.id === header.id || el.id === body?.id) continue
      if (!el.id.startsWith('er_')) continue
      // 关系基数标记（er_card_*）与关系线（er_rel_*）不归入实体组
      if (el.id.startsWith('er_card_') || el.id.startsWith('er_rel_')) continue
      const cx = el.x + el.width / 2
      const cy = el.y + el.height / 2
      if (cx >= minX - 1 && cx <= maxX + 1 && cy >= minY - 1 && cy <= maxY + 1) {
        members.push(el.id)
      }
    }
    groupMap.set(gid, members)
  }

  // 应用分组（元素可能属于多个组，如 message 箭头同时连接两个参与者 → 累积 groupIds）
  for (const el of elements) {
    const myGids: string[] = []
    for (const [gid, members] of groupMap) {
      if (members.includes(el.id)) myGids.push(gid)
    }
    if (myGids.length > 0) el.groupIds = myGids
  }

  // msg 标签绑定到箭头（containerId = arrow id）
  // 时序图 message 标签 y = 箭头 y - 18，用 y 对齐匹配最可靠
  for (const el of scene.elements) {
    if (el.type !== 'text') continue
    const tid = el.id
    if (!tid.startsWith('msglabel_')) continue
    const tcy = el.y + el.height / 2
    // 找 y 最接近「标签中心 + 18」的箭头（即箭头线位置）
    let bestArrow: ExcalidrawElement | null = null
    let bestDist = Infinity
    for (const a of elements) {
      if (a.type !== 'arrow') continue
      const acy = a.y + a.height / 2
      const d = Math.abs(acy - (tcy + 18))
      if (d < bestDist) {
        bestDist = d
        bestArrow = a
      }
    }
    if (bestArrow && bestDist < 20) {
      boundTextToArrow.push({ arrowId: bestArrow.id, textId: tid })
    }
  }

  // 回填被箭头绑定的节点的 boundElements（Excalidraw 要求双向引用）
  const boundByNode = new Map<string, { id: string; type: string }[]>()
  for (const { nodeId, arrowId } of boundArrows) {
    const list = boundByNode.get(nodeId) ?? []
    list.push({ id: arrowId, type: 'arrow' })
    boundByNode.set(nodeId, list)
  }
  for (const { nodeId, textId } of boundTexts) {
    const list = boundByNode.get(nodeId) ?? []
    list.push({ id: textId, type: 'text' })
    boundByNode.set(nodeId, list)
  }
  for (const el of elements) {
    const binds = boundByNode.get(el.id)
    if (binds && binds.length > 0) {
      el.boundElements = [...(el.boundElements ?? []), ...binds]
    }
  }

  // msg 标签绑定到箭头容器（arrow.boundElements 加 {type:'text'}，text.containerId = arrow.id）
  const textEls = new Map<string, ExcalidrawElement>(elements.map((e) => [e.id, e]))
  for (const { arrowId, textId } of boundTextToArrow) {
    const arrowEl = textEls.get(arrowId)
    const textEl = textEls.get(textId)
    if (!arrowEl || !textEl) continue
    ;(textEl as ExcalidrawTextElement).containerId = arrowId
    arrowEl.boundElements = [...(arrowEl.boundElements ?? []), { id: textId, type: 'text' }]
  }

  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: scene.paper ? '#faf9f4' : scene.background_color || '#ffffff',
    },
    files,
  }
}
