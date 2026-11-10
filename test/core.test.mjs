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

test('正交 minBends 兜底：严格对齐的连线保持直线（不误降级成小弧）', () => {
  // 强制 minBends=1（≥3 段）时，若两锚点本来就严格对齐，正交路由会退化成
  // 2 点直线。此前的实现把它一律升级成 arc —— 在几十像素的短跨度上弧线只是
  // 一段几乎看不出弯的线，视觉上像"没接上"。实测同一张纵向流程图里有 3 条
  // 主链边被误伤。这里锁定：对齐 → 保持 2 点直线（等价于直线，只是 type 仍
  // 标为 orthogonal）；不对齐的 L 型 → 才升级 arc。
  const a = { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 200, height: 72 }
  const b = { key: 'b', shape: 'rectangle', x: 0, y: 300, width: 200, height: 72 }
  const aligned = routeEdge(a, b, { type: 'orthogonal', minBends: 1 })
  assert.equal(aligned.points.length, 2, '严格对齐的边应为 2 点直线')
  assert.ok(!aligned.pathD.includes(' A '), '对齐边不应出现弧线命令')
  // 2 点且严格共线 = 视觉上就是一条直线
  assert.ok(
    Math.abs(aligned.points[0].x - aligned.points[1].x) < 0.5 ||
      Math.abs(aligned.points[0].y - aligned.points[1].y) < 0.5,
    '2 点路径必须是水平或垂直的直线',
  )
  assert.equal(aligned.type, 'orthogonal', '类型保持 orthogonal（几何上已是直线）')

  // 水平错位、垂直也错位：minBends=1 时无法产出 ≥3 段 → 升级 arc
  const c = { key: 'c', shape: 'rectangle', x: 400, y: 300, width: 200, height: 72 }
  const skewed = routeEdge(a, c, { type: 'orthogonal', minBends: 1 })
  assert.ok(
    skewed.points.length >= 4 || skewed.type === 'arc',
    `斜向边要么给出 ≥3 段正交，要么升级 arc（实际 ${skewed.type}/${skewed.points.length} 点）`,
  )
  // 绝不允许"斜线直连"（两端点直连的 2 点非对齐路径）
  if (skewed.points.length === 2) {
    assert.ok(
      Math.abs(skewed.points[0].x - skewed.points[1].x) < 0.5 ||
        Math.abs(skewed.points[0].y - skewed.points[1].y) < 0.5,
      '2 点路径只允许出现在严格对齐时（不允许斜线直连）',
    )
  }
})

test('显式桩点（fromSide/toSide）优先于自动选边', () => {
  // ER 图是网格布局，桩点由规划器按几何就近显式指定；
  // routeEdgeBundle 必须采用它，而不是又按 TB 主方向语义改回上下边。
  const nodes = new Map([
    ['a', { key: 'a', shape: 'rectangle', x: 0, y: 0, width: 180, height: 92 }],
    ['b', { key: 'b', shape: 'rectangle', x: 0, y: 142, width: 180, height: 92 }],
  ])
  const bundle = routeEdgeBundle(nodes, [{ from: 'a', to: 'b', type: 'straight' }])
  // 未指定时按分层主方向 → 下/上
  assert.equal(bundle.edges[0].fromSide, 'bottom', '默认按主方向选底边')

  const forced = routeEdgeBundle(nodes, [
    { from: 'a', to: 'b', type: 'straight', fromSide: 'right', toSide: 'left' },
  ])
  assert.equal(forced.edges[0].fromSide, 'right', '显式 fromSide 应被采用')
  assert.equal(forced.edges[0].toSide, 'left', '显式 toSide 应被采用')
})

// ---------- 冻结路由（规划期路径 → 渲染层复用） ----------

test('ER 图：关系线默认正交，桩点按几何就近（相邻表拿到直线）', () => {
  // 两张左右并排、纵向同高的表：最优解是一条水平直线。
  // 若按分层主方向语义（TB 优先上下边），会被强行要求底边出、顶边进 → 绕成大 U 型。
  const er = planErDiagram(
    [
      { key: 'a', label: 'A', fields: [{ name: 'id' }] },
      { key: 'b', label: 'B', fields: [{ name: 'id' }] },
    ],
    [{ from: 'a', to: 'b' }],
  )
  const rel = er.relations[0]
  assert.equal(rel.type, 'orthogonal', 'ER 关系线默认正交')
  assert.equal(rel.fromSide, 'right', '右侧并排 → 从右边出')
  assert.equal(rel.toSide, 'left', '右侧并排 → 从左边进')
  assert.equal(rel.points.length, 2, '水平并排的相邻表应是 2 点直线')

  // 上下堆叠 → 竖直直线。3 个实体时网格为 2 列 2 行，c 落在 a 正下方（同列）；
  // 同列的两张表若按分层主方向以外的逻辑处理会绕行，几何就近则应拿到一条竖直线。
  const er2 = planErDiagram(
    [
      { key: 'a', label: 'A', fields: [{ name: 'id' }, { name: 'x' }, { name: 'y' }] },
      { key: 'b', label: 'B', fields: [{ name: 'id' }] },
      { key: 'c', label: 'C', fields: [{ name: 'id' }] },
    ],
    [{ from: 'a', to: 'c' }],
  )
  const rel2 = er2.relations[0]
  assert.equal(rel2.fromSide, 'bottom', '同列上下堆叠 → 从底边出')
  assert.equal(rel2.toSide, 'top', '同列上下堆叠 → 从顶边进')
  assert.equal(rel2.points.length, 2, '同列相邻表应是 2 点竖直线')
})

test('ER 图：关系线不穿过中间实体（正交避障）', () => {
  // 3 张表排成一行，测最左→最右（中间隔着一张表）
  const entities = [
    { key: 'a', label: 'A', fields: [{ name: 'id' }] },
    { key: 'b', label: 'B', fields: [{ name: 'id' }] },
    { key: 'c', label: 'C', fields: [{ name: 'id' }] },
    { key: 'd', label: 'D', fields: [{ name: 'id' }] },
  ]
  const er = planErDiagram(entities, [{ from: 'a', to: 'c' }])
  const rel = er.relations[0]
  const hits = (p, q, r) =>
    Math.min(p.x, q.x) < r.x + r.width - 2 &&
    Math.max(p.x, q.x) > r.x + 2 &&
    Math.min(p.y, q.y) < r.y + r.height - 2 &&
    Math.max(p.y, q.y) > r.y + 2
  const others = Object.entries(er.entities).filter(([k]) => k !== 'a' && k !== 'c')
  for (let i = 0; i < rel.points.length - 1; i++) {
    for (const [k, r] of others) {
      assert.ok(
        !hits(rel.points[i], rel.points[i + 1], r),
        `a→c 第 ${i} 段穿过了实体 ${k}`,
      )
    }
  }
})

test('冻结路由：框架自由时整条路径平移复用，节点单独移动则失效重算', async () => {
  const { freezeRoute, reviveRoute, translatePathD } = await import('../dist/core/route-cache.js')
  const from = { key: 'a', shape: 'rectangle', x: 100, y: 100, width: 180, height: 92 }
  const to = { key: 'b', shape: 'rectangle', x: 400, y: 300, width: 180, height: 92 }
  const routed = routeEdge(from, to, { type: 'orthogonal', obstacles: [] })
  const frozen = freezeRoute(routed, from, to)

  // 1) 整体平移（centerScene / fitSceneContent 的效果）→ 复用且路径同步平移
  const dx = 250
  const dy = -40
  const moved = { ...from, x: from.x + dx, y: from.y + dy }
  const movedTo = { ...to, x: to.x + dx, y: to.y + dy }
  const revived = reviveRoute(frozen, moved, movedTo)
  assert.ok(revived, '整体平移后应能复用冻结路由')
  assert.equal(revived.points.length, routed.points.length, '复用后路径点数不变')
  for (let i = 0; i < routed.points.length; i++) {
    assert.ok(
      Math.abs(revived.points[i].x - (routed.points[i].x + dx)) < 0.01 &&
        Math.abs(revived.points[i].y - (routed.points[i].y + dy)) < 0.01,
      `第 ${i} 个点应随整体平移（期望 ${routed.points[i].x + dx},${routed.points[i].y + dy}，实际 ${revived.points[i].x},${revived.points[i].y}）`,
    )
  }
  assert.ok(
    Math.abs(revived.arrowTip.x - (routed.arrowTip.x + dx)) < 0.01,
    '箭头尖端应随整体平移',
  )

  // 2) 只移动一端 → 冻结失效（必须重算，否则连线跟不住节点）
  const onlyFrom = reviveRoute(frozen, { ...from, x: from.x + 999 }, to)
  assert.equal(onlyFrom, null, '只移动一端应使冻结失效')

  // 3) 改变尺寸 → 冻结失效
  const resized = reviveRoute(frozen, { ...from, width: from.width + 50 }, to)
  assert.equal(resized, null, '改变节点尺寸应使冻结失效')

  // 4) 数据损坏（缺字段）→ 失效而不是崩溃
  assert.equal(reviveRoute(null, moved, movedTo), null, 'null 应返回 null')
  assert.equal(reviveRoute({}, moved, movedTo), null, '空对象应返回 null')
  assert.equal(
    reviveRoute({ ...frozen, points: [[1, 2]] }, moved, movedTo),
    null,
    '路径点不足应返回 null',
  )

  // 5) pathD 平移：曲线命令的坐标对平移，但 A 的半径必须保持原样
  const arcD = 'M 10 20 A 50 50 0 0 1 100 200'
  const shifted = translatePathD(arcD, 5, -7)
  assert.ok(shifted.includes('A 50 50'), `圆弧半径不应被平移（实际 ${shifted}）`)
  assert.ok(shifted.includes('15'), '起点 x 应平移 +5')
  assert.ok(shifted.includes('105'), '圆弧终点 x 应平移 +5')
})

test('流程图：回边冻结后仍走外侧走廊（minBends 透传未被渲染层覆盖）', async () => {
  const { planDiagram } = await import('../dist/core/plan.js')
  const { blankScene } = await import('../dist/core/scene.js')
  const { drawFlowScene } = await import('../dist/tools/draw.js')
  const { routeSceneEdges } = await import('../dist/core/render.js')

  const nodes = [
    { name: 'A', type: 'process' },
    { name: 'B', type: 'process' },
    { name: 'C', type: 'process' },
  ]
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
    { source: 'C', target: 'A', label: '回退', dashed: true }, // 回边
  ]
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered' })
  const scene = blankScene('t', plan.sceneWidth, plan.sceneHeight)
  drawFlowScene(scene, plan)

  // 渲染层必须复用规划期冻结的路径（而不是用 minBends=0 重算）
  const { routedEdges } = routeSceneEdges(scene)
  const backEl = scene.elements.find((e) => e.type === 'edge' && e.data.label === '回退')
  assert.ok(backEl.data.route, '回边应带冻结路由')
  assert.equal(backEl.data.minBends, 1, '回边应带 minBends=1')
  const backRouted = routedEdges.find((r) => r.el === backEl).routed
  assert.equal(backRouted.type, 'orthogonal', '回边应保持正交')

  // 回边必须走到所有节点包围盒的外侧走廊
  const shapes = scene.elements.filter((e) => e.type === 'shape')
  const minX = Math.min(...shapes.map((s) => s.x))
  const maxX = Math.max(...shapes.map((s) => s.x + s.width))
  assert.ok(
    backRouted.points.some((p) => p.x < minX || p.x > maxX),
    '回边应走到节点包围盒外侧的走廊',
  )
})

test('ER 实体外框为整高实体盒（关系线锚点落在真正的边框上）', async () => {
  const { blankScene } = await import('../dist/core/scene.js')
  const { drawErScene } = await import('../dist/tools/draw.js')
  const { routeSceneEdges } = await import('../dist/core/render.js')
  const { centerScene } = await import('../dist/core/fit.js')

  const scene = blankScene('er_frame')
  drawErScene(
    scene,
    [
      { key: 'u', label: 'User', fields: [{ name: 'id', key: true }, { name: 'name' }] },
      { key: 'o', label: 'Order', fields: [{ name: 'id' }] },
    ],
    [{ from: 'u', to: 'o', fromCard: '1', toCard: 'N' }],
  )
  // 外框高度必须等于实体整高（表头 40 + 字段数×26），否则渲染前的冻结校验
  // 会因节点几何不符而丢弃规划好的路径
  const header = scene.elements.find((e) => e.type === 'shape' && e.id.startsWith('er_header'))
  const body = scene.elements.find((e) => e.type === 'shape' && e.id.startsWith('er_body'))
  assert.ok(header && body, '实体应有外框与字段区')
  assert.equal(header.height, 40 + 2 * 26, '外框高度 = 整高实体盒')
  assert.ok(body.height < header.height, '字段区只是外框内的白色覆盖块')

  // 关系线两端锚点必须落在实体外框【外扩 END_GAP 处】（线端与边框之间留呼吸空间），
  // 而不是停在 40px 表头条上 —— 后者是渲染层丢弃冻结路径、重算成乱弧的根因。
  centerScene(scene, { padding: 60 })
  const { routedEdges } = routeSceneEdges(scene)
  assert.equal(routedEdges.length, 1, '应有一条关系线')
  const pts = routedEdges[0].routed.points
  const edgeEl = scene.elements.find((x) => x.type === 'edge')
  const u = scene.elements.find((e) => e.id === edgeEl.data.from)
  const o = scene.elements.find((e) => e.id === edgeEl.data.to)
  const gap = 10 // connectors.END_GAP
  const nearBorder = (p, r) =>
    Math.abs(p.x - (r.x - gap)) < 1.5 ||
    Math.abs(p.x - (r.x + r.width + gap)) < 1.5 ||
    Math.abs(p.y - (r.y - gap)) < 1.5 ||
    Math.abs(p.y - (r.y + r.height + gap)) < 1.5
  assert.ok(nearBorder(pts[0], u), `起点应贴在源实体边框外 ${gap}px（${JSON.stringify(pts[0])} vs u=${JSON.stringify({ x: u.x, y: u.y, w: u.width, h: u.height })}）`)
  assert.ok(
    nearBorder(pts[pts.length - 1], o),
    `终点应贴在目标实体边框外 ${gap}px（${JSON.stringify(pts[pts.length - 1])}）`,
  )
  // 且锚点必须落在整高外框上（y 在实体内部而不是只在外框顶端附近）
  const insideVerticalSpan = (p, r) => p.y >= r.y - gap - 1 && p.y <= r.y + r.height + gap + 1
  assert.ok(insideVerticalSpan(pts[0], u), '起点 y 应落在源实体整高范围内')
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
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ],
    { linkType: 'orthogonal' },
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

  // 路由点始终是正交折线（曲线在这些点之间绘制）
  for (const link of arch.links) {
    for (let i = 0; i < link.points.length - 1; i++) {
      const p1 = link.points[i]
      const p2 = link.points[i + 1]
      const horiz = Math.abs(p1.y - p2.y) < 1e-6
      const vert = Math.abs(p1.x - p2.x) < 1e-6
      // 允许退化点（相邻点重合）
      const same = horiz && vert
      assert.ok(horiz || vert || same, `${link.from}->${link.to} 第 ${i} 段非正交`)
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
  // 出入层框的竖直段要「内缩一个内边距」（不能与层框边框共线），
  // 因此中间点允许越出空隙边界最多 LAYER_INSET。
  const LAYER_INSET = 12
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
    const gapLo = topBottom - LAYER_INSET
    const gapHi = bottomTop + LAYER_INSET
    assert.ok(bottomTop > topBottom, '层框之间应有空隙')

    for (const link of arch.links) {
      assert.equal(link.type, linkType, `连线类型应为 ${linkType}`)
      // 首末点是模块自身的出入锚点（在层框内部，这是正确的）；
      // 其余路由点必须落在层框之间的空隙里（含内缩余量），否则曲线会拱进层框。
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
  // 默认正交：层间依赖是「竖直段 + 空隙里的水平转向段」，比曲线更清晰可追踪
  const a1 = planArchitectureDiagram(layers, [{ from: 'a', to: 'b' }])
  assert.equal(a1.links[0].type, 'orthogonal', '默认应为 orthogonal（架构图默认正交走线）')

  const a2 = planArchitectureDiagram(layers, [{ from: 'a', to: 'b' }], { linkType: 'bezier' })
  assert.equal(a2.links[0].type, 'bezier', 'linkType 应生效')

  const a0 = planArchitectureDiagram(layers, [{ from: 'a', to: 'b' }], { linkType: 'straight' })
  assert.equal(a0.links[0].type, 'straight', '可显式切到 straight')

  const aArc = planArchitectureDiagram(layers, [{ from: 'a', to: 'b' }], { linkType: 'arc' })
  assert.equal(aArc.links[0].type, 'arc', '可显式切到 arc')

  // 单条 link 的显式 type 优先于全局默认
  const a3 = planArchitectureDiagram(layers, [{ from: 'a', to: 'b', type: 'arc' }], { linkType: 'bezier' })
  assert.equal(a3.links[0].type, 'arc', '单条 type 应优先')
})

// ---------------------------------------------------------------------------
// 布局检测 / 优化闸门（绘制前）+ 导出越界守卫
// ---------------------------------------------------------------------------

test('runLayoutGate：重叠节点被推开，复检通过', async () => {
  const { planDiagram } = await import('../dist/core/plan.js')
  const { runLayoutGate } = await import('../dist/core/layout-check.js')
  // 节点尺寸远大于布局间距 → 布局后必然重叠
  const nodes = [
    { name: 'A', width: 400, height: 300 },
    { name: 'B', width: 400, height: 300 },
    { name: 'C', width: 400, height: 300 },
  ]
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
  ]
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered', columnGap: 10, rowGap: 10 })

  const gate = runLayoutGate(plan, { repair: true })
  assert.equal(gate.ok, true, '修复后应当通过（无 error 级遗留问题）')
  assert.ok(gate.repairs.length > 0, '应当记录修复动作')

  const keys = Object.keys(plan.nodes)
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = plan.nodes[keys[i]]
      const b = plan.nodes[keys[j]]
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      assert.ok(ox <= 0 || oy <= 0, `节点 ${keys[i]} 与 ${keys[j]} 修复后仍重叠`)
    }
  }
})

test('runLayoutGate：关闭时原样返回（skip 标记）', async () => {
  const { planDiagram } = await import('../dist/core/plan.js')
  const { runLayoutGate } = await import('../dist/core/layout-check.js')
  const { plan } = await planDiagram(
    [{ name: 'A' }, { name: 'B' }],
    [{ source: 'A', target: 'B' }],
    { kind: 'layered' },
  )
  const gate = runLayoutGate(plan, { enabled: false })
  assert.equal(gate.skipped, true)
  assert.equal(gate.issues.length, 0)
  assert.equal(gate.repairs.length, 0)
})

test('runLayoutGate：孤立节点被收拢到主内容一侧', async () => {
  const { planDiagram } = await import('../dist/core/plan.js')
  const { runLayoutGate } = await import('../dist/core/layout-check.js')
  const { plan } = await planDiagram(
    [{ name: 'A' }, { name: 'B' }, { name: '孤岛' }],
    [{ source: 'A', target: 'B' }],
    { kind: 'layered' },
  )
  const gate = runLayoutGate(plan, { repair: true })
  const iso = gate.issues.find((i) => i.code === 'isolated-node')
  assert.ok(iso, '应当报告孤立节点')
  assert.ok(gate.repairs.some((r) => r.includes('孤立节点')), '应当记录孤立节点收拢')
})

test('detectOverflow：画布外元素被识别，画布内元素不误报', async () => {
  const { blankScene, createElement } = await import('../dist/core/scene.js')
  const { detectOverflow, expandSceneToContent } = await import('../dist/core/fit.js')

  const scene = blankScene('of', 400, 300)
  scene.elements.push(
    createElement('shape', { id: 'inside', x: 10, y: 10, width: 100, height: 50, data: { shape: 'rectangle' } }),
  )
  let res = detectOverflow(scene)
  assert.equal(res.overflow, false, '全部在画布内时不应报告越界')

  scene.elements.push(
    createElement('shape', { id: 'outside', x: 500, y: 600, width: 100, height: 50, data: { shape: 'rectangle' } }),
  )
  res = detectOverflow(scene)
  assert.equal(res.overflow, true, '画布外元素应被识别')
  assert.ok(res.elements.includes('outside'))
  assert.ok(res.right > 0 && res.bottom > 0, `应给出右下越界量，实际 ${res.right}/${res.bottom}`)

  const ex = expandSceneToContent(scene, { padding: 20 })
  assert.equal(ex.expanded, true, '应当扩画布')
  assert.ok(scene.width >= 620 && scene.height >= 670, `扩后画布应包住内容，实际 ${scene.width}×${scene.height}`)
  assert.equal(detectOverflow(scene).overflow, false, '扩画布后不应再有越界')
})

test('renderSceneSvg：默认严格按画布，fitContent 时 viewBox 扩到内容', async () => {
  const { blankScene, createElement } = await import('../dist/core/scene.js')
  const { renderSceneSvg } = await import('../dist/core/render.js')

  const scene = blankScene('vb', 400, 300)
  scene.elements.push(
    createElement('shape', { id: 'far', x: 500, y: 600, width: 100, height: 50, data: { shape: 'rectangle' } }),
  )

  const strict = renderSceneSvg(scene)
  assert.ok(strict.includes('viewBox="0 0 400 300"'), '默认 viewBox 应严格等于画布')

  const fitted = renderSceneSvg(scene, { fitContent: true })
  const m = fitted.match(/viewBox="([^"]+)"/)
  assert.ok(m, '应有 viewBox')
  const [, , w, h] = m[1].trim().split(/\s+/).map(Number)
  assert.ok(w >= 600 && h >= 650, `fitContent 后 view 应包住远距离元素，实际 ${w}×${h}`)
  assert.ok(fitted.includes('id="far"'), '画布外元素仍应出现在 SVG 里（不被裁掉）')
})

test('画布贴合内容：不再保留 2400×1600 默认空白', async () => {
  const { planDiagram } = await import('../dist/core/plan.js')
  const { blankScene } = await import('../dist/core/scene.js')
  const { drawFlowScene } = await import('../dist/tools/draw.js')
  const { fitSceneContent } = await import('../dist/core/fit.js')

  // 10 节点纵向流程图：内容高但很窄
  const nodes = Array.from({ length: 10 }, (_, i) => ({ name: `步骤 ${i + 1}` }))
  const edges = Array.from({ length: 9 }, (_, i) => ({ source: `步骤 ${i + 1}`, target: `步骤 ${i + 2}` }))
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered', direction: 'TB' })

  const scene = blankScene('fit', 2400, 1600)
  // 模拟 create_flow_diagram 的正确做法：画布取规划尺寸
  scene.width = plan.sceneWidth
  scene.height = plan.sceneHeight
  drawFlowScene(scene, plan)
  const { width, height } = fitSceneContent(scene, { padding: 60 })

  assert.ok(width < 800, `窄流程图不应保留宽画布，实际宽 ${width}`)
  assert.ok(height > 1000, `10 节点纵向图应足够高，实际高 ${height}`)
})

// ---------------------------------------------------------------------------
// 图标题 + 边标签避让
// ---------------------------------------------------------------------------

test('drawDiagramTitle：标题进入场景并位于内容上方', async () => {
  const { blankScene, createElement } = await import('../dist/core/scene.js')
  const { drawDiagramTitle, TITLE_SPACE } = await import('../dist/tools/draw.js')
  const { fitSceneContent, contentBounds } = await import('../dist/core/fit.js')

  const scene = blankScene('t')
  scene.elements.push(
    createElement('shape', { id: 'n1', x: 0, y: 0, width: 200, height: 72, data: { shape: 'rectangle' } }),
  )
  const before = scene.elements[0].y
  assert.equal(drawDiagramTitle(scene, '我的流程图'), true)

  const title = scene.elements.find((e) => e.type === 'text')
  assert.ok(title, '应生成标题文本')
  assert.equal(title.data.text, '我的流程图')
  const shape = scene.elements.find((e) => e.id === 'n1')
  assert.equal(shape.y, before + TITLE_SPACE, '已有内容应下移让位')
  assert.ok(title.y < shape.y, '标题应在内容上方')

  fitSceneContent(scene, { padding: 60 })
  const b = contentBounds(scene)
  assert.ok(b.minY >= 0, '居中后内容不应有负坐标')
})

test('drawDiagramTitle：空标题不产生元素', async () => {
  const { blankScene } = await import('../dist/core/scene.js')
  const { drawDiagramTitle } = await import('../dist/tools/draw.js')
  const scene = blankScene('t2')
  assert.equal(drawDiagramTitle(scene, '   '), false)
  assert.equal(drawDiagramTitle(scene, undefined), false)
  assert.equal(scene.elements.length, 0)
})

test('边标签不压节点：碰撞盒按文字基线（ascent）反推', async () => {
  const { blankScene, createElement } = await import('../dist/core/scene.js')
  const { routeSceneEdges } = await import('../dist/core/render.js')

  // 两个纵向排列的节点 + 一条带标签的边。标签锚点若按「基线往下」算盒子，
  // 检测会以为下方是空白，实际字形落在基线上方、压进节点里。
  const scene = blankScene('lbl')
  scene.elements.push(
    createElement('shape', { id: 'a', x: 100, y: 100, width: 200, height: 80, data: { shape: 'rectangle' } }),
    createElement('shape', { id: 'b', x: 100, y: 400, width: 200, height: 80, data: { shape: 'rectangle' } }),
    createElement('edge', {
      id: 'e1', x: 0, y: 0, width: 0, height: 0,
      data: { from: 'a', to: 'b', edge_type: 'straight', label: '这是一个比较长的边标签' },
    }),
  )

  const { labelPlacements, nodeRects } = routeSceneEdges(scene)
  const lp = labelPlacements.get('e1')
  assert.ok(lp, '应产出标签位置')

  // 按渲染同款的字形盒（基线 y - ascent 起算）
  const FONT = 13
  const box = {
    x: lp.x,
    y: lp.y - FONT * 0.8,
    w: Math.min(160, lp.text.length * 7.5 + 12),
    h: FONT,
  }
  for (const n of nodeRects) {
    const hit = box.x < n.x + n.width && box.x + box.w > n.x && box.y < n.y + n.height && box.y + box.h > n.y
    assert.ok(!hit, `标签盒 ${JSON.stringify(box)} 不应与节点 ${JSON.stringify(n)} 重叠`)
  }
})

test('架构图：同走廊的连线水平段不共线（通道按位移窗口互斥分配）', async () => {
  const { planArchitectureDiagram } = await import('../dist/core/arch.js')

  const layers = [
    { key: 'client', label: '客户端层', modules: [{ key: 'web', label: 'Web' }, { key: 'app', label: 'App' }, { key: 'admin', label: '后台' }] },
    { key: 'gateway', label: '接入层', modules: [{ key: 'cdn', label: 'CDN' }, { key: 'lb', label: 'LB' }, { key: 'gw', label: 'GW' }, { key: 'waf', label: 'WAF' }] },
    { key: 'auth', label: '认证层', modules: [{ key: 'sso', label: 'SSO' }, { key: 'rbac', label: '权限' }, { key: 'token', label: '令牌' }] },
    { key: 'service', label: '服务层', modules: [{ key: 'user', label: '用户' }, { key: 'order', label: '订单' }, { key: 'product', label: '商品' }, { key: 'pay', label: '支付' }] },
  ]
  const links = [
    { from: 'web', to: 'cdn' }, { from: 'app', to: 'cdn' }, { from: 'admin', to: 'lb' },
    { from: 'cdn', to: 'waf' }, { from: 'waf', to: 'lb' }, { from: 'lb', to: 'gw' },
    { from: 'gw', to: 'sso' }, { from: 'sso', to: 'rbac' }, { from: 'sso', to: 'token' },
    { from: 'rbac', to: 'user' },
    { from: 'gw', to: 'user' }, { from: 'gw', to: 'order' }, { from: 'gw', to: 'product' }, { from: 'gw', to: 'pay' },
    { from: 'order', to: 'pay' },
  ]
  const arch = planArchitectureDiagram(layers, links)

  // 收集所有水平段；同 y 且 x 区间重叠 >= 8px 即视为「共线重合」
  const segs = []
  for (const l of arch.links) {
    for (let i = 0; i < l.points.length - 1; i++) {
      const a = l.points[i]
      const b = l.points[i + 1]
      if (Math.abs(a.y - b.y) > 0.5) continue
      if (Math.abs(a.x - b.x) <= 1) continue
      segs.push({ edge: `${l.from}->${l.to}`, y: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) })
    }
  }

  const conflicts = []
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (Math.abs(segs[i].y - segs[j].y) > 0.5) continue
      const ov = Math.min(segs[i].hi, segs[j].hi) - Math.max(segs[i].lo, segs[j].lo)
      if (ov >= 8) {
        conflicts.push(`y=${segs[i].y.toFixed(0)} 重叠${ov.toFixed(0)}px: ${segs[i].edge} ↔ ${segs[j].edge}`)
      }
    }
  }
  assert.deepEqual(conflicts, [], `架构图不应有共线重合的水平段：\n${conflicts.join('\n')}`)

  // 同一走廊 4 条边（gw→user/order/product/pay）必须落在 4 个不同 y 上
  const gwY = new Set(
    segs.filter((s) => s.edge.startsWith('gw->')).map((s) => Math.round(s.y)),
  )
  assert.ok(gwY.size >= 3, `gw 的多条出边应有 >=3 个不同通道 y，实际 ${[...gwY].join(',')}`)
})
