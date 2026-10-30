/**
 * 绘制层：把 FinalPlan / 规划结果渲染成场景元素。
 *
 * 从 diagram-tools / special-diagrams / arch-tools 中抽取的共用绘制函数：
 *   - drawFlowScene      流程图（布局节点 + 成组边路由 + 主链路/回边曲线策略）
 *   - drawSequenceScene  时序图
 *   - drawErScene        ER 图
 *   - drawArchScene      架构图（分层 frame + 模块 + 跨层边）
 *   - drawPlanScene      create_diagram 统一入口（按 kind 分发）
 *
 * 各绘制函数只往 scene.elements push 元素，返回节点 key → 场景元素 id 映射，
 * 供调用方返回结果或进一步微调。
 */

import { createElement, type Scene, type TextElement } from '../core/scene.js'
import type { ShapeType } from '../core/shapes.js'
import type { LayoutKind } from '../core/layout.js'
import { routeEdgeBundle, type ConnectorNode, type EdgeType } from '../core/edge-bundle.js'
import type { DiamondBranch } from '../core/connectors.js'
import type {
  FinalPlan,
  NormalizedNode,
  NormalizedEdge,
} from '../core/plan.js'
import { planSequenceDiagram, type SeqParticipant, type SeqMessage } from '../core/sequence.js'
import { planErDiagram, type ErEntity, type ErRelation } from '../core/er.js'
import { planArchitectureDiagram, type ArchLayer, type ArchLink, type ArchOptions } from '../core/arch.js'
import { safeText, textWidth } from './validators.js'
import { makeId } from './element-tools.js'

const EDGE_TYPES: EdgeType[] = ['straight', 'orthogonal', 'bezier', 'smooth', 'arc']

/** 默认糖果色板。 */
export const PALETTE = ['#ffd8a8', '#b2f2bb', '#a5d8ff', '#ffc9c9', '#d0bfff', '#ffec99', '#c3fae8']

export interface DrawStyle {
  strokeWidth?: number
  roughness?: number
  /** 节点文字描边色（"none" 关闭）。 */
  labelStrokeColor?: string
  palette?: string[]
}

const DEF_STYLE: Required<Omit<DrawStyle, 'palette'>> & { palette: string[] } = {
  strokeWidth: 2,
  roughness: 1,
  labelStrokeColor: '#ffffff',
  palette: PALETTE,
}

function styleOf(s: DrawStyle = {}): Required<DrawStyle> & { palette: string[] } {
  return {
    strokeWidth: s.strokeWidth ?? DEF_STYLE.strokeWidth,
    roughness: s.roughness ?? DEF_STYLE.roughness,
    labelStrokeColor: s.labelStrokeColor ?? DEF_STYLE.labelStrokeColor,
    palette: s.palette ?? DEF_STYLE.palette,
  }
}

/** 从边标签推断菱形分支：是/yes/Y/true → yes；否/no/N/false → no；其余 undefined。 */
function branchFromLabel(label?: string): DiamondBranch {
  const l = (label ?? '').trim().toLowerCase()
  if (l === '是' || l === 'yes' || l === 'y' || l === 'true' || l === '✓' || l === '√') return 'yes'
  if (l === '否' || l === 'no' || l === 'n' || l === 'false' || l === '×' || l === '✗') return 'no'
  return undefined
}

/** 节点矩形表 → 可路由 ConnectorNode 表。 */
export function rectsToConnectorNodes(
  rects: Record<string, { x: number; y: number; width: number; height: number }>,
  shapes: Record<string, ShapeType> = {},
): Map<string, ConnectorNode> {
  const m = new Map<string, ConnectorNode>()
  for (const [key, r] of Object.entries(rects)) {
    m.set(key, { key, shape: shapes[key] ?? 'rectangle', x: r.x, y: r.y, width: r.width, height: r.height })
  }
  return m
}

// ---------------------------------------------------------------------------
// 流程图
// ---------------------------------------------------------------------------

interface SecondaryEdgeSpec {
  type: EdgeType
  /** 强制正交 U/Z 型（≥3 段）路由。true = 正交优先。 */
  minBends: number
}

/**
 * 流程图边路由规则（layered 布局）：
 *   - 回边/倒退边（环，层深不增或倒退）→ 优先正交 U/Z 型；正交不通时弧线兜底
 *   - 主链路（从起点沿「层+1 且 y 对齐」的唯一路径）→ 保持直线
 *   - 入度 ≥ 2 的节点：除主链路入边外的其余入边（汇聚边）→ 优先正交，不通时弧线
 */
export function secondaryEdgeTypes(
  layout: { nodes: Record<string, { x: number; y: number; width: number; height: number }> },
  edges: NormalizedEdge[],
  layoutKind: LayoutKind,
): Map<string, SecondaryEdgeSpec> {
  const overrides = new Map<string, SecondaryEdgeSpec>()
  const keyOf = (e: NormalizedEdge) => `${e.from}->${e.to}`
  if (layoutKind !== 'layered') return overrides

  // ---- 1. 层深（与 layout 的 depth 逻辑一致：环回边视作根） ----
  const parents = new Map<string, string[]>()
  for (const e of edges) {
    if (e.from === e.to) continue
    const list = parents.get(e.to) ?? []
    list.push(e.from)
    parents.set(e.to, list)
  }
  const nodeKeys = Object.keys(layout.nodes)
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const MAX_DEPTH = nodeKeys.length + 1
  const depth = (k: string, _d = 0): number => {
    if (_d > MAX_DEPTH) { memo.set(k, 0); return 0 }
    const hit = memo.get(k)
    if (hit !== undefined) return hit
    const ps = parents.get(k) ?? []
    if (ps.length === 0) { memo.set(k, 0); return 0 }
    if (visiting.has(k)) { memo.set(k, 0); return 0 }
    visiting.add(k)
    let d = 0
    for (const p of ps) d = Math.max(d, depth(p, _d + 1) + 1)
    visiting.delete(k)
    memo.set(k, d)
    return d
  }
  const layer = new Map<string, number>()
  for (const k of nodeKeys) layer.set(k, depth(k))

  const xOf = new Map<string, number>()
  const yOf = new Map<string, number>()
  for (const [k, r] of Object.entries(layout.nodes)) {
    xOf.set(k, r.x)
    yOf.set(k, r.y)
  }

  // ---- 2. 回边 → 正交优先，弧线兜底 ----
  for (const e of edges) {
    if (e.from === e.to) continue
    const lf = layer.get(e.from) ?? 0
    const lt = layer.get(e.to) ?? 0
    if (lf >= lt) overrides.set(keyOf(e), { type: 'orthogonal', minBends: 1 })
  }

  // ---- 3. 主链路 ----
  const startNodes = nodeKeys.filter((k) => (parents.get(k)?.length ?? 0) === 0)
  const start =
    (startNodes.length > 0 ? startNodes : nodeKeys).sort(
      (a, b) => (xOf.get(a) ?? 0) - (xOf.get(b) ?? 0),
    )[0] ?? nodeKeys[0]
  const chainEdges = new Set<string>()
  {
    let cur = start
    const seen = new Set<string>([start])
    for (;;) {
      const out = edges.filter((e) => e.from === cur && e.from !== e.to)
      if (out.length === 0) break
      const curLayer = layer.get(cur) ?? 0
      const forward = out.filter((e) => (layer.get(e.to) ?? 0) > curLayer)
      const pick = (list: NormalizedEdge[]) =>
        [...list].sort(
          (a, b) =>
            Math.abs((yOf.get(a.to) ?? 0) - (yOf.get(cur) ?? 0)) -
            Math.abs((yOf.get(b.to) ?? 0) - (yOf.get(cur) ?? 0)),
        )[0]
      const next =
        pick(forward.filter((e) => (layer.get(e.to) ?? 0) === curLayer + 1)) ?? pick(forward)
      if (!next) break
      chainEdges.add(keyOf(next))
      if (seen.has(next.to)) break
      seen.add(next.to)
      cur = next.to
    }
  }

  // ---- 4. 入度 ≥ 2 节点：非主链路入边 → 正交 ----
  const incoming = new Map<string, NormalizedEdge[]>()
  for (const e of edges) {
    if (e.from === e.to) continue
    const list = incoming.get(e.to) ?? []
    list.push(e)
    incoming.set(e.to, list)
  }
  for (const ins of incoming.values()) {
    if (ins.length < 2) continue
    for (const e of ins) {
      const k = keyOf(e)
      if (chainEdges.has(k)) continue
      if (overrides.has(k)) continue
      overrides.set(k, { type: 'orthogonal', minBends: 1 })
    }
  }
  return overrides
}

export interface FlowSceneResult {
  nodeIds: Record<string, string>
  shapes: Record<string, ShapeType>
  layoutKind: LayoutKind
}

/**
 * 把 FinalPlan 渲染为流程图节点 + 连接线。
 * 自环边（from===to）由 routeEdgeBundle 单独画成小环，不参与布局。
 */
export function drawFlowScene(
  scene: Scene,
  plan: FinalPlan,
  style: DrawStyle = {},
): FlowSceneResult {
  const s = styleOf(style)
  const { nodeList, edges } = plan
  const nodeIds: Record<string, string> = {}
  const shapes: Record<string, ShapeType> = {}
  for (const n of nodeList) shapes[n.key] = n.shape

  // ---- 节点（shape + label） ----
  let palIdx = 0
  for (const n of nodeList) {
    const r = plan.nodes[n.key]
    if (!r) continue
    const fill = n.fill ?? s.palette[palIdx++ % s.palette.length]
    const el = createElement('shape', {
      id: makeId('node'),
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      stroke_color: '#1e1e1e',
      background_color: fill,
      fill_style: 'hachure',
      stroke_width: s.strokeWidth,
      roughness: s.roughness,
      data: { shape: n.shape },
    })
    scene.elements.push(el)
    nodeIds[n.key] = el.id

    const labelText = safeText(n.name)
    const labelFont = Math.max(
      10,
      Math.min(15, Math.floor((r.width - 16) / Math.max(textWidth(labelText, 15) / 15, 0.1))),
    )
    const label = createElement('text', {
      id: makeId('label'),
      x: r.x,
      y: r.y + r.height / 2 - labelFont * 0.75,
      width: r.width,
      height: 22,
      stroke_color: '#1e1e1e',
      roughness: 0,
      data: { text: labelText, font_size: labelFont, text_align: 'center' },
    })
    if (s.labelStrokeColor !== 'none') {
      ;(label.data as TextElement['data']).text_stroke_color = s.labelStrokeColor
      ;(label.data as TextElement['data']).text_stroke_width = 3
    }
    scene.elements.push(label)
  }

  // ---- 边 ----
  drawFlowEdges(scene, plan, nodeIds, shapes, s.roughness, style)

  return { nodeIds, shapes, layoutKind: plan.kind }
}

function drawFlowEdges(
  scene: Scene,
  plan: FinalPlan,
  nodeIds: Record<string, string>,
  shapes: Record<string, ShapeType>,
  roughness: number,
  style: DrawStyle,
): void {
  const connNodes = rectsToConnectorNodes(plan.nodes, shapes)
  // 布局阶段识别出的回边（构成环、从下游回到上游）作为权威来源；
  // 回边 → 正交优先 + 目标入点选垂直主方向的侧
  const backKeys = new Set((plan.backEdges ?? []).map((e) => `${e.from}->${e.to}`))
  const overrides = secondaryEdgeTypes(plan, plan.edges, plan.kind)
  const bundle = routeEdgeBundle(
    connNodes,
    plan.edges.map((s) => {
      const forced = overrides.get(`${s.from}->${s.to}`)
      const isBack = backKeys.has(`${s.from}->${s.to}`)
      return {
        from: s.from,
        to: s.to,
        // 回边强制正交 U 型绕行；其余按用户指定或主链路/汇聚启发式
        type: isBack ? 'orthogonal' : forced?.type ?? s.type,
        minBends: isBack ? 1 : forced?.minBends,
        dashed: s.dashed,
        label: s.label,
        arrow: 'triangle',
        // 布局方向 + 菱形是/否分支：让菱形桩点随布局方向选择
        direction: plan.direction,
        branch: branchFromLabel(s.label),
        // 回边标记：目标入点选垂直主布局方向的侧
        backedge: isBack,
      }
    }),
    { separateInOut: true },
  )
  for (const edge of bundle.edges) {
    scene.elements.push(
      createElement('edge', {
        id: makeId('edge'),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        stroke_color: '#1e1e1e',
        stroke_width: 2,
        roughness: Math.min(1, roughness * 0.8),
        data: {
          from: nodeIds[edge.from],
          to: nodeIds[edge.to],
          edge_type: edge.type,
          dashed: edge.dashed,
          label: edge.label,
          arrow: edge.arrow,
          // 透传布局期语义：渲染层会重新路由一次，必须知道哪些边是回边，
          // 否则会退回「内部正交通道」而斜穿主链。
          backedge: backKeys.has(`${edge.from}->${edge.to}`),
          direction: plan.direction,
        },
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// 时序图
// ---------------------------------------------------------------------------

export function drawSequenceScene(
  scene: Scene,
  participants: SeqParticipant[],
  messages: SeqMessage[],
  opts: { title?: string; style?: DrawStyle } = {},
): void {
  const s = styleOf(opts.style)
  const seq = planSequenceDiagram(participants, messages, { title: opts.title })
  const palette = s.palette
  let pal = 0

  if (opts.title) {
    const tw = Math.max(200, seq.width - 80)
    scene.elements.push(
      createElement('text', {
        id: makeId('title'),
        x: (seq.width - tw) / 2,
        y: 20,
        width: tw,
        height: 30,
        stroke_color: '#1e1e1e',
        data: { text: safeText(opts.title), font_size: 20, text_align: 'center' },
      }),
    )
  }

  for (const p of participants) {
    const lf = seq.participants.find((l) => l.key === p.key)
    if (!lf) continue
    const boxW = 130
    scene.elements.push(
      createElement('line', {
        id: makeId('lifeline'),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        stroke_color: '#adb5bd',
        stroke_width: 1,
        stroke_style: 'dashed',
        dash: [4, 4],
        data: { points: [[lf.x, lf.lineY1], [lf.x, lf.lineY2]] },
      }),
    )
    const fill = p.fill ?? palette[pal++ % palette.length]
    const shape = p.shape === 'actor' ? 'actor' : p.shape === 'cylinder' ? 'cylinder' : 'rectangle'
    scene.elements.push(
      createElement('shape', {
        id: makeId('participant'),
        x: lf.x - boxW / 2,
        y: lf.boxY,
        width: boxW,
        height: lf.boxHeight,
        stroke_color: '#1e1e1e',
        background_color: fill,
        fill_style: 'hachure',
        stroke_width: 2,
        data: { shape },
      }),
      createElement('text', {
        id: makeId('pname'),
        x: lf.x - boxW / 2,
        y: lf.boxY + lf.boxHeight / 2 - 11,
        width: boxW,
        height: 22,
        stroke_color: '#1e1e1e',
        data: { text: safeText(p.label), font_size: 14, text_align: 'center' },
      }),
    )
  }

  // 激活条：参与者生命周期矩形条（在 lifeline 上，消息参与期间高亮）
  for (const act of seq.activations ?? []) {
    const barH = act.y2 - act.y1
    if (barH <= 0) continue
    scene.elements.push(
      createElement('shape', {
        id: makeId('activation'),
        x: act.x,
        y: act.y1,
        width: 6,
        height: barH,
        stroke_color: '#1971c2',
        background_color: '#a5d8ff',
        fill_style: 'solid',
        stroke_width: 1,
        roughness: 0,
        data: { shape: 'rectangle' },
      }),
    )
  }

  for (const row of seq.rows) {
    const pts = row.self
      ? [
          [row.x1, row.y],
          [row.x1 + 34, row.y],
          [row.x1 + 34, row.y - 22],
          [row.x1, row.y - 22],
        ]
      : [
          [row.x1, row.y],
          [row.x2, row.y],
        ]
    scene.elements.push(
      createElement('arrow', {
        id: makeId('msg'),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        stroke_color: '#1e1e1e',
        stroke_width: 2,
        roughness: 0,
        stroke_style: row.dashed ? 'dashed' : 'solid',
        dash: row.dashed ? [6, 5] : undefined,
        data: { points: pts as [number, number][] },
      }),
    )
    // 消息标签位于箭头上方。文字的渲染基线是 y + fontSize*0.8（13px → +10.4），
    // 因此 y 需要比箭头再高出「字高 + 间距」，否则文字底部会压在线上。
    const labelX = row.self ? row.x1 + 14 : (row.x1 + row.x2) / 2
    const FONT = 13
    scene.elements.push(
      createElement('text', {
        id: makeId('msglabel'),
        x: labelX,
        y: row.y - FONT * 0.8 - 8 - 2,
        width: 200,
        height: 18,
        stroke_color: '#495057',
        data: { text: safeText(row.label), font_size: FONT, text_align: row.self ? 'left' : 'center' },
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// ER 图
// ---------------------------------------------------------------------------

export function drawErScene(
  scene: Scene,
  entities: ErEntity[],
  relations: ErRelation[],
  style: DrawStyle = {},
): void {
  const s = styleOf(style)
  const er = planErDiagram(entities, relations)
  const palette = s.palette
  let pal = 0
  const entityIds: Record<string, string> = {}

  for (const ent of entities) {
    const r = er.entities[ent.key]
    if (!r) continue
    const fill = ent.fill ?? palette[pal++ % palette.length]
    const headerId = makeId('er_header')
    entityIds[ent.key] = headerId
    scene.elements.push(
      createElement('shape', {
        id: headerId,
        x: r.x,
        y: r.y,
        width: r.width,
        height: 40,
        stroke_color: '#1e1e1e',
        background_color: fill,
        fill_style: 'hachure',
        stroke_width: 2,
        data: { shape: 'rectangle' },
      }),
      createElement('text', {
        id: makeId('er_title'),
        x: r.x,
        y: r.y + 10,
        width: r.width,
        height: 22,
        stroke_color: '#1e1e1e',
        data: { text: safeText(ent.label), font_size: 15, text_align: 'center' },
      }),
    )
    let fy = r.y + 40
    for (const f of ent.fields) {
      scene.elements.push(
        createElement('line', {
          id: makeId('er_row'),
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          stroke_color: '#adb5bd',
          stroke_width: 1,
          data: { points: [[r.x, fy], [r.x + r.width, fy]] },
        }),
      )
      const fieldText = safeText(f.name) + (f.type ? `  ${safeText(f.type)}` : '')
      const tx = f.key ? r.x + 26 : r.x + 10
      scene.elements.push(
        createElement('text', {
          id: makeId('er_field'),
          x: tx,
          y: fy + 4,
          width: r.width - 30,
          height: 20,
          stroke_color: f.key ? '#1971c2' : '#343a40',
          data: { text: fieldText, font_size: 13, text_align: 'left' },
        }),
      )
      if (f.key) {
        const kx = r.x + 13
        const ky = fy + 9
        scene.elements.push(
          createElement('shape', {
            id: makeId('er_key_ring'),
            x: kx - 3,
            y: ky - 3,
            width: 6,
            height: 6,
            stroke_color: '#1971c2',
            background_color: 'transparent',
            fill_style: 'none',
            stroke_width: 1.6,
            roughness: 0,
            data: { shape: 'ellipse' },
          }),
          createElement('line', {
            id: makeId('er_key_shaft'),
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            stroke_color: '#1971c2',
            stroke_width: 1.6,
            roughness: 0,
            data: { points: [[kx + 3, ky], [kx + 9, ky], [kx + 9, ky + 2]] },
          }),
        )
      }
      fy += 26
    }
    scene.elements.push(
      createElement('shape', {
        id: makeId('er_body'),
        x: r.x,
        y: r.y + 40,
        width: r.width,
        height: r.height - 40,
        stroke_color: '#1e1e1e',
        background_color: '#ffffff',
        fill_style: 'none',
        stroke_width: 2,
        data: { shape: 'rectangle' },
      }),
    )
  }

  for (const rel of er.relations) {
    const fromId = entityIds[rel.from]
    const toId = entityIds[rel.to]
    if (!fromId || !toId) continue
    scene.elements.push(
      createElement('edge', {
        id: makeId('er_rel'),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        stroke_color: '#1e1e1e',
        stroke_width: 2,
        data: {
          from: fromId,
          to: toId,
          edge_type: rel.type,
          dashed: false,
          label: rel.label,
          arrow: 'none',
          from_card: rel.fromCard,
          to_card: rel.toCard,
        },
      }),
    )
    // 基数标注（1 / N / M）由【渲染层】在真实路由结果上绘制（见 render.ts 的
    // erEndMarker）—— 这里不预先算坐标：布局坐标在 centerScene 平移后会失真，
    // 而渲染层拿到的 routed 已经包含最终位置与实际走线方向。
  }
}

// ---------------------------------------------------------------------------
// 架构图
// ---------------------------------------------------------------------------

export interface ArchSceneResult {
  moduleIds: Record<string, string>
  /** 层框坐标（供调用方返回结果 / 微调）。 */
  layerRects: Record<string, { x: number; y: number; width: number; height: number }>
  /** 模块坐标（key → rect）。 */
  moduleRects: Record<string, { x: number; y: number; width: number; height: number }>
  width: number
  height: number
}

export function drawArchScene(
  scene: Scene,
  layers: ArchLayer[],
  links: ArchLink[],
  style: DrawStyle = {},
  archOptions: ArchOptions = {},
): ArchSceneResult {
  const s = styleOf(style)
  const arch = planArchitectureDiagram(layers, links, archOptions)
  const moduleIds: Record<string, string> = {}
  const layerRects: ArchSceneResult['layerRects'] = {}
  const moduleRects: ArchSceneResult['moduleRects'] = {}

  for (const l of layers) {
    const lr = arch.layers[l.key]
    if (!lr) continue
    layerRects[l.key] = { x: lr.x, y: lr.y, width: lr.width, height: lr.height }
    scene.elements.push(
      createElement('frame', {
        id: makeId('arch_layer'),
        x: lr.x,
        y: lr.y,
        width: lr.width,
        height: lr.height,
        stroke_color: '#495057',
        background_color: lr.fill,
        fill_style: 'solid',
        stroke_width: 2,
        stroke_style: 'dashed',
        data: { children: [] },
      }),
      createElement('text', {
        id: makeId('arch_layer_title'),
        x: lr.x + 12,
        y: lr.y + 10,
        width: lr.width - 24,
        height: 24,
        stroke_color: '#343a40',
        data: { text: safeText(lr.label), font_size: 16, text_align: 'left' },
      }),
    )
    for (const m of l.modules) {
      const mr = lr.modules[m.key]
      if (!mr) continue
      moduleRects[m.key] = { x: mr.x, y: mr.y, width: mr.width, height: mr.height }
      const modId = makeId('arch_module')
      moduleIds[m.key] = modId
      scene.elements.push(
        createElement('shape', {
          id: modId,
          x: mr.x,
          y: mr.y,
          width: mr.width,
          height: mr.height,
          stroke_color: '#1e1e1e',
          background_color: mr.fill,
          fill_style: 'hachure',
          stroke_width: 2,
          data: { shape: 'rectangle' },
        }),
        createElement('text', {
          id: makeId('arch_module_label'),
          x: mr.x,
          y: mr.y + mr.height / 2 - 10,
          width: mr.width,
          height: 20,
          stroke_color: '#1e1e1e',
          data: { text: safeText(m.label), font_size: 13, text_align: 'center' },
        }),
      )
    }
  }

  // 模块 → 所属层框。渲染层据此做层感知路由：跨层连线先垂直穿出源层框、
  // 在框间空隙水平位移、再垂直进入目标层框，不会横穿层框内部。
  const moduleLayerRect: Record<string, { x: number; y: number; width: number; height: number }> = {}
  for (const l of layers) {
    const lr = layerRects[l.key]
    if (!lr) continue
    for (const m of l.modules) {
      if (moduleRects[m.key]) moduleLayerRect[m.key] = lr
    }
  }

  for (const link of arch.links) {
    const fromId = moduleIds[link.from]
    const toId = moduleIds[link.to]
    if (!fromId || !toId) continue
    scene.elements.push(
      createElement('edge', {
        id: makeId('arch_link'),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        stroke_color: '#1e1e1e',
        stroke_width: 2,
        data: {
          from: fromId,
          to: toId,
          edge_type: link.type,
          dashed: link.dashed === false ? false : true,
          label: link.label,
          arrow: 'triangle',
          fromLayer: moduleLayerRect[link.from],
          toLayer: moduleLayerRect[link.to],
          // 全部层框：跨多层连线需要知道中间隔着哪些层
          allLayers: Object.values(layerRects),
        },
      }),
    )
  }

  return { moduleIds, layerRects, moduleRects, width: arch.width, height: arch.height }
}

// ---------------------------------------------------------------------------
// create_diagram 统一分发
// ---------------------------------------------------------------------------

export interface DiagramSceneInput {
  kind: DiagramKind
  /** 流程图：已规划好的 FinalPlan。 */
  plan?: FinalPlan
  /** 时序图参与者 / ER 实体 / 架构图层：直接传给各自规划函数。 */
  participants?: SeqParticipant[]
  messages?: SeqMessage[]
  entities?: ErEntity[]
  relations?: ErRelation[]
  layers?: ArchLayer[]
  links?: ArchLink[]
  title?: string
  style?: DrawStyle
}

export type DiagramKind = 'flow' | 'sequence' | 'er' | 'architecture' | LayoutKind

/**
 * 按图类型分发绘制（create_diagram 统一入口的绘制侧）。
 * - flow / layered / tree / grid / circular → 流程图（需传入已规划好的 FinalPlan）
 * - sequence   → 时序图（participants/messages）
 * - er         → ER 图（entities/relations）
 * - architecture → 架构图（layers/links）
 *
 * 返回 { kind, nodeIds? } 供调用方组装结果。
 */
export function drawPlanScene(scene: Scene, input: DiagramSceneInput): {
  kind: DiagramKind
  nodeIds?: Record<string, string>
} {
  const s = styleOf(input.style)
  switch (input.kind) {
    case 'sequence':
      if (!input.participants) throw new Error('时序图需要 participants/messages')
      drawSequenceScene(scene, input.participants, input.messages ?? [], { title: input.title, style: s })
      return { kind: 'sequence' }
    case 'er':
      if (!input.entities) throw new Error('ER 图需要 entities/relations')
      drawErScene(scene, input.entities, input.relations ?? [], s)
      return { kind: 'er' }
    case 'architecture':
      if (!input.layers) throw new Error('架构图需要 layers/links')
      const { moduleIds } = drawArchScene(scene, input.layers, input.links ?? [], s)
      return { kind: 'architecture', nodeIds: moduleIds }
    default: {
      // flow / layered / tree / grid / circular：需要 FinalPlan
      if (!input.plan) throw new Error('流程图需要先调用 planDiagram 得到 FinalPlan，再传入 drawPlanScene')
      const { nodeIds } = drawFlowScene(scene, input.plan, s)
      return { kind: input.kind, nodeIds }
    }
  }
}
