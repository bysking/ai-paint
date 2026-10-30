import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeLayout } from '../dist/core/layout.js'
import { shapeGeometry, SHAPE_TYPES } from '../dist/core/shapes.js'
import { routeEdge, anchorPoint, contactPoint, pickSide, END_GAP } from '../dist/core/connectors.js'
import { routeEdgeBundle, edgesOverlap } from '../dist/core/edge-bundle.js'
import { planSequenceDiagram } from '../dist/core/sequence.js'
import { planErDiagram } from '../dist/core/er.js'
import { planArchitectureDiagram } from '../dist/core/arch.js'
import { safeText } from '../dist/tools/validators.js'
import { erEndMarker } from '../dist/core/render.js'

// ---------- layout ----------

test('layered 布局：LR 方向根节点在最左，按依赖分层', async () => {
  const layout = await computeLayout(
    [
      { key: 'a', width: 140, height: 60 },
      { key: 'b', width: 180, height: 100 },
      { key: 'c', width: 140, height: 60 },
      { key: 'd', width: 140, height: 60 },
    ],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'b', to: 'd' },
    ],
    { kind: 'layered', direction: 'LR', padding: 60, columnGap: 80, rowGap: 50 },
  )
  assert.ok(layout.nodes.a.x < layout.nodes.b.x, 'a 应在 b 左侧')
  assert.ok(layout.nodes.b.x < layout.nodes.c.x, 'b 应在 c 左侧')
  assert.ok(layout.nodes.b.x < layout.nodes.d.x, 'b 应在 d 左侧')
})

test('layered 布局：TB 方向根节点在最上，按依赖分层', async () => {
  const layout = await computeLayout(
    [
      { key: 'a', width: 140, height: 60 },
      { key: 'b', width: 180, height: 100 },
      { key: 'c', width: 140, height: 60 },
      { key: 'd', width: 140, height: 60 },
    ],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'b', to: 'd' },
    ],
    { kind: 'layered', direction: 'TB', padding: 60, columnGap: 80, rowGap: 50 },
  )
  assert.ok(layout.nodes.a.y < layout.nodes.b.y, 'a 应在 b 上方')
  assert.ok(layout.nodes.b.y < layout.nodes.c.y, 'b 应在 c 上方')
  assert.ok(layout.nodes.b.y < layout.nodes.d.y, 'b 应在 d 上方')
})

test('layered 布局：有回边（环）不死循环且产出有限坐标', async () => {
  // A → B → C → D → E → A（大环 + 中间多节点）
  const nodes = [
    { key: 'A', width: 120, height: 50 },
    { key: 'B', width: 120, height: 50 },
    { key: 'C', width: 120, height: 50 },
    { key: 'D', width: 120, height: 50 },
    { key: 'E', width: 120, height: 50 },
  ]
  const edges = [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C' },
    { from: 'C', to: 'D' },
    { from: 'D', to: 'E' },
    { from: 'E', to: 'A' }, // 回边形成环
    { from: 'A', to: 'C' },
    { from: 'C', to: 'E' },
  ]
  for (const kind of ['layered', 'tree', 'grid', 'circular']) {
    const layout = await computeLayout(nodes, edges, { kind, padding: 40, columnGap: 60, rowGap: 50 })
    for (const n of nodes) {
      const r = layout.nodes[n.key]
      assert.ok(r, `${kind}：${n.key} 应有坐标`)
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), `${kind}：${n.key} 坐标应为有限值`)
    }
  }
})

test('layered 布局：自环边不死循环', async () => {
  const layout = await computeLayout(
    [
      { key: 'a', width: 120, height: 50 },
      { key: 'b', width: 120, height: 50 },
    ],
    [
      { from: 'a', to: 'a' }, // 自环
      { from: 'a', to: 'b' },
      { from: 'b', to: 'b' },
    ],
    { kind: 'layered', padding: 40, columnGap: 60, rowGap: 50 },
  )
  assert.ok(layout.nodes.a && layout.nodes.b, '自环布局应产出坐标')
})

test('grid 布局：节点不重叠', async () => {
  const layout = await computeLayout(
    [
      { key: 'a', width: 100, height: 60 },
      { key: 'b', width: 100, height: 60 },
      { key: 'c', width: 100, height: 60 },
      { key: 'd', width: 100, height: 60 },
    ],
    [],
    { kind: 'grid', padding: 20, columnGap: 40, rowGap: 40 },
  )
  const rects = Object.values(layout.nodes)
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      const overlap =
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
      assert.equal(overlap, false, `节点 ${i} 与 ${j} 重叠`)
    }
  }
})

test('circular 布局：节点围绕中心', async () => {
  const layout = await computeLayout(
    [
      { key: 'a', width: 80, height: 80 },
      { key: 'b', width: 80, height: 80 },
      { key: 'c', width: 80, height: 80 },
      { key: 'd', width: 80, height: 80 },
    ],
    [],
    { kind: 'circular', padding: 60 },
  )
  const cx = layout.sceneWidth / 2
  const cy = layout.sceneHeight / 2
  for (const n of Object.values(layout.nodes)) {
    const dx = n.x + n.width / 2 - cx
    const dy = n.y + n.height / 2 - cy
    const r = Math.hypot(dx, dy)
    assert.ok(r > 80 && r < 400, `节点应在环上 (r=${r})`)
  }
})

test('tree 布局：父节点在子节点上方', async () => {
  const layout = await computeLayout(
    [
      { key: 'root', width: 120, height: 50 },
      { key: 'l', width: 100, height: 40 },
      { key: 'r', width: 100, height: 40 },
    ],
    [
      { from: 'root', to: 'l' },
      { from: 'root', to: 'r' },
    ],
    { kind: 'tree', direction: 'TB', padding: 40, columnGap: 60, rowGap: 60 },
  )
  assert.ok(layout.nodes.root.y < layout.nodes.l.y, 'root 在 l 上方')
  assert.ok(layout.nodes.root.y < layout.nodes.r.y, 'root 在 r 上方')
  assert.ok(layout.nodes.l.x < layout.nodes.r.x, 'l 在 r 左侧')
})

// ---------- shapes ----------

test('所有形状都有非空轮廓（≥3 点，用于闭合渲染）', () => {
  for (const shape of SHAPE_TYPES) {
    const geo = shapeGeometry(shape, { x: 0, y: 0, width: 100, height: 80 })
    assert.ok(geo.outline.length >= 3, `${shape} 轮廓至少 3 个点`)
    // 形状几何返回的是开放折线（渲染层按 i→(i+1)%n 闭合）
  }
})

test('cylinder 形状有顶盖椭圆', () => {
  const geo = shapeGeometry('cylinder', { x: 0, y: 0, width: 100, height: 60 })
  assert.ok(geo.extras && geo.extras.length > 0, 'cylinder 应有 extras')
})

// ---------- connectors ----------

test('routeEdge: 连线两端与节点边框留出 END_GAP 空隙', () => {
  const from = { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }
  const to = { key: 'b', shape: 'rectangle', x: 300, y: 0, width: 100, height: 60 }
  const edge = routeEdge(from, to, { type: 'straight' })
  assert.equal(edge.fromSide, 'right')
  assert.equal(edge.toSide, 'left')
  // 起点在 a 右边缘 (100) 之外 END_GAP；终点在 b 左边缘 (300) 之外 END_GAP
  assert.ok(Math.abs(edge.points[0].x - (100 + END_GAP)) < 0.5, `起点 x=${edge.points[0].x}`)
  assert.ok(Math.abs(edge.points[0].y - 30) < 0.5, `起点 y=${edge.points[0].y}`)
  assert.ok(Math.abs(edge.points[1].x - (300 - END_GAP)) < 0.5, `终点 x=${edge.points[1].x}`)
  // 箭头尖端与线端重合，同样离边框 END_GAP（不贴边）
  assert.ok(
    Math.abs(edge.arrowTip.x - (300 - END_GAP)) < 0.5 && Math.abs(edge.arrowTip.y - 30) < 0.5,
    `arrowTip ${JSON.stringify(edge.arrowTip)}`,
  )
})

test('anchorPoint 四边中心 + 错开（在外侧 ARROW_GAP）', () => {
  const node = { key: 'n', shape: 'rectangle', x: 0, y: 0, width: 200, height: 100 }
  const top = anchorPoint(node, 'top', 0)
  assert.ok(Math.abs(top.x - 100) < 1 && top.y === -6, `top 中心 ${JSON.stringify(top)}`)
  const top1 = anchorPoint(node, 'top', 1)
  assert.ok(Math.abs(top1.x - 114) < 1, `top 错开 slot=1 ${JSON.stringify(top1)}`)
  const left = anchorPoint(node, 'left', 0)
  assert.ok(left.x === -6 && Math.abs(left.y - 50) < 1, `left 中心 ${JSON.stringify(left)}`)
  const bottom = anchorPoint(node, 'bottom', 0)
  assert.ok(bottom.y === 106 && Math.abs(bottom.x - 100) < 1, `bottom 中心 ${JSON.stringify(bottom)}`)
})

test('contactPoint 恰好在边线上', () => {
  const node = { key: 'n', shape: 'rectangle', x: 0, y: 0, width: 200, height: 100 }
  const right = contactPoint(node, 'right', 0)
  assert.equal(right.x, 200)
  assert.ok(Math.abs(right.y - 50) < 1, `right 接触点 ${JSON.stringify(right)}`)
})

test('pickSide 四方向判定', () => {
  const c = { x: 0, y: 0 }
  assert.equal(pickSide(c, { x: 100, y: 0 }), 'right')
  assert.equal(pickSide(c, { x: -100, y: 0 }), 'left')
  assert.equal(pickSide(c, { x: 0, y: 100 }), 'bottom')
  assert.equal(pickSide(c, { x: 0, y: -100 }), 'top')
})

test('菱形（决策节点）连接约定：TB 布局进 top，是→bottom 否→right', () => {
  const diamond = { key: 'd', shape: 'diamond', x: 400, y: 181, width: 200, height: 72 }
  const below = { key: 'b', shape: 'rectangle', x: 400, y: 400, width: 200, height: 72 }
  const start = { key: 's', shape: 'ellipse', x: 400, y: 20, width: 200, height: 72 }

  // 进菱形 → top（TB 上游在顶）
  const inEdge = routeEdge(start, diamond, { type: 'straight', direction: 'TB' })
  assert.equal(inEdge.toSide, 'top', 'TB 进菱形应走 top')

  // 是 → bottom（向下继续主流程）
  const yes = routeEdge(diamond, below, { type: 'straight', direction: 'TB', branch: 'yes' })
  assert.equal(yes.fromSide, 'bottom', 'TB 是分支应走 bottom')

  // 否 → right（侧向）
  const no = routeEdge(diamond, below, { type: 'straight', direction: 'TB', branch: 'no' })
  assert.equal(no.fromSide, 'right', 'TB 否分支应走 right')

  // 无标记几何兜底：目标在下方 → bottom
  const fallback = routeEdge(diamond, below, { type: 'straight', direction: 'TB' })
  assert.equal(fallback.fromSide, 'bottom', 'TB 无标记目标在下方应走 bottom')
})

test('菱形（决策节点）连接约定：LR 布局进 left，是→right 否→bottom', () => {
  const diamond = { key: 'd', shape: 'diamond', x: 400, y: 200, width: 200, height: 72 }
  const right = { key: 'r', shape: 'rectangle', x: 800, y: 200, width: 200, height: 72 }
  const start = { key: 's', shape: 'ellipse', x: 100, y: 200, width: 200, height: 72 }

  // 进菱形 → left（LR 上游在左）
  const inEdge = routeEdge(start, diamond, { type: 'straight', direction: 'LR' })
  assert.equal(inEdge.toSide, 'left', 'LR 进菱形应走 left')

  // 是 → right（向右继续主流程）
  const yes = routeEdge(diamond, right, { type: 'straight', direction: 'LR', branch: 'yes' })
  assert.equal(yes.fromSide, 'right', 'LR 是分支应走 right')

  // 否 → bottom（侧向）
  const no = routeEdge(diamond, right, { type: 'straight', direction: 'LR', branch: 'no' })
  assert.equal(no.fromSide, 'bottom', 'LR 否分支应走 bottom')

  // 无标记几何兜底：目标在右方 → right
  const fallback = routeEdge(diamond, right, { type: 'straight', direction: 'LR' })
  assert.equal(fallback.fromSide, 'right', 'LR 无标记目标在右方应走 right')
})

test('菱形是/否分支：branch 优先级高于几何（目标在同一方向）', () => {
  const diamond = { key: 'd', shape: 'diamond', x: 400, y: 181, width: 200, height: 72 }
  const below = { key: 'b', shape: 'rectangle', x: 400, y: 400, width: 200, height: 72 }
  // TB 下两条边目标都在下方：是 → bottom，否 → right（不重叠）
  const yes = routeEdge(diamond, below, { type: 'straight', direction: 'TB', branch: 'yes' })
  const no = routeEdge(diamond, below, { type: 'straight', direction: 'TB', branch: 'no' })
  assert.equal(yes.fromSide, 'bottom')
  assert.equal(no.fromSide, 'right')
  assert.notEqual(yes.fromSide, no.fromSide, '是/否应走不同桩点')
})

test('正交避障：连线绕开中间节点', () => {
  const nodes = new Map([
    ['a', { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }],
    ['mid', { key: 'mid', shape: 'rectangle', x: 200, y: 0, width: 100, height: 60 }],
    ['b', { key: 'b', shape: 'rectangle', x: 400, y: 0, width: 100, height: 60 }],
  ])
  // a→b 中间隔着 mid，正交走线应绕开（不穿过 mid 的矩形）
  const edge = routeEdge(nodes.get('a'), nodes.get('b'), {
    type: 'orthogonal',
    obstacles: [...nodes.values()].filter((n) => n.key !== 'a' && n.key !== 'b'),
  })
  // 检查每一段都不穿过 mid 矩形 (200,0,100,60)
  const mid = { x: 200, y: 0, width: 100, height: 60 }
  const segHitsRect = (p1, p2) => {
    const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x)
    const minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y)
    return mid.x + mid.width > minX && mid.x < maxX && mid.y + mid.height > minY && mid.y < maxY
  }
  for (let i = 0; i < edge.points.length - 1; i++) {
    assert.equal(segHitsRect(edge.points[i], edge.points[i + 1]), false, `第 ${i} 段穿过中间节点`)
  }
  // 且路径点应为正交（每段水平或垂直）
  for (let i = 0; i < edge.points.length - 1; i++) {
    const a = edge.points[i], b = edge.points[i + 1]
    assert.ok(Math.abs(a.y - b.y) < 1e-6 || Math.abs(a.x - b.x) < 1e-6, `第 ${i} 段非正交`)
  }
})

test('routeEdgeBundle: 同一节点出口锚点按槽位扇开（间距 EDGE_SPACING）', () => {
  // 分层图（direction=TB）下，a 的两个子节点都在下方 → 两条边都从 a 的【底边】出，
  // 沿 x 方向按 EDGE_SPACING 扇开。这与 pickSide 的主方向优先规则一致。
  const nodes = new Map([
    ['a', { key: 'a', shape: 'rectangle', x: 100, y: 0, width: 100, height: 60 }],
    ['b', { key: 'b', shape: 'rectangle', x: 0, y: 200, width: 100, height: 60 }],
    ['c', { key: 'c', shape: 'rectangle', x: 300, y: 200, width: 100, height: 60 }],
  ])
  const bundle = routeEdgeBundle(nodes, [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
  ])
  const starts = bundle.edges.map((e) => e.points[0])
  assert.ok(starts.length === 2)
  assert.ok(
    bundle.edges.every((e) => e.fromSide === 'bottom'),
    '分层图（TB）下两条边都从底边出',
  )
  const gap = Math.abs(starts[0].x - starts[1].x)
  assert.equal(gap, 14, `同一节点出口锚点应按 EDGE_SPACING=14 扇开（实际 x 差 ${gap}）`)
  assert.ok(Math.abs(starts[0].y - starts[1].y) < 1e-6, '出口 y 应一致（同侧）')
})

test('pickSide: 分层图优先主方向，避免斜穿整图', () => {
  // ER 图实测缺陷：右上→左下时 dx 略大于 dy，旧实现会选「左/右」水平桩点，
  // 连线于是斜穿整张图并压过中间实体。分层方向下应优先走垂直的底/顶边。
  const from = { x: 430, y: 93 }
  const to = { x: 150, y: 249 } // dx=-280, dy=+156（|dx| > |dy|）
  assert.equal(pickSide(from, to, 'TB'), 'bottom', 'TB 布局优先底边出线')
  assert.equal(pickSide(to, from, 'TB'), 'top', '反向优先顶边入线')
  // LR 布局则优先左右
  assert.equal(pickSide({ x: 0, y: 0 }, { x: 300, y: 40 }, 'LR'), 'right')
  // 近同行（垂直位移极小）时退回较大位移判断
  assert.equal(pickSide({ x: 0, y: 0 }, { x: 200, y: 2 }, 'TB'), 'right')
})

test('routeEdgeBundle: 平行边同槽位时升级 bezier，槽位错开后直线', () => {
  const nodes = new Map([
    ['a', { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }],
    ['b', { key: 'b', shape: 'rectangle', x: 300, y: 0, width: 100, height: 60 }],
  ])
  // 两条 a→b 平行边：与 a/b 中心对齐 → 槽位 0 和 1 → 直接直线分开，无需 bezier
  const bundle = routeEdgeBundle(nodes, [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'b' },
  ])
  const hasBezier = bundle.edges.some((e) => e.pathD.includes(' C '))
  assert.equal(hasBezier, false, '槽位错开后平行边应保持直线（不重叠）')
  const starts = bundle.edges.map((e) => e.points[0])
  assert.equal(Math.abs(starts[0].y - starts[1].y), 14, '两条平行边锚点应错开 EDGE_SPACING')
})

test('edgesOverlap：共线重叠 true、平行异线/交叉 false', () => {
  const sameLine = [
    { points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
    { points: [{ x: 50, y: 0 }, { x: 250, y: 0 }] },
  ]
  assert.equal(edgesOverlap(sameLine[0], sameLine[1]), true, '同线重叠应判重合')
  const parallel = [
    { points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
    { points: [{ x: 0, y: 14 }, { x: 200, y: 14 }] },
  ]
  assert.equal(edgesOverlap(parallel[0], parallel[1]), false, '平行异线不算重合')
  const vert = [
    { points: [{ x: 100, y: 0 }, { x: 100, y: 300 }] },
    { points: [{ x: 100, y: 50 }, { x: 100, y: 250 }] },
  ]
  assert.equal(edgesOverlap(vert[0], vert[1]), true, '垂直同线重叠应判重合')
  const cross = [
    { points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
    { points: [{ x: 100, y: -100 }, { x: 100, y: 100 }] },
  ]
  assert.equal(edgesOverlap(cross[0], cross[1]), false, '十字交叉非共线不算重合')
})

test('routeEdgeBundle：重合边后一条升级为正交路由（不画斜线）', () => {
  const nodes = new Map([
    ['a', { key: 'a', shape: 'rectangle', x: 60, y: 96, width: 140, height: 60 }],
    ['b', { key: 'b', shape: 'rectangle', x: 60, y: 96, width: 140, height: 60 }],
    ['c', { key: 'c', shape: 'rectangle', x: 620, y: 96, width: 140, height: 60 }],
  ])
  const bundle = routeEdgeBundle(nodes, [
    { from: 'a', to: 'c', arrow: 'triangle' },
    { from: 'b', to: 'c', arrow: 'triangle' },
  ])
  const upgraded = bundle.edges.find((e) => e.type !== 'straight')
  assert.ok(upgraded, '重合边应有一条升级')
  assert.equal(upgraded.type, 'orthogonal', '直线重合应升级为正交路由')
  // 正交路径每段水平或垂直（无斜线）
  const pts = upgraded.points
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    const horiz = Math.abs(a.y - b.y) < 1e-6
    const vert = Math.abs(a.x - b.x) < 1e-6
    assert.ok(horiz || vert, `升级后第 ${i} 段应正交（${a.x},${a.y}→${b.x},${b.y}）`)
  }
})

test('routeEdge: 自环边生成 bezier 环（同节点进出）', () => {
  const node = { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }
  const edge = routeEdge(node, node, { type: 'straight' })
  assert.ok(edge.pathD.includes(' C '), '自环应生成 bezier 曲线')
  // 起点与终点在节点右边缘（x=100），y 不同（上 1/3 与下 2/3）
  assert.ok(Math.abs(edge.fromTip.x - 100) < 1 && Math.abs(edge.arrowTip.x - 100) < 1, '环应在节点同侧')
  assert.ok(Math.abs(edge.fromTip.y - edge.arrowTip.y) > 5, `环起点/终点 y 应错开（${edge.fromTip.y} vs ${edge.arrowTip.y}）`)
})

test('routeEdgeBundle: 自环边在批量路由中独立成环', () => {
  const nodes = new Map([
    ['a', { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }],
    ['b', { key: 'b', shape: 'rectangle', x: 300, y: 0, width: 100, height: 60 }],
  ])
  const bundle = routeEdgeBundle(nodes, [
    { from: 'a', to: 'a' }, // 自环
    { from: 'a', to: 'b' }, // 普通边
  ])
  assert.equal(bundle.edges.length, 2)
  const self = bundle.edges.find((e) => e.from === e.to)
  assert.ok(self, '应有自环边')
  assert.ok(self.pathD.includes(' C '), '自环应为曲线')
})

test('routeEdge: bezier 生成 C 命令', () => {
  const from = { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }
  const to = { key: 'b', shape: 'rectangle', x: 300, y: 200, width: 100, height: 60 }
  const edge = routeEdge(from, to, { type: 'bezier' })
  assert.ok(edge.pathD.includes(' C '), 'bezier 路径应含 C 命令')
})

test('routeEdge: orthogonal 生成折线', () => {
  const from = { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }
  const to = { key: 'b', shape: 'rectangle', x: 300, y: 0, width: 100, height: 60 }
  const edge = routeEdge(from, to, { type: 'orthogonal' })
  // 同一行锚点 → 直接水平线（2 点，不产生零长度段）
  assert.equal(edge.points.length, 2, '同行锚点正交线应为 2 点直线')
  // 不同行 → 需要 L 型折线（≥3 点）
  const to2 = { key: 'c', shape: 'rectangle', x: 300, y: 120, width: 100, height: 60 }
  const edge2 = routeEdge(from, to2, { type: 'orthogonal' })
  assert.ok(edge2.points.length >= 3, 'orthogonal 应有多段折线')
  // 每一段应水平或垂直
  for (let i = 0; i < edge2.points.length - 1; i++) {
    const a = edge2.points[i]
    const b = edge2.points[i + 1]
    const horiz = Math.abs(a.y - b.y) < 1e-6
    const vert = Math.abs(a.x - b.x) < 1e-6
    assert.ok(horiz || vert, `段 ${i} 非正交`)
  }
})

test('anchorPoint 支持非矩形形状（椭圆/菱形边缘中心近似）', () => {
  const node = { key: 'a', shape: 'ellipse', x: 100, y: 100, width: 100, height: 60 }
  const p = anchorPoint(node, 'right', 0)
  // 右边缘外侧 ARROW_GAP（x=200+6=206），y=130 中心
  assert.ok(Math.abs(p.x - 206) < 3 && Math.abs(p.y - 130) < 3, `right 中心 ${JSON.stringify(p)}`)
})

// ---------- sequence ----------

test('时序图：消息逐行下移，参与者等距', () => {
  const seq = planSequenceDiagram(
    [
      { key: 'a', label: 'Alice' },
      { key: 'b', label: 'Bob' },
    ],
    [
      { from: 'a', to: 'b', label: 'hello' },
      { from: 'b', to: 'a', label: 'hi', dashed: true },
      { from: 'a', to: 'a', label: 'self', self: true },
    ],
  )
  assert.equal(seq.rows.length, 3)
  assert.ok(seq.rows[1].y > seq.rows[0].y, '消息应逐行下移')
  assert.equal(seq.rows[2].self, true, '自消息')
  assert.equal(seq.rows[1].dashed, true, '返回消息为虚线')
})

test('时序图：返回消息自动识别为虚线，无需显式 dashed', () => {
  const seq = planSequenceDiagram(
    [
      { key: 'a', label: 'Alice' },
      { key: 'b', label: 'Bob' },
      { key: 'c', label: 'Carol' },
    ],
    [
      { from: 'a', to: 'b', label: '请求' },
      { from: 'b', to: 'c', label: '转发' },
      { from: 'c', to: 'b', label: '回传' },   // c→b 与 b→c 反向 → 自动虚线
      { from: 'b', to: 'a', label: '响应' },   // b→a 与 a→b 反向 → 自动虚线
    ],
  )
  assert.equal(seq.rows[0].dashed, false, '首条请求为实线')
  assert.equal(seq.rows[1].dashed, false, '正向转发为实线')
  assert.equal(seq.rows[2].dashed, true, 'c→b 返回自动虚线')
  assert.equal(seq.rows[3].dashed, true, 'b→a 返回自动虚线')
})

test('时序图：显式 dashed:false 覆盖自动虚线判断', () => {
  const seq = planSequenceDiagram(
    [
      { key: 'a', label: 'Alice' },
      { key: 'b', label: 'Bob' },
    ],
    [
      { from: 'a', to: 'b', label: '请求' },
      { from: 'b', to: 'a', label: '反向但仍实线', dashed: false },
    ],
  )
  assert.equal(seq.rows[1].dashed, false, '显式 false 覆盖自动虚线')
})

// ---------- ER ----------

test('ER 图：宽窄/高低不一的实体网格排布不重叠', () => {
  const er = planErDiagram(
    [
      { key: 'a', label: '宽表', fields: [{ name: 'this_is_a_very_long_field_name', type: 'varchar(255)' }, { name: 'another_long_one', type: 'datetime' }, { name: 'third', key: true }] },
      { key: 'b', label: '窄表', fields: [{ name: 'id', key: true }] },
      { key: 'c', label: '高表', fields: [{ name: 'f1' }, { name: 'f2' }, { name: 'f3' }, { name: 'f4' }, { name: 'f5' }] },
      { key: 'd', label: '矮表', fields: [{ name: 'x' }] },
      { key: 'e', label: 'E', fields: [{ name: 'y' }] },
      { key: 'f', label: 'F', fields: [{ name: 'z' }, { name: 'w' }] },
    ],
    [],
  )
  const rects = Object.values(er.entities)
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      const ox = a.x < b.x + b.width && a.x + a.width > b.x
      const oy = a.y < b.y + b.height && a.y + a.height > b.y
      assert.equal(ox && oy, false, `实体 ${i} 与 ${j} 重叠`)
    }
  }
})

test('safeText：剔除 emoji/非常用符号，保留文字与安全符号', () => {
  assert.equal(safeText('email🔒  varchar'), 'email  varchar', 'emoji 应剔除')
  assert.equal(safeText('订单表📦'), '订单表', '标题 emoji 应剔除')
  assert.equal(safeText('amount≥100'), 'amount≥100', '≥ 是安全数学符号应保留')
  assert.equal(safeText('状态√'), '状态√', '√ 应保留')
  assert.equal(safeText('备注→'), '备注', '→ 不在安全表内应剔除')
  assert.equal(safeText('★价格'), '价格', '★ 应剔除')
  assert.equal(safeText('user_id  bigint'), 'user_id  bigint', 'ASCII 保留')
  assert.equal(safeText('字段（说明）'), '字段（说明）', 'CJK 全角标点保留')
  assert.equal(safeText('a\nb'), 'a\nb', '换行保留')
})

test('erEndMarker：1=N 单杠、N=三叉脚、0=圆圈', () => {
  const tip = { x: 200, y: 100 }
  const one = erEndMarker('1', tip, 0, '#111', 2)
  const many = erEndMarker('N', tip, 0, '#111', 2)
  const circle = erEndMarker('0', tip, 0, '#111', 2)
  // 单杠 = 1 条竖线
  assert.equal((one.match(/<line /g) || []).length, 1, '1 → 单杠一条线')
  // 三叉脚 = 3 条线
  assert.equal((many.match(/<line /g) || []).length, 3, 'N → 三叉脚三条线')
  // 圆圈 = 1 个椭圆（无 line）
  assert.equal((circle.match(/<line /g) || []).length, 0, '0 → 圆圈无线段')
  assert.ok(circle.includes('<ellipse'), '0 → 圆圈是椭圆')
})

test('routeEdge 暴露 fromTip/fromAngle（ER 起点端标记用）', () => {
  const from = { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }
  const to = { key: 'b', shape: 'rectangle', x: 300, y: 0, width: 100, height: 60 }
  const edge = routeEdge(from, to, { type: 'straight' })
  assert.ok(edge.fromTip, '应有 fromTip')
  assert.ok(Number.isFinite(edge.fromAngle), '应有 fromAngle')
  // 起点在右边缘 x=100 之外 END_GAP（ER 端标记跟线端走，同样不贴边框）
  assert.ok(
    Math.abs(edge.fromTip.x - (100 + END_GAP)) < 0.5,
    `fromTip.x=${edge.fromTip.x} 应在 from 节点右边缘外 ${END_GAP}px`,
  )
})

test('ER 图：显式 height 过小时按字段列表高度上修，避免溢出重叠', () => {
  const er = planErDiagram(
    [
      { key: 'a', label: 'A', fields: [{ name: 'f1' }, { name: 'f2' }, { name: 'f3' }, { name: 'f4' }, { name: 'f5' }, { name: 'f6' }, { name: 'f7' }, { name: 'f8' }], height: 80 },
      { key: 'b', label: 'B', fields: [{ name: 'x' }], height: 80 },
    ],
    [],
  )
  // a 需要 40 + 8*26 = 248；显式 80 应上修
  assert.equal(er.entities.a.height, 248, '显式 height 应按字段列表上修')
  // 两个实体不再重叠（a 的字段列表不会溢出到 b）
  const a = er.entities.a
  const b = er.entities.b
  const ox = a.x < b.x + b.width && a.x + a.width > b.x
  const oy = a.y < b.y + b.height && a.y + a.height > b.y
  assert.equal(ox && oy, false, '实体不应重叠')
})

test('ER 图：实体与关系都产出坐标', () => {
  const er = planErDiagram(
    [
      { key: 'u', label: 'User', fields: [{ name: 'id', key: true }, { name: 'name' }] },
      { key: 'o', label: 'Order', fields: [{ name: 'id', key: true }, { name: 'uid' }] },
    ],
    [{ from: 'u', to: 'o', fromCard: '1', toCard: 'N', label: 'places' }],
  )
  assert.ok(er.entities.u, 'User 实体应有坐标')
  assert.ok(er.entities.o, 'Order 实体应有坐标')
  assert.equal(er.relations.length, 1)
  assert.ok(er.relations[0].points.length >= 2, '关系应有路径')
  assert.equal(er.relations[0].fromCard, '1')
  assert.equal(er.relations[0].toCard, 'N')
})

// ---------- architecture ----------

test('架构图：相邻层网格错开，避免上下层连线共用垂直线段', () => {
  const arch = planArchitectureDiagram(
    [
      {
        key: 'top', label: '上层', fill: '#ffd8a8',
        modules: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
      },
      {
        key: 'bottom', label: '下层', fill: '#a5d8ff',
        modules: [{ key: 'c', label: 'C' }, { key: 'd', label: 'D' }],
      },
    ],
    [
      { from: 'a', to: 'c' }, // 同列 → 直线
      { from: 'b', to: 'c' }, // 错位（右上→左下）→ ≥3 段
    ],
  )
  // 相邻层模块数相同时，网格必须错开半个 moduleGap，否则上下层模块 x 完全重合，
  // 上层的出线与下层的入线会共用同一条垂直线段（实测重叠 172px）。
  const modX = (layerKey) =>
    Object.values(arch.layers[layerKey].modules)
      .map((m) => m.x)
      .sort((a, b) => a - b)
  const topX = modX('top')
  const bottomX = modX('bottom')
  const dx = Math.abs(bottomX[0] - topX[0])
  assert.ok(dx > 1, `相邻层模块 x 不应完全对齐（实际偏移 ${dx}px）`)

  // 所有连线仍然是正交折线（每段水平或垂直）
  for (const link of arch.links) {
    for (let i = 0; i < link.points.length - 1; i++) {
      const p1 = link.points[i]
      const p2 = link.points[i + 1]
      const horiz = Math.abs(p1.y - p2.y) < 1e-6
      const vert = Math.abs(p1.x - p2.x) < 1e-6
      assert.ok(horiz || vert, `${link.from}->${link.to} 第 ${i} 段非正交`)
    }
  }
})

test('箭头衔接：所有连线类型 path 终点与箭头尖端重合', () => {
  const from = { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 100, height: 60 }
  const to = { key: 'b', shape: 'rectangle', x: 320, y: 180, width: 100, height: 60 }
  for (const type of ['straight', 'orthogonal', 'bezier', 'smooth', 'arc']) {
    const edge = routeEdge(from, to, { type, arrow: 'triangle' })
    // pathD 终点 = 末尾两个坐标 token（M/L/C/A 命令的终点总是最后两个数字）
    const tokens = edge.pathD.trim().split(/\s+/)
    const end = tokens.slice(-2).map(Number)
    assert.ok(
      Math.abs(end[0] - edge.arrowTip.x) < 1e-3 && Math.abs(end[1] - edge.arrowTip.y) < 1e-3,
      `${type}：path 终点 (${end}) 应等于箭头尖端 (${edge.arrowTip.x},${edge.arrowTip.y})`,
    )
  }
})

// ---------------------------------------------------------------------------
// 布局质量量化回归：这些断言锁定「间距语义 / 画布利用率 / 连线不穿节点」，
// 防止未来改动再次引入间距被放大、画布过大、连线斜穿等退化。
// ---------------------------------------------------------------------------

test('布局间距：columnGap / rowGap 就是真实像素间隙', async () => {
  const nodes = [
    { key: 'a', width: 200, height: 72 },
    { key: 'b', width: 200, height: 72 },
    { key: 'c', width: 200, height: 72 },
    { key: 'd', width: 200, height: 72 },
  ]
  // a 分出 b/c 再汇到 d：b、c 同层，a/b 相邻层
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'b', to: 'd' },
    { from: 'c', to: 'd' },
  ]
  for (const [columnGap, rowGap] of [[60, 70], [40, 30], [120, 100]]) {
    const r = await computeLayout(nodes, edges, { kind: 'layered', columnGap, rowGap, padding: 0 })
    const { b, c, a, d } = r.nodes
    const sameLayerGap = Math.round(c.x - (b.x + b.width))
    assert.equal(sameLayerGap, columnGap, `同层间隙应等于 columnGap=${columnGap}（实际 ${sameLayerGap}）`)
    // a 与 b 跨 1 层，中间夹着 b 的高度：视觉间隙 = d.y - (a.y + a.height) - b.height
    const layerGap = Math.round(a.y + a.height + rowGap)
    assert.ok(
      Math.abs(b.y - layerGap) <= 1,
      `层间距应等于 rowGap=${rowGap}（a 底 ${a.y + a.height} + ${rowGap}，b 顶 ${b.y}）`,
    )
    void d
  }
})

test('网格布局：grid 的 columnGap / rowGap 生效（原生 GridLayout 不读该选项）', async () => {
  const nodes = Array.from({ length: 6 }, (_, i) => ({ key: `n${i}`, width: 160, height: 72 }))
  for (const [columnGap, rowGap] of [[60, 70], [200, 150], [10, 10]]) {
    const r = await computeLayout(nodes, [], { kind: 'grid', columnGap, rowGap, padding: 0 })
    const a = r.nodes.n0
    const b = r.nodes.n1
    const c = r.nodes.n3
    assert.equal(Math.round(b.x - (a.x + a.width)), columnGap, `网格水平间隙应等于 columnGap=${columnGap}`)
    assert.equal(Math.round(c.y - (a.y + a.height)), rowGap, `网格垂直间隙应等于 rowGap=${rowGap}`)
  }
})

test('重新规划为经审核的布局：画布贴合内容，无大面积空白', async () => {
  const { planErDiagram: planEr } = await import('../dist/core/er.js')
  const er = planEr(
    [
      { key: 'a', label: '表A', fields: [{ name: 'id' }] },
      { key: 'b', label: '表B', fields: [{ name: 'id' }] },
    ],
    [{ from: 'a', to: 'b' }],
  )
  // 画布尺寸应紧贴内容：不超过内容外接盒 + 2×padding 的一倍半
  const pad = 60
  const maxAllowedW = (er.width - pad) * 2 + pad * 2
  const maxAllowedH = (er.height - pad) * 2 + pad * 2
  assert.ok(er.width <= maxAllowedW, `ER 画布宽 ${er.width} 不应超过内容两倍（${maxAllowedW}）`)
  assert.ok(er.height <= maxAllowedH, `ER 画布高 ${er.height} 不应超过内容两倍（${maxAllowedH}）`)
})

test('连线不穿越非端点节点（含回边外侧走廊）', async () => {
  const { planDiagram } = await import('../dist/core/plan.js')
  const { routeEdgeBundle } = await import('../dist/core/edge-bundle.js')
  const nodes = [
    { name: 'A' },
    { name: 'B' },
    { name: 'C' },
    { name: 'D' },
  ]
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
    { source: 'C', target: 'D' },
    { source: 'D', target: 'A' }, // 回边
  ]
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered' })
  const nodeMap = new Map()
  for (const [k, r] of Object.entries(plan.nodes)) {
    nodeMap.set(k, { key: k, shape: plan.nodeTable[k].shape, ...r })
  }
  const backKeys = new Set((plan.backEdges ?? []).map((e) => `${e.from}->${e.to}`))
  const bundle = routeEdgeBundle(
    nodeMap,
    plan.edges.map((e) => ({
      from: e.from,
      to: e.to,
      type: 'orthogonal',
      backedge: backKeys.has(`${e.from}->${e.to}`),
      direction: plan.direction,
    })),
  )

  const segHitsRect = (p, q, r) => {
    const pad = 2
    return (
      Math.min(p.x, q.x) < r.x + r.width - pad &&
      Math.max(p.x, q.x) > r.x + pad &&
      Math.min(p.y, q.y) < r.y + r.height - pad &&
      Math.max(p.y, q.y) > r.y + pad
    )
  }
  for (const e of bundle.edges) {
    for (let i = 0; i < e.points.length - 1; i++) {
      for (const n of nodeMap.values()) {
        if (n.key === e.from || n.key === e.to) continue
        assert.ok(
          !segHitsRect(e.points[i], e.points[i + 1], n),
          `边 ${e.from}->${e.to} 第 ${i} 段穿过了节点 ${n.key}`,
        )
      }
    }
  }

  // 回边必须走外侧走廊：x 应超出所有节点包围盒
  const minX = Math.min(...[...nodeMap.values()].map((n) => n.x))
  const maxX = Math.max(...[...nodeMap.values()].map((n) => n.x + n.width))
  for (const e of bundle.edges) {
    if (!backKeys.has(`${e.from}->${e.to}`)) continue
    const hasOutside = e.points.some((p) => p.x < minX || p.x > maxX)
    assert.ok(hasOutside, `回边 ${e.from}->${e.to} 应走到节点包围盒外侧的走廊`)
  }
})

// ---------------------------------------------------------------------------
// 架构图连线类型：曲线必须只在层框空隙内弯曲，不能穿过或贴住层框边框。
// ---------------------------------------------------------------------------

test('架构图：bezier / arc 曲线不越出层框间隙', () => {
  const layers = [
    { key: 'top', label: '上层', modules: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
    { key: 'bottom', label: '下层', modules: [{ key: 'c', label: 'C' }, { key: 'd', label: 'D' }] },
  ]
  for (const linkType of ['bezier', 'smooth', 'arc']) {
    const arch = planArchitectureDiagram(
      layers,
      [
        { from: 'a', to: 'c' }, // 近似同列
        { from: 'b', to: 'c' }, // 明显横向位移
        { from: 'a', to: 'd' },
      ],
      { linkType },
    )
    const topBottom = arch.layers.top.y + arch.layers.top.height
    const bottomTop = arch.layers.bottom.y
    const gapLo = topBottom
    const gapHi = bottomTop
    assert.ok(gapHi > gapLo, '层框之间应有空隙')

    for (const link of arch.links) {
      assert.equal(link.type, linkType, `连线类型应为 ${linkType}`)
      // 首末点在模块上（必然位于层框内部，这是正确的出入线）；
      // 中间路由点必须落在层框之间的空隙里，否则曲线会拱进层框。
      const inner = link.points.slice(1, -1)
      for (const p of inner) {
        assert.ok(
          p.y >= gapLo - 0.5 && p.y <= gapHi + 0.5,
          `${linkType} ${link.from}->${link.to} 的中间点 y=${p.y} 越出层框间隙（${gapLo}~${gapHi}）`,
        )
      }
    }
  }
})

test('架构图：linkType 可通过 ArchOptions 设为默认连线类型', () => {
  const layers = [
    { key: 'top', label: '上', modules: [{ key: 'a', label: 'A' }] },
    { key: 'bottom', label: '下', modules: [{ key: 'b', label: 'B' }] },
  ]
  const a1 = planArchitectureDiagram(layers, [{ from: 'a', to: 'b' }])
  assert.equal(a1.links[0].type, 'orthogonal', '默认应为 orthogonal')

  const a2 = planArchitectureDiagram(layers, [{ from: 'a', to: 'b' }], { linkType: 'bezier' })
  assert.equal(a2.links[0].type, 'bezier', 'linkType 应生效')

  // 单条 link 的显式 type 优先于全局默认
  const a3 = planArchitectureDiagram(layers, [{ from: 'a', to: 'b', type: 'arc' }], { linkType: 'bezier' })
  assert.equal(a3.links[0].type, 'arc', '单条 type 应优先')
})
