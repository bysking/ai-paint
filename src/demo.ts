/**
 * 演示场景：展示多形状、多种连接线（bezier/arc/orthogonal/smooth）、
 * 分层布局，以及时序图 / ER 图的快速生成。
 *
 * 用法：node dist/index.js demo [sceneName]
 */

import { createElement, blankScene, type Scene } from './core/scene.js'
import { computeLayout, type LayoutNodeSpec, type LayoutEdgeSpec } from './core/layout.js'
import { routeEdgeBundle, type ConnectorNode } from './core/edge-bundle.js'
import { planSequenceDiagram } from './core/sequence.js'
import { planErDiagram } from './core/er.js'

let n = 0
const id = (p: string) => `${p}_${++n}`

export async function renderDemoScene(name = 'demo'): Promise<Scene> {
  const scene = blankScene(name, 1400, 1000)

  // ===== 1. 主标题 =====
  scene.elements.push(
    createElement('text', {
      id: id('title'),
      x: 60, y: 40, width: 800, height: 40,
      stroke_color: '#1e1e1e', roughness: 0,
      data: { text: 'ai-paint 演示 · Excalidraw 风格 · 多形状 / 多连接线 / 布局系统', font_size: 26, text_align: 'left' },
    }),
  )

  // ===== 2. 流程图：layered 布局 + 多形状 + 多种连接线 =====
  const nodes: LayoutNodeSpec[] = [
    { key: 'start', label: '开始', shape: 'ellipse', width: 130, height: 60, fill: '#b2f2bb' },
    { key: 'check', label: '合法?', shape: 'diamond', width: 180, height: 110, fill: '#ffd8a8' },
    { key: 'proc', label: '处理请求', shape: 'rounded-rectangle', fill: '#a5d8ff' },
    { key: 'cache', label: '缓存', shape: 'cylinder', width: 130, height: 80, fill: '#d0bfff' },
    { key: 'done', label: '完成', shape: 'ellipse', width: 130, height: 60, fill: '#b2f2bb' },
    { key: 'err', label: '报错', shape: 'note', width: 150, height: 70, fill: '#ffc9c9' },
  ]
  const edges: LayoutEdgeSpec[] = [
    { from: 'start', to: 'check' },
    { from: 'check', to: 'proc', type: 'bezier', label: '是' },
    { from: 'check', to: 'err', type: 'orthogonal', dashed: true, label: '否' },
    { from: 'proc', to: 'cache', type: 'smooth' },
    { from: 'cache', to: 'done', type: 'arc' },
  ]
  const flow = await computeLayout(nodes, edges, { kind: 'layered', padding: 60, columnGap: 100, rowGap: 60 })

  const nodeIds: Record<string, string> = {}
  for (const node of nodes) {
    const r = flow.nodes[node.key]
    if (!r) continue
    const el = createElement('shape', {
      id: id('node'), x: r.x, y: r.y, width: r.width, height: r.height,
      stroke_color: '#1e1e1e', background_color: node.fill ?? '#ffe8cc',
      fill_style: 'hachure', stroke_width: 2, roughness: 1.1,
      data: { shape: node.shape ?? 'rectangle' },
    })
    scene.elements.push(el)
    nodeIds[node.key] = el.id
    scene.elements.push(
      createElement('text', {
        id: id('label'), x: r.x, y: r.y + r.height / 2 - 11, width: r.width, height: 22,
        stroke_color: '#1e1e1e', roughness: 0,
        data: { text: node.label ?? node.key, font_size: 15, text_align: 'center' },
      }),
    )
  }

  const connNodes: Record<string, ConnectorNode> = {}
  for (const node of nodes) {
    const r = flow.nodes[node.key]
    connNodes[node.key] = { key: node.key, shape: (node.shape ?? 'rectangle') as ConnectorNode['shape'], x: r.x, y: r.y, width: r.width, height: r.height }
  }
  const bundle = routeEdgeBundle(
    connNodes,
    edges.map((e) => ({ from: e.from, to: e.to, type: e.type, dashed: e.dashed, label: e.label, arrow: 'triangle' })),
  )
  for (const e of bundle.edges) {
    scene.elements.push(
      createElement('edge', {
        id: id('edge'), x: 0, y: 0, width: 0, height: 0,
        stroke_color: '#1e1e1e', stroke_width: 2,
        data: {
          from: nodeIds[e.from], to: nodeIds[e.to],
          edge_type: e.type, dashed: e.dashed ?? false,
          label: e.label, arrow: e.arrow ?? 'triangle',
        },
      }),
    )
  }

  // ===== 3. 时序图（右侧区域） =====
  const seq = planSequenceDiagram(
    [
      { key: 'u', label: '用户' },
      { key: 's', label: '服务' },
      { key: 'db', label: '数据库', shape: 'cylinder' },
    ],
    [
      { from: 'u', to: 's', label: '登录请求' },
      { from: 's', to: 'db', label: '验证用户' },
      { from: 'db', to: 's', label: '结果' }, // 返回消息自动虚线
      { from: 's', to: 'u', label: '登录成功' }, // 返回消息自动虚线
    ],
    { title: '登录时序', padding: 40, boxWidth: 120 },
  )

  // 把时序图平移到右侧
  const seqOX = 900
  const seqOY = 160
  for (const lf of seq.participants) {
    scene.elements.push(
      createElement('line', {
        id: id('lifeline'), x: 0, y: 0, width: 0, height: 0,
        stroke_color: '#adb5bd', stroke_width: 1, stroke_style: 'dashed', dash: [4, 4],
        data: { points: [[lf.x + seqOX, lf.lineY1 + seqOY], [lf.x + seqOX, lf.lineY2 + seqOY]] },
      }),
    )
    scene.elements.push(
      createElement('shape', {
        id: id('seqbox'), x: lf.x + seqOX - 60, y: lf.boxY + seqOY, width: 120, height: lf.boxHeight,
        stroke_color: '#1e1e1e', background_color: '#d0bfff', fill_style: 'hachure', stroke_width: 2,
        data: { shape: 'rectangle' },
      }),
    )
  }
  for (const row of seq.rows) {
    scene.elements.push(
      createElement('line', {
        id: id('msg'), x: 0, y: 0, width: 0, height: 0,
        stroke_color: '#1e1e1e', stroke_width: 2,
        stroke_style: row.dashed ? 'dashed' : 'solid',
        dash: row.dashed ? [6, 5] : undefined,
        data: { points: [[row.x1 + seqOX, row.y + seqOY], [row.x2 + seqOX, row.y + seqOY]] },
      }),
    )
    scene.elements.push(
      createElement('text', {
        id: id('msglabel'), x: (row.x1 + row.x2) / 2 + seqOX, y: row.y + seqOY - 16,
        width: 200, height: 18, stroke_color: '#495057',
        data: { text: row.label, font_size: 12, text_align: 'center' },
      }),
    )
  }

  return scene
}

export function renderDemoEr(name = 'demo_er'): Scene {
  const scene = blankScene(name, 1000, 600)
  const er = planErDiagram(
    [
      { key: 'user', label: '用户表', fields: [{ name: 'id', type: 'int', key: true }, { name: 'name', type: 'varchar(64)' }, { name: 'email', type: 'varchar(128)' }] },
      { key: 'order', label: '订单表', fields: [{ name: 'id', type: 'int', key: true }, { name: 'user_id', type: 'int' }, { name: 'total', type: 'decimal' }] },
      { key: 'product', label: '商品表', fields: [{ name: 'id', type: 'int', key: true }, { name: 'title', type: 'varchar(128)' }] },
    ],
    [
      { from: 'user', to: 'order', fromCard: '1', toCard: 'N', label: '拥有' },
      { from: 'order', to: 'product', fromCard: 'N', toCard: '1', label: '包含' },
    ],
  )
  scene.width = er.width
  scene.height = er.height

  // 实体 key → 可连接 shape 元素 id（供 edge 引用）
  const entityIds: Record<string, string> = {}

  for (const ent of ['user', 'order', 'product']) {
    const r = er.entities[ent]
    if (!r) continue
    const fill = ent === 'user' ? '#a5d8ff' : ent === 'order' ? '#ffd8a8' : '#b2f2bb'
    const headerId = id('er_header')
    entityIds[ent] = headerId
    scene.elements.push(
      createElement('shape', {
        id: headerId, x: r.x, y: r.y, width: r.width, height: 40,
        stroke_color: '#1e1e1e', background_color: fill, fill_style: 'hachure', stroke_width: 2,
        data: { shape: 'rectangle' },
      }),
      createElement('text', {
        id: id('er_title'), x: r.x, y: r.y + 10, width: r.width, height: 22,
        stroke_color: '#1e1e1e',
        data: { text: ent, font_size: 15, text_align: 'center' },
      }),
      createElement('shape', {
        id: id('er_body'), x: r.x, y: r.y + 40, width: r.width, height: r.height - 40,
        stroke_color: '#1e1e1e', background_color: '#ffffff', fill_style: 'none', stroke_width: 2,
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
        id: id('er_rel'), x: 0, y: 0, width: 0, height: 0,
        stroke_color: '#1e1e1e', stroke_width: 2,
        data: { from: fromId, to: toId, edge_type: rel.type, arrow: 'none', label: rel.label },
      }),
    )
  }
  return scene
}
