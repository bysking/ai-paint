/**
 * 高层图表工具（perf.md 流程的兼容入口）：
 *   - plan_flow_layout      布局预演（只算坐标 + 缓存）
 *   - create_flow_diagram   一次规划+绘制流程/有向图
 *
 * 两者都走 core/plan 统一管线（normalize → antv 布局 → 环/碰撞/位置后处理 → 缓存），
 * 与 create_diagram（pipeline-tools）共用同一实现。
 */

import { planDiagram, type FinalPlan } from '../core/plan.js'
import type { ShapeType } from '../core/shapes.js'
import { SHAPE_TYPES } from '../core/shapes.js'
import type { LayoutKind, LayoutOptions } from '../core/layout.js'
import { fitSceneContent } from '../core/fit.js'
import type { SceneStore } from '../mcp/store.js'
import type { ToolRegistry } from './registry.js'
import { bool, clampNum, intNum, str } from './validators.js'
import { drawFlowScene } from './draw.js'

/** 把旧式 nodes（key/label/shape）转成 perf.md 契约（name/description/type）。 */
function nodesToPlan(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.map((n) => {
    const o = (n ?? {}) as Record<string, unknown>
    // 新契约原样透传（已有 name）
    if (typeof o.name === 'string' && o.name) return n
    return {
      name: str(o.key, str(o.label, '')),
      description: typeof o.label === 'string' && o.label && str(o.key) !== o.label ? o.label : undefined,
      type: str(o.shape) || undefined,
      width: typeof o.width === 'number' ? o.width : undefined,
      height: typeof o.height === 'number' ? o.height : undefined,
      fill: typeof o.fill === 'string' ? o.fill : undefined,
    }
  })
}

/** 把旧式 edges（from/to）转成 perf.md 契约（source/target）。 */
function edgesToPlan(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw
  return raw.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>
    // 新契约原样透传（已有 source/target）
    if (typeof o.source === 'string' && o.source) return e
    return {
      source: str(o.from),
      target: str(o.to),
      label: typeof o.label === 'string' ? o.label : undefined,
      type: typeof o.type === 'string' ? o.type : undefined,
      dashed: o.dashed === true,
    }
  })
}

function layoutOptsFromArgs(args: Record<string, unknown>): LayoutOptions & { kind?: LayoutKind; name?: string } {
  return {
    kind: (str(args.kind, 'layered') as LayoutKind) || 'layered',
    columnGap: intNum(args.column_gap, 'column_gap', 10, 1000, 80),
    rowGap: intNum(args.row_gap, 'row_gap', 10, 1000, 50),
    padding: intNum(args.padding, 'padding', 0, 2000, 60),
    orthogonal: bool(args.orthogonal, true),
    direction: str(args.direction, 'TB') === 'LR' ? 'LR' : 'TB',
  }
}

export function registerDiagramTools(reg: ToolRegistry, store: SceneStore): void {
  // ---- plan_flow_layout ----
  reg.register({
    name: 'plan_flow_layout',
    description:
      '布局预演：计算节点坐标与连接线路径（不绘制）。支持 kind=layered|tree|grid|circular 四种布局。传入相同的 nodes/edges 给 create_flow_diagram 即可绘制。节点用 perf.md 契约 [{name, type?, width?, height?}]，边 [{source, target}]。',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '[{ name, description?, type? (形状), width?, height?, fill? }] — 也兼容旧式 { key, label, shape }',
        },
        edges: {
          type: 'array',
          description: '[{ source, target, label?, type? (straight/orthogonal/bezier/smooth/arc), dashed? }] — 也兼容旧式 { from, to }',
        },
        kind: { type: 'string', enum: ['layered', 'tree', 'grid', 'circular'], description: '布局类型。默认 layered。' },
        column_gap: { type: 'number', description: '列间距。默认 80。' },
        row_gap: { type: 'number', description: '行间距。默认 50。' },
        padding: { type: 'number', description: '外边距。默认 60。' },
        orthogonal: { type: 'boolean', description: '正交走线。默认 true。' },
        direction: { type: 'string', enum: ['TB', 'LR'], description: '布局方向。默认 TB。' },
      },
      required: ['nodes', 'edges'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const nodes = nodesToPlan(args.nodes)
      const edges = edgesToPlan(args.edges)
      const { plan } = await planDiagram(nodes, edges, layoutOptsFromArgs(args))
      return {
        planned: true,
        kind: plan.kind,
        direction: plan.direction,
        sceneWidth: plan.sceneWidth,
        sceneHeight: plan.sceneHeight,
        nodes: plan.nodes,
        fingerprint: plan.fingerprint,
        collisionFixes: plan.collisionFixes,
        removedSelfLoops: plan.removedSelfLoops,
      }
    },
  })

  // ---- create_flow_diagram ----
  reg.register({
    name: 'create_flow_diagram',
    description:
      '一次调用完成流程图/有向图：按布局（layered/tree/grid/circular）规划坐标 → 绘制全部节点 + 连接线 + 标签。节点用 perf.md 契约 [{name, description?, type?, width?, height?, fill?}]，边 [{source, target, label?, type?, dashed?}]（也兼容旧式 {key,label,shape}/{from,to}）。返回所有元素 id 与坐标，便于后续按 id 微调。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '场景名（不存在则创建）。' },
        nodes: {
          type: 'array',
          description: '[{ name, description?, type?, width?, height?, fill? }] — type 支持 rectangle/rounded-rectangle/ellipse/diamond/triangle/cylinder/parallelogram/trapezoid/note/star/hexagon/pentagon/arrow-right/arrow-left/double-arrow/actor/interface/document/cloud/cross/heart',
        },
        edges: {
          type: 'array',
          description: '[{ source, target, label?, type? (straight/orthogonal/bezier/smooth/arc), dashed? }]',
        },
        kind: { type: 'string', enum: ['layered', 'tree', 'grid', 'circular'], description: '布局类型。默认 layered。' },
        column_gap: { type: 'number' },
        row_gap: { type: 'number' },
        padding: { type: 'number' },
        orthogonal: { type: 'boolean' },
        direction: { type: 'string', enum: ['TB', 'LR'] },
        stroke_width: { type: 'number', description: '描边粗细 1|2|4。默认 2。' },
        roughness: { type: 'number', description: '手绘抖动 0..2。默认 1。' },
        label_stroke_color: { type: 'string', description: '节点文字描边色。默认 "#ffffff" 白描边；传 "none" 关闭。' },
        clear_existing: { type: 'boolean', description: '先清空场景。默认 false。' },
      },
      required: ['scene', 'nodes', 'edges'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sceneName = str(args.scene, 'default')
      const nodes = nodesToPlan(args.nodes)
      const edges = edgesToPlan(args.edges)
      const { plan } = await planDiagram(nodes, edges, {
        ...layoutOptsFromArgs(args),
        name: sceneName,
      })
      const scene = store.getOrCreate(sceneName)
      if (bool(args.clear_existing, false)) scene.elements = []
      scene.width = Math.max(scene.width, plan.sceneWidth)
      scene.height = Math.max(scene.height, plan.sceneHeight)

      const strokeWidth = intNum(args.stroke_width, 'stroke_width', 1, 8, 2)
      const roughness = clampNum(args.roughness, 'roughness', 0, 2, 1)
      const labelStroke = str(args.label_stroke_color, '#ffffff')

      const { nodeIds, shapes } = drawFlowScene(scene, plan, {
        strokeWidth,
        roughness,
        labelStrokeColor: labelStroke,
      })

      // 内容居中
      const { width, height, dx, dy } = fitSceneContent(scene, { padding: 60 })
      scene.width = width
      scene.height = height

      store.update(scene)
      return {
        scene: scene.name,
        elementCount: scene.elements.length,
        sceneWidth: scene.width,
        sceneHeight: scene.height,
        layoutKind: plan.kind,
        fingerprint: plan.fingerprint,
        collisionFixes: plan.collisionFixes,
        removedSelfLoops: plan.removedSelfLoops,
        nodes: Object.fromEntries(
          Object.entries(nodeIds).map(([k, id]) => [
            k,
            {
              id,
              ...plan.nodes[k],
              x: plan.nodes[k].x + dx,
              y: plan.nodes[k].y + dy,
            },
          ]),
        ),
      }
    },
  })
}
