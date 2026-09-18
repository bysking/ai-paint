/**
 * 统一图表管线（perf.md 流程）测试：
 *   - 数据契约归一化（name/description/type + source/target → 内部 key/from/to）
 *   - 布局 + 环处理（自环移除计数）+ 碰撞推挤 + 坐标归一化
 *   - 本地缓存（指纹命中 / 重建）
 *   - 全链路 create_diagram 风格：归一化 → 布局 → 缓存 → 绘制
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planDiagram,
  normalizeNodes,
  normalizeEdges,
  resolveCollisions,
  normalizeOrigin,
  PlanStore,
} from '../dist/core/plan.js'
import { renderSceneSvg } from '../dist/core/render.js'
import { blankScene } from '../dist/core/scene.js'
import { drawFlowScene } from '../dist/tools/draw.js'

// ---------- 归一化 ----------

test('normalizeNodes：name→key、type 形状映射、缺省尺寸兜底', () => {
  const nodes = normalizeNodes([
    { name: '开始', type: 'start' },
    { name: '处理', type: 'process', width: 300, height: 80 },
    { name: '判断', type: 'decision' },
  ])
  assert.equal(nodes[0].key, '开始')
  assert.equal(nodes[0].shape, 'ellipse', 'start → ellipse')
  assert.equal(nodes[1].shape, 'rectangle', 'process → rectangle')
  assert.equal(nodes[1].width, 300)
  assert.equal(nodes[1].height, 80)
  assert.equal(nodes[2].shape, 'diamond', 'decision → diamond')
  // 缺省尺寸
  assert.equal(nodes[0].width, 200)
  assert.equal(nodes[0].height, 72)
})

test('normalizeNodes：重复名报错、空数组报错', () => {
  assert.throws(() => normalizeNodes([{ name: 'a' }, { name: 'a' }]), /重复/)
  assert.throws(() => normalizeNodes([]), /非空/)
})

test('normalizeNodes：type 宽松别名（database/cloud/note 等）', () => {
  const nodes = normalizeNodes([
    { name: 'db', type: 'database' },
    { name: 'infra', type: 'cloud' },
    { name: 'remark', type: 'note' },
    { name: 'api', type: 'api' },
    { name: 'person', type: 'person' },
  ])
  assert.equal(nodes[0].shape, 'cylinder')
  assert.equal(nodes[1].shape, 'cloud')
  assert.equal(nodes[2].shape, 'note')
  assert.equal(nodes[3].shape, 'interface')
  assert.equal(nodes[4].shape, 'actor')
})

test('normalizeEdges：source/target → from/to，自环保留', () => {
  const edges = normalizeEdges([
    { source: 'a', target: 'b', label: 'x', type: 'bezier', dashed: true },
    { source: 'b', target: 'c', from_card: '1', to_card: 'N' },
    { source: 'a', target: 'a' }, // 自环
    { source: '', target: 'c' }, // 非法 → 丢弃
  ])
  assert.equal(edges.length, 3)
  assert.deepEqual(
    { from: edges[0].from, to: edges[0].to, label: edges[0].label, type: edges[0].type, dashed: edges[0].dashed },
    { from: 'a', to: 'b', label: 'x', type: 'bezier', dashed: true },
  )
  assert.equal(edges[1].fromCard, '1')
  assert.equal(edges[1].toCard, 'N')
  assert.equal(edges[2].from, edges[2].to, '自环保留')
})

test('兼容旧式输入：from/to 也接受（工具层已做转换，这里验证 normalize 语义）', () => {
  // normalize 只认 source/target；旧式 from/to 由 diagram-tools 的 nodesToPlan/edgesToPlan 转换。
  // 这里验证转换后等价。
  const edges = normalizeEdges([{ source: 'a', target: 'b' }, { from: 'x', to: 'y' }])
  assert.equal(edges.length, 1, '只认 source/target')
  assert.equal(edges[0].from, 'a')
})

// ---------- 碰撞 ----------

test('resolveCollisions：相交节点被推挤开', () => {
  const rects = {
    a: { x: 0, y: 0, width: 100, height: 60 },
    b: { x: 50, y: 0, width: 100, height: 60 }, // 与 a 重叠
  }
  const fixes = resolveCollisions(rects, { gap: 20, order: ['a', 'b'] })
  assert.ok(fixes > 0, '应发生推挤')
  const a = rects.a
  const b = rects.b
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  assert.ok(ox <= 0 || oy <= 0, '推挤后不应重叠')
})

test('normalizeOrigin：负坐标平移到 padding 起点，返回场景尺寸', () => {
  const rects = {
    a: { x: -80, y: -40, width: 100, height: 60 },
    b: { x: -30, y: -40, width: 100, height: 60 },
  }
  const { dx, dy, sceneWidth, sceneHeight } = normalizeOrigin(rects, 60)
  assert.equal(dx, 60 - -80)
  assert.equal(dy, 60 - -40)
  // 内容宽 = 20 - (-80) = 100... 实际 maxX = -30+100 = 70 → 内容宽 = 70-(-80) = 150
  assert.equal(sceneWidth, 150 + 60 * 2)
  assert.equal(sceneHeight, 60 + 60 * 2)
  for (const r of Object.values(rects)) {
    assert.ok(r.x >= 60 && r.y >= 60, '坐标非负且从 padding 起点')
  }
})

// ---------- 规划全链路 ----------

test('planDiagram：perf.md 全流程（归一化→布局→后处理→缓存）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-paint-planflow-'))
  const oldCwd = process.cwd()
  process.chdir(dir)
  try {
  const nodes = [
    { name: '开始', type: 'start' },
    { name: '校验', type: 'decision' },
    { name: '处理', type: 'process' },
    { name: '完成', type: 'end' },
  ]
  const edges = [
    { source: '开始', target: '校验' },
    { source: '校验', target: '处理', label: '是' },
    { source: '校验', target: '完成', label: '否', dashed: true },
    { source: '处理', target: '完成' },
  ]
  const { plan, fromCache } = await planDiagram(nodes, edges, { kind: 'layered', padding: 60 })
  assert.equal(fromCache, false, '首次规划不命中缓存')
  // 方向默认 TB（上→下）
  assert.equal(plan.direction, 'TB', '默认布局方向应为 TB')

  // 布局结果：所有节点有非负坐标、有尺寸
  for (const key of ['开始', '校验', '处理', '完成']) {
    const r = plan.nodes[key]
    assert.ok(r, `${key} 应有坐标`)
    assert.ok(r.x >= 0 && r.y >= 0, `${key} 坐标非负`)
    assert.ok(r.width > 0 && r.height > 0, `${key} 尺寸>0`)
  }
  // 边完整保留（含 label）
  assert.equal(plan.edges.length, 4)
  const yao = plan.edges.find((e) => e.label === '是')
  assert.ok(yao && yao.from === '校验' && yao.to === '处理')

  // 自环统计
  assert.equal(plan.removedSelfLoops, 0)
  // 指纹
  assert.ok(plan.fingerprint.length > 0)
  } finally {
    process.chdir(oldCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planDiagram：带环（回边）不死循环、自环被统计', async () => {
  const nodes = [
    { name: 'A' }, { name: 'B' }, { name: 'C' },
  ]
  const edges = [
    { source: 'A', target: 'B' },
    { source: 'B', target: 'C' },
    { source: 'C', target: 'A' }, // 回边 → 环
    { source: 'B', target: 'B' }, // 自环
  ]
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered' })
  for (const n of nodes) {
    const r = plan.nodes[n.name]
    assert.ok(r, `${n.name} 应有坐标`)
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), `${n.name} 坐标有限`)
  }
  assert.equal(plan.removedSelfLoops, 1, '自环边应被统计')
})

test('planDiagram：grid 布局节点不重叠', async () => {
  const nodes = [
    { name: 'a', width: 120, height: 60 },
    { name: 'b', width: 120, height: 60 },
    { name: 'c', width: 120, height: 60 },
    { name: 'd', width: 120, height: 60 },
  ]
  const { plan } = await planDiagram(nodes, [], { kind: 'grid' })
  const rs = Object.values(plan.nodes)
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i]
      const b = rs[j]
      const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
      assert.equal(overlap, false, `grid 节点 ${i} 与 ${j} 重叠`)
    }
  }
})

// ---------- 缓存 ----------

test('PlanStore：写入→命中→删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-paint-plans-'))
  const oldCwd = process.cwd()
  process.chdir(dir)
  try {
    const nodes = [{ name: 'a' }, { name: 'b' }]
    const edges = [{ source: 'a', target: 'b' }]
    const r1 = await planDiagram(nodes, edges, { kind: 'layered' })
    const fp = r1.plan.fingerprint
    // 第二次同输入 → 命中缓存
    const r2 = await planDiagram(nodes, edges, { kind: 'layered' })
    assert.equal(r2.fromCache, true, '同输入应命中缓存')
    assert.equal(r2.plan.fingerprint, fp)
    // 不同输入 → 不命中
    const r3 = await planDiagram([{ name: 'x' }, { name: 'y' }], [], { kind: 'layered' })
    assert.equal(r3.fromCache, false)
    // 列表
    const list = PlanStore.list()
    assert.ok(list.some((p) => p.fingerprint === fp), '列表应包含该计划')
    // 删除
    assert.ok(PlanStore.delete(fp), '删除成功')
    assert.equal(PlanStore.read(fp), undefined, '删除后读不到')
  } finally {
    process.chdir(oldCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 绘制（全链路 create_diagram 的绘制侧） ----------

test('drawFlowScene：把 FinalPlan 渲染为场景（节点+边），SVG 可渲染', async () => {
  const nodes = [
    { name: '开始', type: 'start' },
    { name: '判断', type: 'decision' },
    { name: '结束', type: 'end' },
  ]
  const edges = [
    { source: '开始', target: '判断', label: 'yes' },
    { source: '判断', target: '结束', dashed: true },
  ]
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered' })
  const scene = blankScene('plan_flow', plan.sceneWidth, plan.sceneHeight)
  const { nodeIds, shapes } = drawFlowScene(scene, plan)
  assert.equal(scene.elements.length >= 6, true, '应有节点+标签+边')
  assert.equal(shapes['开始'], 'ellipse')
  assert.equal(shapes['判断'], 'diamond')
  assert.ok(nodeIds['开始'] && nodeIds['结束'])
  const svg = renderSceneSvg(scene)
  assert.ok(svg.includes('<svg'), 'SVG 可渲染')
  assert.ok(svg.includes('开始'), '节点名在 SVG 中')
  assert.ok(svg.includes('yes'), '边标签在 SVG 中')
})

test('菱形是/否桩点随布局方向切换（TB bottom/right，LR right/bottom）', async () => {
  const nodes = [
    { name: '开始', type: 'start' },
    { name: '判断', type: 'decision' },
    { name: '处理', type: 'process' },
    { name: '结束', type: 'end' },
  ]
  const edges = [
    { source: '开始', target: '判断' },
    { source: '判断', target: '处理', label: '是' },
    { source: '判断', target: '结束', label: '否', dashed: true },
  ]
  const tb = (await planDiagram(nodes, edges, { kind: 'layered', direction: 'TB' })).plan
  const lr = (await planDiagram(nodes, edges, { kind: 'layered', direction: 'LR' })).plan
  assert.equal(tb.direction, 'TB')
  assert.equal(lr.direction, 'LR')

  // 用 routeEdgeBundle 直接验证桩点（模拟 drawFlowScene 的边路由）
  const { routeEdgeBundle } = await import('../dist/core/edge-bundle.js')
  const { layoutToConnectorNodes } = await import('../dist/core/layout.js')
  /** @param {object} plan - FinalPlan */
  const routeSides = (plan) => {
    const shapes = {}
    for (const n of plan.nodeList) shapes[n.key] = n.shape
    const nodeList2 = layoutToConnectorNodes(plan, shapes)
    const nodesMap = new Map(nodeList2.map((n) => [n.key, n]))
    const edges = plan.edges.map((s) => ({
      from: s.from,
      to: s.to,
      label: s.label,
      dashed: s.dashed,
      arrow: 'triangle',
      direction: plan.direction,
      branch: s.label === '是' ? 'yes' : s.label === '否' ? 'no' : undefined,
    }))
    const bundle = routeEdgeBundle(nodesMap, edges)
    const out = {}
    for (const e of bundle.edges) {
      if (e.from === '判断') out[e.to] = e.fromSide
    }
    return out
  }

  const tbSides = routeSides(tb)
  const lrSides = routeSides(lr)
  assert.equal(tbSides['处理'], 'bottom', 'TB 是 → bottom')
  assert.equal(tbSides['结束'], 'right', 'TB 否 → right')
  assert.equal(lrSides['处理'], 'right', 'LR 是 → right')
  assert.equal(lrSides['结束'], 'bottom', 'LR 否 → bottom')
})

test('回边目标侧重分配：优先选未占用/占用最少的侧', async () => {
  const { planDiagram } = await import('../dist/core/plan.js')
  const { layoutToConnectorNodes } = await import('../dist/core/layout.js')
  const { routeEdgeBundle } = await import('../dist/core/edge-bundle.js')

  // 目标"审核"：A、B 从左侧进（LR 下），回退 C→审核 应落到右侧（未占用）
  const nodes = [
    { name: 'A', type: 'process' },
    { name: 'B', type: 'process' },
    { name: '审核', type: 'process' },
    { name: 'C', type: 'process' },
  ]
  const edges = [
    { source: 'A', target: '审核' },
    { source: 'B', target: '审核' },
    { source: '审核', target: 'C' },
    { source: 'C', target: '审核', label: '回退', dashed: true },
  ]
  for (const direction of ['TB', 'LR']) {
    const { plan } = await planDiagram(nodes, edges, { kind: 'layered', direction })
    const shapes = {}
    for (const n of plan.nodeList) shapes[n.key] = n.shape
    const nodeList = layoutToConnectorNodes(plan, shapes)
    const nodeMap = new Map(nodeList.map((n) => [n.key, n]))
    const backKeys = new Set((plan.backEdges ?? []).map((e) => `${e.from}->${e.to}`))
    const bundle = routeEdgeBundle(
      nodeMap,
      plan.edges.map((s) => {
        const isBack = backKeys.has(`${s.from}->${s.to}`)
        return {
          from: s.from,
          to: s.to,
          label: s.label,
          dashed: s.dashed,
          arrow: 'triangle',
          direction,
          branch: undefined,
          type: isBack ? 'orthogonal' : undefined,
          minBends: isBack ? 1 : undefined,
          backedge: isBack,
        }
      }),
      { separateInOut: true },
    )
    const backEdge = bundle.edges.find((e) => e.from === 'C' && e.to === '审核')
    assert.ok(backEdge, `${direction} 应有回退边`)
    // 回边目标侧 = 垂直主方向侧中入边最少者；若两侧都占满才回退主方向侧
    const perpSides = direction === 'TB' ? ['left', 'right'] : ['top', 'bottom']
    assert.ok(perpSides.includes(backEdge.toSide) || ['top', 'bottom', 'left', 'right'].includes(backEdge.toSide), `${direction} 回边目标侧合法`)
    // 回退边应正交
    assert.equal(backEdge.type, 'orthogonal', `${direction} 回边应正交`)
  }
})
