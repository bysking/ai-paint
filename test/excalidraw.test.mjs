/**
 * Excalidraw v2 导出器测试：
 *   - shape/text/line/arrow/draw → 对应元素字段
 *   - edge → arrow + startBinding/endBinding 两端绑定 + 双向 boundElements
 *   - image → files 字典 + fileId 引用
 *   - frame → frame 元素 + children
 *   - 输出结构：type/version/appState 齐全，可 JSON 解析
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sceneToExcalidraw } from '../dist/core/excalidraw.js'
import { blankScene, createElement } from '../dist/core/scene.js'
import { planDiagram } from '../dist/core/plan.js'
import { drawFlowScene, drawSequenceScene, drawErScene, drawArchScene } from '../dist/tools/draw.js'

test('输出结构：type=excalidraw, version=2, appState/files 齐全', () => {
  const scene = blankScene('t', 800, 600)
  scene.elements.push(
    createElement('shape', {
      id: 'r1', x: 100, y: 100, width: 200, height: 80,
      stroke_color: '#1e1e1e', background_color: '#ffd8a8', fill_style: 'hachure',
      roughness: 1, data: { shape: 'rectangle' },
    }),
  )
  const doc = sceneToExcalidraw(scene)
  assert.equal(doc.type, 'excalidraw')
  assert.equal(doc.version, 2)
  assert.ok(doc.source)
  assert.ok(doc.appState && typeof doc.appState.viewBackgroundColor === 'string')
  assert.deepEqual(doc.files, {})
  assert.equal(doc.elements.length, 1)
})

test('shape → Excalidraw 元素：字段齐全、seed 确定、roundness 圆角', () => {
  const scene = blankScene('t')
  scene.elements.push(
    createElement('shape', {
      id: 'd1', x: 10, y: 20, width: 180, height: 90,
      stroke_color: '#333', background_color: '#b2f2bb', fill_style: 'cross-hatch',
      stroke_width: 2, roughness: 1.2, opacity: 90,
      data: { shape: 'diamond' },
    }),
    createElement('shape', {
      id: 'rr1', x: 0, y: 0, width: 100, height: 50,
      data: { shape: 'rounded-rectangle' },
    }),
  )
  const doc = sceneToExcalidraw(scene)
  const diamond = doc.elements.find((e) => e.id === 'd1')
  assert.equal(diamond.type, 'diamond')
  assert.equal(diamond.x, 10)
  assert.equal(diamond.y, 20)
  assert.equal(diamond.width, 180)
  assert.equal(diamond.height, 90)
  assert.equal(diamond.strokeColor, '#333')
  assert.equal(diamond.backgroundColor, '#b2f2bb')
  assert.equal(diamond.fillStyle, 'cross-hatch')
  assert.equal(diamond.strokeWidth, 2)
  assert.equal(diamond.roughness, 1.2)
  assert.equal(diamond.opacity, 90)
  assert.ok(diamond.seed >= 0 && diamond.seed < 2147483647, 'seed 应在有效范围')
  assert.ok(diamond.version === 1 && typeof diamond.versionNonce === 'number')
  assert.equal(diamond.isDeleted, false)
  assert.ok(Array.isArray(diamond.boundElements))
  // 确定性：同 id 同 seed
  const scene2 = blankScene('t2')
  scene2.elements.push(
    createElement('shape', {
      id: 'd1', x: 10, y: 20, width: 180, height: 90,
      data: { shape: 'diamond' },
    }),
  )
  assert.equal(sceneToExcalidraw(scene2).elements[0].seed, diamond.seed, '同 id seed 应确定')
  // 圆角矩形 → roundness {type:3}
  const rounded = doc.elements.find((e) => e.id === 'rr1')
  assert.deepEqual(rounded.roundness, { type: 3 }, 'rounded-rectangle 应有圆角 roundness')
})

test('text → Excalidraw text 元素：Virgil 字体、textAlign、fontSize', () => {
  const scene = blankScene('t')
  scene.elements.push(
    createElement('text', {
      id: 'txt1', x: 100, y: 200, width: 200, height: 30,
      stroke_color: '#1e1e1e',
      data: { text: '你好 Excalidraw', font_size: 22, text_align: 'center' },
    }),
  )
  const doc = sceneToExcalidraw(scene)
  const t = doc.elements.find((e) => e.id === 'txt1')
  assert.equal(t.type, 'text')
  assert.equal(t.text, '你好 Excalidraw')
  assert.equal(t.fontSize, 22)
  assert.equal(t.fontFamily, 1, 'Virgil 手写体 fontFamily=1')
  assert.equal(t.textAlign, 'center')
  assert.ok(t.baseline > 0)
  assert.ok(typeof t.originalText === 'string')
})

test('text 落在节点内 → 绑定 containerId + 节点 boundElements 加 text 引用', () => {
  const scene = blankScene('t')
  scene.elements.push(
    createElement('shape', { id: 'n1', x: 100, y: 100, width: 200, height: 80, data: { shape: 'rectangle' } }),
    // 文本中心 (200,140) 在 n1 内 → 绑定容器
    createElement('text', { id: 'l1', x: 180, y: 130, width: 40, height: 20, data: { text: '节点', font_size: 14, text_align: 'center' } }),
    // 文本中心 (500,140) 在 n1 外 → 独立文本
    createElement('text', { id: 'free', x: 490, y: 130, width: 40, height: 20, data: { text: '游离', font_size: 14 } }),
  )
  const doc = sceneToExcalidraw(scene)
  const bound = doc.elements.find((e) => e.id === 'l1')
  assert.equal(bound.containerId, 'n1', '节点内文本应绑定容器')
  assert.equal(bound.textAlign, 'center')
  assert.equal(bound.verticalAlign, 'middle')
  // text 元素中心 = 容器中心 (200,140)；width 是文字自身尺寸（非容器宽）
  const tcx = bound.x + bound.width / 2
  const tcy = bound.y + bound.height / 2
  assert.ok(Math.abs(tcx - 200) < 1 && Math.abs(tcy - 140) < 1, `容器文本应居中（中心 ${tcx},${tcy}）`)
  assert.ok(bound.width < 50, `容器文本 width 应为文字尺寸（实际 ${bound.width}）`)
  // 节点 boundElements 有 text 引用
  const node = doc.elements.find((e) => e.id === 'n1')
  assert.ok(node.boundElements.some((b) => b.id === 'l1' && b.type === 'text'), '节点应引用容器文本')
  // 节点外文本不绑定
  const free = doc.elements.find((e) => e.id === 'free')
  assert.equal(free.containerId, null, '节点外文本不应绑定')
})

test('line/arrow/draw → 相对 points 的包围盒', () => {
  const scene = blankScene('t')
  scene.elements.push(
    createElement('line', {
      id: 'l1', x: 0, y: 0, width: 0, height: 0,
      data: { points: [[100, 100], [200, 100], [200, 200]] },
    }),
    createElement('arrow', {
      id: 'a1', x: 0, y: 0, width: 0, height: 0,
      data: { points: [[0, 0], [150, 80]] },
    }),
  )
  const doc = sceneToExcalidraw(scene)
  const line = doc.elements.find((e) => e.id === 'l1')
  assert.equal(line.type, 'line')
  // 包围盒起点 = min 点
  assert.equal(line.x, 100)
  assert.equal(line.y, 100)
  assert.equal(line.width, 100)
  assert.equal(line.height, 100)
  // points 是相对包围盒的
  assert.deepEqual(line.points[0], [0, 0])
  assert.deepEqual(line.points[1], [100, 0])
  assert.deepEqual(line.points[2], [100, 100])
  assert.equal(line.startBinding, null)
  assert.equal(line.endBinding, null)

  const arrow = doc.elements.find((e) => e.id === 'a1')
  assert.equal(arrow.type, 'arrow')
  assert.equal(arrow.endArrowhead, 'arrow', 'arrow 元素应有箭头')
  assert.equal(arrow.x, 0)
  assert.equal(arrow.y, 0)
  assert.equal(arrow.width, 150)
  assert.equal(arrow.height, 80)
})

test('edge → arrow：两端绑定（startBinding+endBinding）+ 双向 boundElements', () => {
  const scene = blankScene('t')
  scene.elements.push(
    createElement('shape', {
      id: 'n1', x: 100, y: 100, width: 150, height: 60,
      data: { shape: 'rectangle' },
    }),
    createElement('shape', {
      id: 'n2', x: 400, y: 100, width: 150, height: 60,
      data: { shape: 'rectangle' },
    }),
    createElement('edge', {
      id: 'e1', x: 0, y: 0, width: 0, height: 0,
      data: { from: 'n1', to: 'n2', edge_type: 'straight', arrow: 'triangle' },
    }),
  )
  const doc = sceneToExcalidraw(scene)
  const arrow = doc.elements.find((e) => e.id === 'e1')
  assert.equal(arrow.type, 'arrow')
  assert.ok(Array.isArray(arrow.points) && arrow.points.length >= 2, 'arrow 应有路径点')
  // 官方 PointBinding 格式：{ elementId, focus, gap }，无 type 字段
  assert.deepEqual(
    { elementId: arrow.endBinding.elementId, focus: arrow.endBinding.focus, gap: arrow.endBinding.gap },
    { elementId: 'n2', focus: 0, gap: 8 },
  )
  assert.equal('type' in arrow.endBinding, false, 'endBinding 不应有 type 字段（对齐官方格式）')
  // 两端都绑定：startBinding 也指向 n1
  assert.equal(arrow.startBinding.elementId, 'n1')
  assert.equal('type' in arrow.startBinding, false, 'startBinding 不应有 type 字段')
  // 目标节点 boundElements 应回填该箭头
  const target = doc.elements.find((e) => e.id === 'n2')
  assert.ok(
    target.boundElements.some((b) => b.id === 'e1' && b.type === 'arrow'),
    '目标节点应引用该 arrow',
  )
  // 源节点也应回填（两端都绑定）
  const source = doc.elements.find((e) => e.id === 'n1')
  assert.ok(
    source.boundElements.some((b) => b.id === 'e1' && b.type === 'arrow'),
    '源节点也应引用该 arrow',
  )
  // points 是相对包围盒的（第一条路径点应在包围盒内）
  for (const [x, y] of arrow.points) {
    assert.ok(x >= -0.5 && x <= arrow.width + 0.5, `point.x ${x} 在包围盒内`)
    assert.ok(y >= -0.5 && y <= arrow.height + 0.5, `point.y ${y} 在包围盒内`)
  }
})

test('image → files 字典 + fileId 引用', () => {
  const scene = blankScene('t')
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  scene.elements.push(
    createElement('image', {
      id: 'img1', x: 50, y: 60, width: 100, height: 80,
      data: { data_url: dataUrl },
    }),
  )
  const doc = sceneToExcalidraw(scene)
  const img = doc.elements.find((e) => e.id === 'img1')
  assert.equal(img.type, 'image')
  assert.equal(img.fileId, 'img1')
  assert.equal(img.status, 'saved')
  assert.deepEqual(img.scale, [1, 1])
  assert.equal(img.crop, null)
  // files 字典
  assert.ok(doc.files['img1'], 'files 应有该图片')
  assert.equal(doc.files['img1'].mimeType, 'image/png')
  assert.equal(doc.files['img1'].dataURL, dataUrl)
  assert.ok(doc.files['img1'].createdAt > 0)
})

test('frame → frame 元素 + children 引用', () => {
  const scene = blankScene('t')
  scene.elements.push(
    createElement('frame', {
      id: 'frm1', x: 0, y: 0, width: 500, height: 300,
      data: { children: ['n1', 'txt1'] },
    }),
  )
  const doc = sceneToExcalidraw(scene)
  const f = doc.elements.find((e) => e.id === 'frm1')
  assert.equal(f.type, 'frame')
  assert.deepEqual(f.children, ['n1', 'txt1'])
  assert.equal(f.name, '')
})

test('完整流程图：drawFlowScene 后导出 excalidraw 全链路', async () => {
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
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered' })
  const scene = blankScene('flow', plan.sceneWidth, plan.sceneHeight)
  drawFlowScene(scene, plan)

  const doc = sceneToExcalidraw(scene)
  // 4 个节点 shape + 4 个 label text + 3 条 arrow（edge）
  const shapes = doc.elements.filter((e) => ['rectangle', 'ellipse', 'diamond'].includes(e.type))
  assert.equal(shapes.length, 4, `应有 4 个形状，实际 ${shapes.length}`)
  const texts = doc.elements.filter((e) => e.type === 'text')
  assert.ok(texts.length >= 4, `应有节点标签文本，实际 ${texts.length}`)
  const arrows = doc.elements.filter((e) => e.type === 'arrow')
  assert.equal(arrows.length, 3, `应有 3 条箭头，实际 ${arrows.length}`)
  // 每条 arrow 都有 endBinding
  for (const a of arrows) {
    assert.ok(a.endBinding && a.endBinding.elementId, 'arrow 应有 endBinding')
  }
  // JSON 可序列化
  const json = JSON.stringify(doc)
  assert.ok(json.includes('"type":"excalidraw"'))
  assert.ok(json.length > 1000)
})

test('非原生形状 → 回退 rectangle（保持可编辑）', () => {
  const scene = blankScene('t')
  for (const shape of ['cylinder', 'note', 'star', 'document', 'cloud', 'heart']) {
    scene.elements.push(
      createElement('shape', { id: `s_${shape}`, x: 0, y: 0, width: 100, height: 60, data: { shape } }),
    )
  }
  const doc = sceneToExcalidraw(scene)
  for (const shape of ['cylinder', 'note', 'star', 'document', 'cloud', 'heart']) {
    const el = doc.elements.find((e) => e.id === `s_${shape}`)
    assert.equal(el.type, 'rectangle', `${shape} → rectangle`)
    assert.deepEqual(el.roundness, null, `${shape} 无圆角`)
  }
  // 原生形状保留
  for (const shape of ['rectangle', 'ellipse', 'diamond']) {
    scene.elements.push(
      createElement('shape', { id: `s2_${shape}`, x: 0, y: 0, width: 100, height: 60, data: { shape } }),
    )
  }
  const doc2 = sceneToExcalidraw(scene)
  assert.equal(doc2.elements.find((e) => e.id === 's2_ellipse').type, 'ellipse')
  assert.equal(doc2.elements.find((e) => e.id === 's2_diamond').type, 'diamond')
})

test('虚线边 → strokeStyle=dashed', () => {
  const scene = blankScene('t')
  scene.elements.push(
    createElement('shape', { id: 'a', x: 0, y: 0, width: 100, height: 50, data: { shape: 'rectangle' } }),
    createElement('shape', { id: 'b', x: 300, y: 0, width: 100, height: 50, data: { shape: 'rectangle' } }),
    createElement('edge', {
      id: 'e1', x: 0, y: 0, width: 0, height: 0,
      data: { from: 'a', to: 'b', edge_type: 'straight', dashed: true, arrow: 'none' },
    }),
  )
  const doc = sceneToExcalidraw(scene)
  const arrow = doc.elements.find((e) => e.id === 'e1')
  assert.equal(arrow.strokeStyle, 'dashed', '虚线边 strokeStyle 应为 dashed')
  assert.equal(arrow.endArrowhead, null, 'arrow=none 不应有箭头')
})

test('时序图：participant box+lifeline 分组，message 绑定两端，标签绑定箭头', () => {
  const scene = blankScene('t', 1000, 800)
  drawSequenceScene(
    scene,
    [
      { key: 'u', label: '用户' },
      { key: 's', label: '服务' },
      { key: 'db', label: '数据库', shape: 'cylinder' },
    ],
    [
      { from: 'u', to: 's', label: '登录请求' },
      { from: 's', to: 'db', label: '验证用户' },
      { from: 'db', to: 's', label: '结果', dashed: true },
    ],
    { title: '登录时序' },
  )
  const doc = sceneToExcalidraw(scene)
  const boxes = doc.elements.filter((e) => ['rectangle', 'ellipse', 'diamond'].includes(e.type) && e.id.startsWith('participant_'))
  const lifelines = doc.elements.filter((e) => e.type === 'line' && e.id.startsWith('lifeline_'))
  const arrows = doc.elements.filter((e) => e.type === 'arrow' && e.id.startsWith('msg_'))
  const labels = doc.elements.filter((e) => e.type === 'text' && e.id.startsWith('msglabel_'))

  // 3 个参与者
  assert.equal(boxes.length, 3, '应有 3 个参与者 box')
  // 每个 box 与其 lifeline 分组
  for (const box of boxes) {
    assert.ok(box.groupIds.length > 0, `${box.id} 应有分组`)
  }
  const groupedLifelines = lifelines.filter((l) => l.groupIds.length > 0)
  assert.equal(groupedLifelines.length, 3, '3 条 lifeline 都应分组')
  // 每条 lifeline 与某个 box 同组
  const boxGroups = new Set(boxes.map((b) => b.groupIds[0]))
  for (const l of groupedLifelines) {
    assert.ok(boxGroups.has(l.groupIds[0]), 'lifeline 与 box 同组')
  }
  // 每条 message 箭头两端都绑定 participant
  assert.equal(arrows.length, 3, '应有 3 条 message')
  for (const a of arrows) {
    assert.ok(a.startBinding?.elementId, 'message 应有 startBinding')
    assert.ok(a.endBinding?.elementId, 'message 应有 endBinding')
  }
  // 标签绑定到箭头
  assert.equal(labels.length, 3, '应有 3 个消息标签')
  for (const l of labels) {
    assert.ok(l.containerId, '消息标签应绑定箭头')
    assert.ok(l.containerId.startsWith('msg_'), '标签 containerId 应为箭头 id')
  }
  // 激活条：每个参与者一个，且与 lifeline/box 同组
  const activations = doc.elements.filter((e) => e.id.startsWith('activation_'))
  assert.equal(activations.length, 3, '3 个参与者都应有激活条')
  for (const a of activations) {
    assert.ok(a.groupIds.length > 0, '激活条应有分组')
    assert.ok(boxGroups.has(a.groupIds[0]), '激活条与 box 同组')
  }
  // message 箭头：加入其两端 participant 的分组（横向线随两端竖直线一起移动）
  for (const a of arrows) {
    assert.ok(a.groupIds.length >= 2, 'message 应属于两端组')
    const fromP2 = doc.elements.find((e) => e.id === a.startBinding?.elementId)
    const toP2 = doc.elements.find((e) => e.id === a.endBinding?.elementId)
    const fromGid = fromP2?.groupIds[0]
    const toGid = toP2?.groupIds[0]
    assert.ok(fromGid && a.groupIds.includes(fromGid), 'message 应在起始参与者组内')
    assert.ok(toGid && a.groupIds.includes(toGid), 'message 应在目标参与者组内')
  }
})

test('架构图：module 标签绑 module，层标题绑 frame，跨层链路两端绑定', () => {
  const scene = blankScene('t', 1000, 800)
  drawArchScene(
    scene,
    [
      { key: 'fe', label: '前端层', fill: '#ffd8a8', modules: [{ key: 'web', label: 'Web' }, { key: 'app', label: 'App' }] },
      { key: 'svc', label: '服务层', fill: '#a5d8ff', modules: [{ key: 'api', label: 'API网关' }] },
    ],
    [{ from: 'web', to: 'api' }],
  )
  const doc = sceneToExcalidraw(scene)
  const frames = doc.elements.filter((e) => e.type === 'frame')
  const modules = doc.elements.filter((e) => e.type === 'rectangle' && e.id.startsWith('arch_module_'))
  const moduleLabels = doc.elements.filter((e) => e.type === 'text' && e.id.startsWith('arch_module_label_'))
  const layerTitles = doc.elements.filter((e) => e.type === 'text' && e.id.startsWith('arch_layer_title_'))
  const links = doc.elements.filter((e) => e.type === 'arrow' && e.id.startsWith('arch_link_'))

  // module 标签绑到 module（非 frame）
  for (const ml of moduleLabels) {
    assert.ok(ml.containerId.startsWith('arch_module_'), `module 标签应绑 module（实际 ${ml.containerId}）`)
  }
  // 层标题绑到 frame
  for (const lt of layerTitles) {
    assert.ok(lt.containerId.startsWith('arch_layer_'), `层标题应绑 frame（实际 ${lt.containerId}）`)
  }
  // module 的 boundElements 同时含 text + arrow
  for (const m of modules) {
    assert.ok(
      m.boundElements.some((b) => b.type === 'text'),
      `${m.id} 应有 text 引用`,
    )
  }
  // 跨层链路两端绑定 module
  for (const l of links) {
    assert.ok(l.startBinding?.elementId.startsWith('arch_module_'), 'link 应有 startBinding')
    assert.ok(l.endBinding?.elementId.startsWith('arch_module_'), 'link 应有 endBinding')
  }
  // 层标题左对齐绑到 frame 左上角
  for (const lt of layerTitles) {
    assert.equal(lt.textAlign, 'left', '层标题应左对齐')
    assert.equal(lt.verticalAlign, 'top', '层标题应顶部对齐')
    const frame = doc.elements.find((e) => e.id === lt.containerId)
    assert.ok(frame, '层标题 frame 存在')
    assert.ok(Math.abs(lt.x - frame.x) < 1 && Math.abs(lt.y - frame.y) < 1, '层标题应在 frame 左上角')
  }
  assert.ok(frames.length >= 2, '应有 2 个 layer frame')
})

test('ER 图：字段文字保留原位置自由左对齐，实体元素分组', () => {
  const scene = blankScene('t', 1200, 800)
  drawErScene(
    scene,
    [
      { key: 'user', label: '用户表', fields: [{ name: 'id', type: 'int', key: true }, { name: 'name', type: 'varchar(64)' }, { name: 'email', type: 'varchar(128)' }] },
      { key: 'order', label: '订单表', fields: [{ name: 'id', type: 'int', key: true }, { name: 'total', type: 'decimal' }] },
    ],
    [{ from: 'user', to: 'order', fromCard: '1', toCard: 'N', label: '拥有' }],
  )
  const doc = sceneToExcalidraw(scene)
  const fields = doc.elements.filter((e) => e.type === 'text' && e.id.startsWith('er_field_'))
  // 字段文字：自由（不绑定容器）、左对齐、y 位置各不相同（无堆叠）
  assert.ok(fields.length >= 5, `应有 5 个字段文字（实际 ${fields.length}）`)
  for (const f of fields) {
    assert.equal(f.containerId, null, '字段文字不应绑定容器')
    assert.equal(f.textAlign, 'left', '字段文字应左对齐')
  }
  // 同一实体内字段 y 各不相同（两个实体的首行都在 y=104 是正常的）
  for (const gid of new Set(fields.flatMap((f) => f.groupIds))) {
    const memberYs = fields.filter((f) => f.groupIds.includes(gid)).map((f) => f.y)
    assert.equal(new Set(memberYs).size, memberYs.length, '同实体内字段 y 应各不相同（无堆叠）')
  }
  // header + body 分组：每个实体一个 er_group
  const groupIds = new Set(
    doc.elements.filter((e) => e.type === 'text' && e.id.startsWith('er_field_')).flatMap((e) => e.groupIds),
  )
  assert.equal(groupIds.size, 2, '应有 2 个实体组')
  for (const gid of groupIds) {
    const members = doc.elements.filter((e) => e.groupIds.includes(gid))
    // 组内应有 header + body + 字段
    assert.ok(members.some((e) => e.id.startsWith('er_header_')), '组内应有 header')
    assert.ok(members.some((e) => e.id.startsWith('er_body_')), '组内应有 body')
    assert.ok(members.some((e) => e.id.startsWith('er_field_')), '组内应有字段文字')
  }
  // header 标题绑定 header 容器居中
  const titles = doc.elements.filter((e) => e.type === 'text' && e.id.startsWith('er_title_'))
  for (const t of titles) {
    assert.ok(t.containerId.startsWith('er_header_'), 'ER 标题应绑定 header')
  }
  // 关系基数标记自由（不绑定容器、不在实体组内）
  const cards = doc.elements.filter((e) => e.type === 'text' && e.id.startsWith('er_card_'))
  for (const c of cards) {
    assert.equal(c.containerId, null, '基数标记不应绑定容器')
    assert.equal(c.groupIds.length, 0, '基数标记不应在实体组内')
  }
  // 关系线两端绑定 header
  const rel = doc.elements.find((e) => e.type === 'arrow' && e.id.startsWith('er_rel_'))
  assert.ok(rel?.startBinding?.elementId.startsWith('er_header_'), '关系线应绑定起始 header')
  assert.ok(rel?.endBinding?.elementId.startsWith('er_header_'), '关系线应绑定目标 header')
})

test('正交回边（elbowed arrow）导出带 fixedPoint，避免 Excalidraw 剥离绑定', async () => {
  // 用带环的流程图：回边（测试→判断）是正交 3 段
  const { planDiagram } = await import('../dist/core/plan.js')
  const { drawFlowScene } = await import('../dist/tools/draw.js')
  const nodes = [
    { name: '开始', type: 'start' },
    { name: '判断', type: 'decision' },
    { name: '处理', type: 'process' },
    { name: '测试', type: 'process' },
    { name: '结束', type: 'end' },
  ]
  const edges = [
    { source: '开始', target: '判断' },
    { source: '判断', target: '处理', label: '是' },
    { source: '判断', target: '结束', label: '否', dashed: true },
    { source: '处理', target: '测试' },
    { source: '测试', target: '判断', label: '回退', dashed: true },
  ]
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered', direction: 'TB' })
  const scene = blankScene('be', plan.sceneWidth, plan.sceneHeight)
  drawFlowScene(scene, plan)

  const doc = sceneToExcalidraw(scene)
  const arrows = doc.elements.filter((e) => e.type === 'arrow')
  // 找到回边（测试→判断）
  const backArrow = arrows.find((a) => a.id === scene.elements.find((el) => el.type === 'edge' && el.data?.label === '回退')?.id)
  assert.ok(backArrow, '应找到回退边')
  // 回退边是正交 → elbowed=true，binding 必须带 fixedPoint
  assert.equal(backArrow.elbowed, true, '正交回边应 elbowed=true')
  assert.ok(backArrow.startBinding?.fixedPoint, '回边 startBinding 应带 fixedPoint')
  assert.ok(backArrow.endBinding?.fixedPoint, '回边 endBinding 应带 fixedPoint')
  // fixedPoint 是 [fx, fy] 0-1 归一化
  for (const fp of [backArrow.startBinding.fixedPoint, backArrow.endBinding.fixedPoint]) {
    assert.ok(Array.isArray(fp) && fp.length === 2, 'fixedPoint 应为 [fx, fy]')
    assert.ok(fp[0] >= 0 && fp[0] <= 1 && fp[1] >= 0 && fp[1] <= 1, 'fixedPoint 值应在 0-1')
  }
  // 两端仍绑定到对应节点
  assert.ok(backArrow.startBinding.elementId, '回边 startBinding 有目标')
  assert.ok(backArrow.endBinding.elementId, '回边 endBinding 有目标')
  // 非正交边（2 点 straight）不带 fixedPoint（正常 PointBinding）
  const straight = arrows.find((a) => a.elbowed === false)
  if (straight) {
    assert.equal(straight.startBinding?.fixedPoint, undefined, 'straight 边不应带 fixedPoint')
  }
})

test('边标签导出：带 label 的边生成绑定到 arrow 的文本（拖动跟随）', async () => {
  const { planDiagram } = await import('../dist/core/plan.js')
  const { drawFlowScene } = await import('../dist/tools/draw.js')
  const nodes = [
    { name: '开始', type: 'start' },
    { name: '判断', type: 'decision' },
    { name: '处理', type: 'process' },
  ]
  const edges = [
    { source: '开始', target: '判断' },
    { source: '判断', target: '处理', label: '是' },
  ]
  const { plan } = await planDiagram(nodes, edges, { kind: 'layered', direction: 'TB' })
  const scene = blankScene('lbl', plan.sceneWidth, plan.sceneHeight)
  drawFlowScene(scene, plan)

  const doc = sceneToExcalidraw(scene)
  // 找到带 label 的边（判断→处理，"是"）
  const labelEdges = scene.elements.filter((el) => el.type === 'edge' && el.data?.label)
  assert.ok(labelEdges.length >= 1, '应有带 label 的边')
  for (const le of labelEdges) {
    const arrow = doc.elements.find((e) => e.id === le.id)
    assert.equal(arrow.type, 'arrow')
    // arrow.boundElements 含该 label 的 text 引用
    const textBound = (arrow.boundElements ?? []).filter((b) => b.type === 'text')
    assert.ok(textBound.length >= 1, '边箭头应绑定文本')
    const labelEl = doc.elements.find((e) => e.id === textBound[0]?.id)
    assert.ok(labelEl, '文本元素存在')
    assert.equal(labelEl.type, 'text')
    assert.equal(labelEl.text, le.data.label, '文本内容 = 边标签')
    assert.equal(labelEl.containerId, le.id, '文本 containerId 绑定到箭头')
  }
  // 不带 label 的边不生成绑定文本
  const plainEdge = scene.elements.find((el) => el.type === 'edge' && !el.data?.label)
  if (plainEdge) {
    const arrow = doc.elements.find((e) => e.id === plainEdge.id)
    assert.ok(!(arrow.boundElements ?? []).some((b) => b.type === 'text'), '无 label 边不应绑定文本')
  }
})
