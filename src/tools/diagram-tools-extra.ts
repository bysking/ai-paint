import { createElement } from '../core/scene.js'
import { SHAPE_TYPES, type ShapeType } from '../core/shapes.js'
import { routeEdge, type ConnectorNode, type EdgeType } from '../core/connectors.js'
import type { SceneStore } from '../mcp/store.js'
import type { ToolRegistry } from './registry.js'
import { bool, clampNum, color, intNum, str } from './validators.js'
import { makeId } from './element-tools.js'

const EDGE_TYPES: EdgeType[] = ['straight', 'orthogonal', 'bezier', 'smooth', 'arc']

/** 构建场景内节点索引（shape/rectangle/ellipse/diamond → ConnectorNode）。 */
function nodeIndex(scene: { elements: { id: string; type: string; x: number; y: number; width: number; height: number; data?: Record<string, unknown> }[] }): Map<string, ConnectorNode> {
  const m = new Map<string, ConnectorNode>()
  for (const el of scene.elements) {
    if (el.type === 'shape' || el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond') {
      const shape = el.type === 'shape' ? String(el.data?.shape ?? 'rectangle') : el.type
      m.set(el.id, { key: el.id, shape: shape as ShapeType, x: el.x, y: el.y, width: el.width, height: el.height })
    }
  }
  return m
}

export function registerExtraDiagramTools(reg: ToolRegistry, store: SceneStore): void {
  // ---- add_shape ----
  reg.register({
    name: 'add_shape',
    description:
      `添加任意形状节点到场景。shape 支持: ${SHAPE_TYPES.join(', ')}。返回元素 id（连接线用）。`,
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '场景名（不存在则创建）。' },
        id: { type: 'string', description: '可选元素 id（连接线引用用）。自动生成若省略。' },
        x: { type: 'number', description: '左上角 X。默认 0。' },
        y: { type: 'number', description: '左上角 Y。默认 0。' },
        width: { type: 'number', description: '宽。默认 160。' },
        height: { type: 'number', description: '高。默认 90。' },
        shape: {
          type: 'string',
          enum: SHAPE_TYPES,
          description: '形状类型。默认 rectangle。',
        },
        stroke_color: { type: 'string' },
        background_color: { type: 'string' },
        fill_style: { type: 'string', enum: ['hachure', 'cross-hatch', 'solid', 'none'] },
        stroke_width: { type: 'number' },
        roughness: { type: 'number' },
      },
      required: ['scene', 'shape'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene, 'default'))
      const shape = str(args.shape, 'rectangle') as ShapeType
      if (!SHAPE_TYPES.includes(shape)) {
        throw new Error(`未知形状: ${shape}（可用: ${SHAPE_TYPES.join(', ')}）`)
      }
      const el = createElement('shape', {
        id: str(args.id) || makeId('shape'),
        x: intNum(args.x, 'x', -100000, 100000, 0),
        y: intNum(args.y, 'y', -100000, 100000, 0),
        width: intNum(args.width, 'width', 10, 100000, 160),
        height: intNum(args.height, 'height', 10, 100000, 90),
        stroke_color: color(args.stroke_color, '#1e1e1e'),
        background_color: color(args.background_color, 'transparent'),
        fill_style: str(args.fill_style, 'hachure') as 'hachure' | 'cross-hatch' | 'solid' | 'none',
        stroke_width: intNum(args.stroke_width, 'stroke_width', 1, 8, 2),
        roughness: clampNum(args.roughness, 'roughness', 0, 2, 1),
        data: { shape },
      })
      scene.elements.push(el)
      store.update(scene)
      return { id: el.id, type: 'shape', shape, message: `${shape} 已添加` }
    },
  })

  // ---- add_edge ----
  reg.register({
    name: 'add_edge',
    description:
      '在场景中两个已有节点（shape/rectangle/ellipse/diamond）之间添加连接线。连线类型: straight|orthogonal|bezier|smooth|arc。箭头: triangle|circle|diamond|none。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '场景名（不存在则创建）。' },
        from: { type: 'string', description: '起始节点元素 id（必填）。' },
        to: { type: 'string', description: '目标节点元素 id（必填）。' },
        edge_type: {
          type: 'string',
          enum: EDGE_TYPES,
          description: '连线类型。默认 straight。',
        },
        dashed: { type: 'boolean', description: '虚线。默认 false。' },
        label: { type: 'string', description: '连线标签（绘制在连线中点旁）。' },
        arrow: {
          type: 'string',
          enum: ['triangle', 'circle', 'diamond', 'none'],
          description: '箭头类型。默认 triangle。',
        },
        stroke_color: { type: 'string' },
        stroke_width: { type: 'number' },
      },
      required: ['scene', 'from', 'to'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene, 'default'))
      const fromId = str(args.from)
      const toId = str(args.to)
      const idx = nodeIndex(scene)
      const fromN = idx.get(fromId)
      const toN = idx.get(toId)
      if (!fromN) throw new Error(`节点 "${fromId}" 不存在或不是可连接节点`)
      if (!toN) throw new Error(`节点 "${toId}" 不存在或不是可连接节点`)

      const type = str(args.edge_type, 'straight') as EdgeType
      if (!EDGE_TYPES.includes(type)) throw new Error(`未知连线类型: ${type}`)

      const el = createElement('edge', {
        id: makeId('edge'),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        stroke_color: color(args.stroke_color, '#1e1e1e'),
        stroke_width: intNum(args.stroke_width, 'stroke_width', 1, 8, 2),
        data: {
          from: fromId,
          to: toId,
          edge_type: type,
          dashed: bool(args.dashed, false),
          label: str(args.label) || undefined,
          arrow: str(args.arrow, 'triangle'),
        },
      })
      scene.elements.push(el)
      store.update(scene)
      return { id: el.id, type: 'edge', from: fromId, to: toId, edge_type: type }
    },
  })
}
