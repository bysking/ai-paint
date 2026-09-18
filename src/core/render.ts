import type { Point } from './geometry.js'
import { angleOf } from './geometry.js'
import {
  crossHatchFill,
  hachureFill,
  insetPolygon,
  roughClosedShape,
  roughLine,
  roundCorners,
} from './rough.js'
import { Svg, escapeXml, fmt } from './ts-svg.js'
import { shapeGeometry, roundedBoxPoints, type ShapeType } from './shapes.js'
import {
  routeEdge,
  edgeMidpoint,
  edgeLabelAnchor,
  type RoutedEdge,
  type EdgeType,
  type ArrowHead,
  type ConnectorNode,
} from './connectors.js'
import { routeEdgeBundle } from './edge-bundle.js'
import type {
  Scene,
  SceneElement,
  RectangleElement,
  EllipseElement,
  DiamondElement,
  ShapeElement,
  LineElement,
  ArrowElement,
  EdgeElement,
  TextElement,
  DrawElement,
  ImageElement,
  FrameElement,
} from './scene.js'

// ---------- color / helpers ----------

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function toHex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
}

export function rgbaToHex(color: string): string {
  if (color.startsWith('#')) {
    if (color.length === 4) return '#' + color.slice(1).split('').map((c) => c + c).join('')
    return color
  }
  if (color.startsWith('rgba') || color.startsWith('rgb')) {
    const m = color.match(/[\d.]+/g)
    if (m && m.length >= 3) {
      const a = m.length >= 4 ? parseFloat(m[3]) : 1
      const hex = '#' + m.slice(0, 3).map((v) => toHex(parseFloat(v))).join('')
      return a < 1 ? hex + toHex(a * 255) : hex
    }
  }
  return color
}

export function withOpacity(color: string, opacity: number): string {
  const hex = rgbaToHex(color)
  if (hex.length === 7) {
    const a = Math.round(Math.max(0, Math.min(1, opacity / 100)) * 255)
    return hex + toHex(a)
  }
  return hex
}

export function num(v: number, digits = 2): string {
  return fmt(v, digits)
}

function polygonPoints(poly: Point[]): string {
  return poly.map((p) => `${num(p.x)},${num(p.y)}`).join(' ')
}

function styleAttrs(el: SceneElement): Record<string, string> {
  const attrs: Record<string, string> = {
    stroke: escapeXml(el.stroke_color),
    'stroke-width': num(el.stroke_width),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }
  if (el.stroke_style === 'dashed') {
    attrs['stroke-dasharray'] = `${num(el.dash?.[0] ?? 12)} ${num(el.dash?.[1] ?? 8)}`
  } else if (el.stroke_style === 'dotted') {
    attrs['stroke-dasharray'] = '1 6'
  }
  if (el.opacity < 100) attrs.opacity = num(el.opacity / 100, 3)
  return attrs
}

export interface RenderOptions {
  embedBackground?: boolean
}

export function renderSceneSvg(scene: Scene, _opts: RenderOptions = {}): string {
  const usePaper = scene.paper !== false
  const bg = usePaper ? '#faf9f4' : scene.background_color || '#ffffff'
  const defs = usePaper
    ? `<radialGradient id="vg" cx="50%" cy="42%" r="80%"><stop offset="0%" stop-color="rgba(0,0,0,0)"/><stop offset="100%" stop-color="rgba(120,110,80,0.10)"/></radialGradient>`
    : ''

  // 预解析 edge 节点引用（edge 元素需要整个场景上下文来路由）
  const nodeById = new Map<string, ConnectorNode>()
  for (const el of scene.elements) {
    if (el.type === 'shape' || el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond') {
      const shape = el.type === 'shape' ? String((el.data as Record<string, unknown>)?.shape ?? 'rectangle') : el.type
      nodeById.set(el.id, { key: el.id, shape: shape as ShapeType, x: el.x, y: el.y, width: el.width, height: el.height })
    }
  }

  // 节点矩形（标签碰撞检测用）
  const nodeRects = [...nodeById.values()].map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }))

  // 预路由所有 edge（含正交避障），收集标签初始位置。
  // 用 routeEdgeBundle 成组路由：同一节点同侧的边自动扇出错开、重合边升级
  // 正交/贝塞尔 —— 比逐条 routeEdge 更能避免平行边/重合边叠在同一条线上。
  const edgeEls = scene.elements.filter((el) => el.type === 'edge')
  const labelPlacements = new Map<string, { text: string; x: number; y: number }>()
  const bundle = routeEdgeBundle(
    nodeById,
    edgeEls
      .map((el) => {
        const d = el.data ?? {}
        const from = nodeById.get(String(d.from ?? ''))
        const to = nodeById.get(String(d.to ?? ''))
        if (!from || !to) return null
        const type = (EDGE_TYPES.includes(d.edge_type as EdgeType) ? d.edge_type : 'straight') as EdgeType
        const arrow = (ARROW_HEADS.includes(d.arrow as ArrowHead) ? d.arrow : 'triangle') as ArrowHead
        return {
          from: from.key,
          to: to.key,
          type,
          dashed: Boolean(d.dashed),
          label: typeof d.label === 'string' ? d.label : undefined,
          arrow,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
    { minBends: 0 },
  )
  // 注意：同一对节点可有多条边（平行边），bundle.edges 按请求顺序返回，
  // 与 edgeEls 一一对应 —— 用队列逐条消费，避免同 pair 多条边被合并。
  const queue = [...bundle.edges]
  const routedEdges = edgeEls
    .map((el) => {
      const d = el.data ?? {}
      const from = nodeById.get(String(d.from ?? ''))
      const to = nodeById.get(String(d.to ?? ''))
      if (!from || !to) return null
      // 找到与 from/to 匹配的下一条 bundle 边（跳过已被消费的）
      let routed: RoutedEdge | undefined
      const idx = queue.findIndex((e) => e.from === from.key && e.to === to.key)
      if (idx >= 0) {
        routed = queue[idx]
        queue.splice(idx, 1)
      }
      if (!routed) return null
      if (routed.label) {
        const mid = edgeLabelAnchor(routed)
        labelPlacements.set(el.id, { text: routed.label, x: mid.x + 8, y: mid.y - 8 })
      }
      return { el, routed }
    })
    .filter((x): x is { el: EdgeElement; routed: RoutedEdge } => x !== null)

  // 标签防重叠：围绕锚点尝试偏移（右/下/上/左，逐级放大），取第一个不碰撞的位置
  const labelW = (t: string) => Math.min(160, t.length * 7.5 + 12)
  const LABEL_H = 18
  const placed: { x: number; y: number; w: number; h: number }[] = []
  for (const lp of labelPlacements.values()) {
    const w = labelW(lp.text)
    const baseX = lp.x
    const baseY = lp.y
    const steps = [0, 12, 24, 40, 60, 84, 110]
    let chosen: { x: number; y: number } | null = null
    outer: for (let i = 0; i < steps.length; i++) {
      const r = steps[i]
      const candidates = [
        { x: baseX + r, y: baseY },
        { x: baseX, y: baseY + r },
        { x: baseX - r, y: baseY },
        { x: baseX, y: baseY - r },
        { x: baseX + r * 0.7, y: baseY + r * 0.7 },
        { x: baseX - r * 0.7, y: baseY + r * 0.7 },
      ]
      for (const c of candidates) {
        const box = { x: c.x, y: c.y, w, h: LABEL_H }
        const hitLabel = placed.some(
          (p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y,
        )
        const hitNode = nodeRects.some(
          (n) => box.x < n.x + n.width && box.x + box.w > n.x && box.y < n.y + n.height && box.y + box.h > n.y,
        )
        if (!hitLabel && !hitNode) {
          chosen = c
          break outer
        }
      }
    }
    if (!chosen) chosen = { x: baseX + 12, y: baseY + 12 } // 兜底
    placed.push({ x: chosen.x, y: chosen.y, w, h: LABEL_H })
    lp.x = chosen.x
    lp.y = chosen.y
  }

  const body: string[] = []
  if (usePaper) body.push(Svg.rect(0, 0, scene.width, scene.height, { fill: bg }))
  body.push(
    Svg.g(
      { id: 'paint' },
      scene.elements.map((el) => {
        if (el.type !== 'edge') return renderElement(el)
        const hit = routedEdges.find((r) => r.el === el)
        if (!hit) return renderEdge(el, nodeById)
        return renderEdgeWithLabel(hit.el, hit.routed, labelPlacements)
      }).filter(Boolean),
    ),
  )
  if (usePaper) body.push(Svg.rect(0, 0, scene.width, scene.height, { fill: 'url(#vg)' }))

  return Svg.doc(scene.width, scene.height, body, { defs, background: usePaper ? undefined : bg })
}

/** 与 renderEdge 相同，但标签位置由场景级碰撞检测结果决定。 */
function renderEdgeWithLabel(
  el: EdgeElement,
  routed: RoutedEdge,
  labelPlacements: Map<string, { text: string; x: number; y: number }>,
): string {
  const parts: string[] = []
  const attrs = {
    fill: 'none',
    stroke: escapeXml(el.stroke_color),
    'stroke-width': num(el.stroke_width),
    'stroke-dasharray': routed.dashed ? '8 6' : undefined,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }
  parts.push(Svg.path(routed.pathD, attrs))
  const col = escapeXml(el.stroke_color)
  if (routed.arrow !== 'none') {
    parts.push(arrowShape(routed.arrow, routed.arrowTip, routed.arrowAngle, 10 + el.stroke_width, col))
  }
  // 标准 ER 关系端标记
  const d = el.data ?? {}
  const fromCard = typeof d.from_card === 'string' ? d.from_card : ''
  const toCard = typeof d.to_card === 'string' ? d.to_card : ''
  if (fromCard) parts.push(erEndMarker(fromCard, routed.fromTip, routed.fromAngle, col, el.stroke_width))
  if (toCard) parts.push(erEndMarker(toCard, routed.arrowTip, routed.arrowAngle, col, el.stroke_width))
  let labelSvg = ''
  if (routed.label) {
    const lp = labelPlacements.get(el.id)
    const useX = lp?.x ?? edgeMidpoint(routed).x + 8
    const useY = lp?.y ?? edgeMidpoint(routed).y - 8
    labelSvg = Svg.text(useX, useY, routed.label, {
      'font-size': '13px',
      fill: '#495057',
      'font-family': "'Virgil','Segoe Print','Comic Sans MS','Comic Sans',cursive",
    })
  }
  return Svg.g({ id: el.id }, [Svg.g({}, [parts.join('')]), labelSvg].filter(Boolean))
}

export function renderElement(el: SceneElement): string {
  const seed = el.id
  const common = styleAttrs(el)
  switch (el.type) {
    case 'rectangle':
      return renderShape('rectangle', el, seed, common)
    case 'ellipse':
      return renderShape('ellipse', el, seed, common)
    case 'diamond':
      return renderShape('diamond', el, seed, common)
    case 'shape': {
      const shapeName = String((el.data as Record<string, unknown>)?.shape ?? 'rectangle') as ShapeType
      return renderShape(shapeName, el, seed, common)
    }
    case 'line':
      return renderLine(el, seed, common, false)
    case 'arrow':
      return renderLine(el, seed, common, true)
    case 'draw':
      return renderDraw(el, seed, common)
    case 'text':
      return renderText(el)
    case 'image':
      return renderImage(el)
    case 'frame':
      return renderShape('rectangle', el, seed, common)
    default:
      return ''
  }
}

// ---------- shapes ----------

function roughLinesToSvg(lines: Point[][]): string {
  return lines
    .map(([a, b]) => Svg.line(a.x, a.y, b.x, b.y))
    .join('')
}

function outlineSvg(poly: Point[], el: SceneElement, seed: string, cornerRadius = 0): string {
  const opts = {
    roughness: el.roughness,
    strokeWidth: el.stroke_width,
    dash: el.dash,
  }
  const usePoly = cornerRadius > 0 ? roundCorners(poly, cornerRadius) : poly
  const line1 = roughClosedShape(usePoly, { ...opts, seed: seed + ':o' })
  const inset = insetPolygon(usePoly, Math.max(1, el.stroke_width * 0.6))
  const line2 = roughClosedShape(inset, {
    ...opts,
    seed: seed + ':i',
    roughness: Math.min(1, el.roughness * 0.9),
  })
  return roughLinesToSvg(line1) + roughLinesToSvg(line2)
}

function fillSvg(poly: Point[], el: SceneElement, seed: string): string {
  const fillStyle = el.fill_style ?? 'hachure'
  if (fillStyle === 'none') return ''
  const bg = el.background_color
  if (!bg || bg === 'transparent') return ''
  const base = Svg.polygon(poly, {
    fill: escapeXml(bg),
    'fill-opacity': num((el.opacity / 100) * 0.85, 3),
    stroke: 'none',
  })
  if (fillStyle === 'solid') return base
  const lines =
    fillStyle === 'cross-hatch'
      ? crossHatchFill(poly, { seed, roughness: el.roughness, strokeWidth: el.stroke_width, hachureGap: 10 })
      : hachureFill(poly, { seed, roughness: el.roughness, strokeWidth: el.stroke_width, hachureGap: 8 })
  const stroke = Svg.g(
    {
      stroke: escapeXml(bg),
      'stroke-width': num(Math.max(1, el.stroke_width * 0.7)),
      'stroke-linecap': 'round',
      opacity: num((el.opacity / 100) * 0.9, 3),
    },
    [roughLinesToSvg(lines)],
  )
  return base + stroke
}

function wrap(el: SceneElement, inner: string): string {
  const parts: string[] = [`<g id="${el.id}"`]
  if (el.angle) {
    parts.push(`transform="rotate(${num((el.angle * 180) / Math.PI)} ${num(el.x + el.width / 2)} ${num(el.y + el.height / 2)})"`)
  }
  parts.push(`>${inner}</g>`)
  return parts.join(' ')
}

function renderShape(shape: ShapeType, el: SceneElement, seed: string, common: Record<string, string>): string {
  const box = { x: el.x, y: el.y, width: el.width, height: el.height }
  const geo = shapeGeometry(shape, box)
  const poly = geo.outline

  // extras (cylinder top cap, note fold, actor body) — drawn over fill
  let extras = ''
  for (const ex of geo.extras ?? []) {
    if (ex.kind === 'ellipse' && ex.cx !== undefined && ex.cy !== undefined && ex.rx !== undefined && ex.ry !== undefined) {
      extras += Svg.ellipse(ex.cx, ex.cy, ex.rx, ex.ry, {
        fill: escapeXml(el.background_color === 'transparent' ? '#fff' : el.background_color),
        stroke: 'none',
      })
    } else if (ex.kind === 'polygon' && ex.points) {
      extras += Svg.polygon(ex.points, {
        fill: escapeXml(el.background_color === 'transparent' ? '#fff' : el.background_color),
        stroke: 'none',
      })
    } else if (ex.kind === 'stroke' && ex.points && ex.points.length >= 2) {
      // 描边折线（如 actor 身体线条）——与轮廓同色同粗细
      const lines = ex.points
        .map((p, i) => (i === 0 ? `M ${num(p.x)} ${num(p.y)}` : `L ${num(p.x)} ${num(p.y)}`))
        .join(' ')
      extras += Svg.path(lines, {
        fill: 'none',
        stroke: escapeXml(el.stroke_color),
        'stroke-width': num(el.stroke_width),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      })
    }
  }

  const fill = fillSvg(poly, el, seed)
  const stroke = `<g ${attrsToString(common)}>${outlineSvg(poly, el, seed)}</g>`
  // extras（圆柱顶盖 / 便签折角）绘制在填充之上：顶盖保持纯色不被影线穿过
  return wrap(el, fill + extras + stroke)
}

function attrsToString(a: Record<string, string>): string {
  return Object.entries(a)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')
}

// ---------- lines ----------

function renderLine(el: LineElement | ArrowElement, seed: string, common: Record<string, string>, isArrow: boolean): string {
  const pts = (el.data?.points ?? []).map(([x, y]) => ({ x, y }))
  if (pts.length < 2) return ''
  const segments = roughLine(pts, {
    seed,
    roughness: el.roughness,
    strokeWidth: el.stroke_width,
    dash: el.dash,
  })
  const paths = roughLinesToSvg(segments)
  let head = ''
  if (isArrow) {
    const last = pts[pts.length - 1]
    const prev = pts[pts.length - 2]
    const ang = angleOf(prev, last)
    const len = Math.max(9, el.stroke_width * 4)
    const spread = 0.45
    const p1 = { x: last.x - len * Math.cos(ang - spread), y: last.y - len * Math.sin(ang - spread) }
    const p2 = { x: last.x - len * Math.cos(ang + spread), y: last.y - len * Math.sin(ang + spread) }
    head = `<path d="M ${num(last.x)} ${num(last.y)} L ${num(p1.x)} ${num(p1.y)} M ${num(last.x)} ${num(last.y)} L ${num(p2.x)} ${num(p2.y)}" fill="none" ${attrsToString(common)}/>`
  }
  return wrap(el, `<g ${attrsToString(common)}>${paths}${head}</g>`)
}

function renderDraw(el: DrawElement, seed: string, common: Record<string, string>): string {
  const pts = (el.data?.points ?? []).map(([x, y]) => ({ x, y }))
  if (pts.length < 2) return ''
  const segments = roughLine(pts, { seed, roughness: el.roughness, strokeWidth: el.stroke_width, dash: el.dash })
  return wrap(el, `<g ${attrsToString(common)}>${roughLinesToSvg(segments)}</g>`)
}

// ---------- text ----------

function renderText(el: TextElement): string {
  const d = el.data ?? {}
  const text = String(d.text ?? '')
  const fontSize = Number(d.font_size ?? 20)
  const align = (d.text_align ?? 'left') as 'left' | 'center' | 'right'
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
  const tx = align === 'center' ? el.x + el.width / 2 : align === 'right' ? el.x + el.width : el.x
  const ty = el.y + fontSize * 0.8
  const lines = text.split('\n')
  const tspans = lines
    .map((l, i) => Svg.tspan(tx, i === 0 ? 0 : fontSize * 1.2, l))
    .join('')
  const attrs: Record<string, string> = {
    'font-size': `${fontSize}px`,
    'font-family': "'Virgil','Segoe Print','Comic Sans MS','Comic Sans',cursive",
    fill: escapeXml(el.stroke_color),
    'text-anchor': anchor,
    x: num(tx),
    y: num(ty),
  }
  // 文字白描边：先画描边、后画填充（paint-order），保证粗描边不压坏字形
  const strokeColor = String(d.text_stroke_color ?? '').trim()
  if (strokeColor) {
    attrs['stroke'] = escapeXml(strokeColor)
    attrs['stroke-width'] = String(Number(d.text_stroke_width ?? 3))
    attrs['stroke-linejoin'] = 'round'
    attrs['paint-order'] = 'stroke'
  }
  return wrap(el, `<text ${attrsToString(attrs)}>${tspans}</text>`)
}

function renderImage(el: ImageElement): string {
  const href = String((el.data as Record<string, unknown>)?.data_url ?? '')
  if (!href) return ''
  return wrap(el, `<image href="${escapeXml(href)}" x="${num(el.x)}" y="${num(el.y)}" width="${num(el.width)}" height="${num(el.height)}" preserveAspectRatio="xMidYMid meet"/>`)
}

function ellipsePoly(cx: number, cy: number, rx: number, ry: number): Point[] {
  const pts: Point[] = []
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * Math.PI * 2
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) })
  }
  return pts
}

// ---------- edges (connector-based) ----------

const EDGE_TYPES: EdgeType[] = ['straight', 'orthogonal', 'bezier', 'smooth', 'arc']
const ARROW_HEADS: ArrowHead[] = ['none', 'triangle', 'circle', 'diamond']

function arrowShape(arrow: ArrowHead, tip: Point, ang: number, size: number, color: string): string {
  const back = {
    x: tip.x - size * Math.cos(ang),
    y: tip.y - size * Math.sin(ang),
  }
  const perp = {
    x: -Math.sin(ang) * (size * 0.45),
    y: Math.cos(ang) * (size * 0.45),
  }
  if (arrow === 'triangle') {
    return Svg.polygon(
      [tip, { x: back.x + perp.x, y: back.y + perp.y }, { x: back.x - perp.x, y: back.y - perp.y }],
      { fill: color, stroke: 'none' },
    )
  }
  if (arrow === 'diamond') {
    return Svg.polygon(
      [tip, { x: back.x + perp.x, y: back.y + perp.y }, back, { x: back.x - perp.x, y: back.y - perp.y }],
      { fill: color, stroke: 'none' },
    )
  }
  if (arrow === 'circle') {
    return Svg.ellipse(tip.x, tip.y, size * 0.5, size * 0.5, { fill: color, stroke: 'none' })
  }
  return ''
}

/**
 * ER 关系端标记（标准 crow's foot 记法）：
 *   - '1'            → 单条垂直短杠（one）
 *   - 'N'/'M'/'many' → 三叉脚（crow's foot，many）
 *   - '0'/'zero'     → 小圆圈（optional）
 * 绘于节点边线上的接触点。along 指向节点内侧，标记的叉/杠展开在边线外。
 */
export function erEndMarker(card: string, tip: Point, ang: number, color: string, strokeWidth: number): string {
  const size = 9 + strokeWidth * 2
  const along = { x: Math.cos(ang), y: Math.sin(ang) }
  const perp = { x: -Math.sin(ang), y: Math.cos(ang) }
  // tip + along*t + perp*o：t>0 向节点内，o 沿边线展开
  const px = (t: number, o: number) => ({ x: tip.x + along.x * t + perp.x * o, y: tip.y + along.y * t + perp.y * o })
  const stroke = { stroke: color, 'stroke-width': num(strokeWidth), 'stroke-linecap': 'round' as const }
  const c = card.trim().toUpperCase()
  if (c === 'N' || c === 'M' || c === 'MANY') {
    // crow's foot：三叉在边线外收敛于一点，叉尖落回边线
    const foot = size * 0.55 // 叉深
    const spread = size * 0.5 // 叉张开宽度
    const base = px(-foot, 0) // 收敛点（边线外）
    return [
      [base, tip],              // 中心趾（回到接触点）
      [base, px(0, spread)],    // 左叉尖（边线上）
      [base, px(0, -spread)],   // 右叉尖（边线上）
    ]
      .map(([a, b]) => Svg.line(a.x, a.y, b.x, b.y, stroke))
      .join('')
  }
  if (c === '0' || c === 'ZERO') {
    return Svg.ellipse(tip.x, tip.y, size * 0.3, size * 0.3, {
      fill: 'none',
      stroke: color,
      'stroke-width': num(strokeWidth),
    })
  }
  // 默认：单杠（one）——垂直于连线、横在接触点外
  const bar = size * 0.35
  return Svg.line(px(0, -bar).x, px(0, -bar).y, px(0, bar).x, px(0, bar).y, stroke)
}

function renderEdge(el: EdgeElement, nodeById: Map<string, ConnectorNode>): string {
  const d = el.data ?? {}
  const from = nodeById.get(String(d.from ?? ''))
  const to = nodeById.get(String(d.to ?? ''))
  if (!from || !to) return ''

  const type = (EDGE_TYPES.includes(d.edge_type as EdgeType) ? d.edge_type : 'straight') as EdgeType
  const arrow = (ARROW_HEADS.includes(d.arrow as ArrowHead) ? d.arrow : 'triangle') as ArrowHead
  // 收集除 from/to 外的节点作为正交避障障碍
  const obstacles = [...nodeById.values()].filter((n) => n.key !== from.key && n.key !== to.key)
  const routed = routeEdge(from, to, {
    type,
    dashed: Boolean(d.dashed),
    label: typeof d.label === 'string' ? d.label : undefined,
    arrow,
    obstacles,
  })

  const parts: string[] = []
  const attrs = {
    fill: 'none',
    stroke: escapeXml(el.stroke_color),
    'stroke-width': num(el.stroke_width),
    'stroke-dasharray': routed.dashed ? '8 6' : undefined,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }
  parts.push(Svg.path(routed.pathD, attrs))

  const col = escapeXml(el.stroke_color)
  // arrowhead: 尖端恰好触边（arrowTip 在边线上），主体在 ARROW_GAP 外侧
  if (arrow !== 'none') {
    parts.push(arrowShape(arrow, routed.arrowTip, routed.arrowAngle, 10 + el.stroke_width, col))
  }
  // 标准 ER 关系端标记（crow's foot / 单杠 / 圆圈）
  const fromCard = typeof d.from_card === 'string' ? d.from_card : ''
  const toCard = typeof d.to_card === 'string' ? d.to_card : ''
  if (fromCard) {
    parts.push(erEndMarker(fromCard, routed.fromTip, routed.fromAngle, col, el.stroke_width))
  }
  if (toCard) {
    parts.push(erEndMarker(toCard, routed.arrowTip, routed.arrowAngle, col, el.stroke_width))
  }

  // label（碰撞避免在 renderSceneSvg 层统一处理，这里返回基础位置）
  let labelSvg = ''
  if (routed.label) {
    const mid = edgeMidpoint(routed)
    labelSvg = Svg.text(mid.x + 8, mid.y - 8, routed.label, {
      'font-size': '13px',
      fill: '#495057',
      'font-family': "'Virgil','Segoe Print','Comic Sans MS','Comic Sans',cursive",
    })
  }

  return Svg.g({ id: el.id }, [Svg.g({}, [parts.join('')]), labelSvg].filter(Boolean))
}
