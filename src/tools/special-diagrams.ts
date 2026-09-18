/**
 * 特殊图表工具：时序图 / ER 图。
 * 绘制逻辑复用 tools/draw.ts（drawSequenceScene / drawErScene）。
 */

import { centerScene } from '../core/fit.js'
import type { SceneStore } from '../mcp/store.js'
import type { ToolRegistry } from './registry.js'
import { bool, str } from './validators.js'
import { drawSequenceScene, drawErScene } from './draw.js'
import type { SeqParticipant, SeqMessage } from '../core/sequence.js'
import type { ErEntity, ErRelation } from '../core/er.js'

export function registerSpecialDiagrams(reg: ToolRegistry, store: SceneStore): void {
  // ---- create_sequence_diagram ----
  reg.register({
    name: 'create_sequence_diagram',
    description:
      '创建时序图（sequence diagram）：参与者在顶部水平排开，消息在参与者之间往返，支持实线/虚线（返回）、自消息。自动计算布局并绘制。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '场景名（不存在则创建）。' },
        participants: {
          type: 'array',
          description: '[{ key, label, shape? (rectangle|actor|cylinder), fill? }]',
        },
        messages: {
          type: 'array',
          description: '[{ from, to, label, dashed? (返回消息), self? (自消息) }]',
        },
        title: { type: 'string', description: '图标题（可选）。' },
        clear_existing: { type: 'boolean', description: '先清空场景。默认 false。' },
      },
      required: ['scene', 'participants', 'messages'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sceneName = str(args.scene, 'default')
      const participants: SeqParticipant[] = (args.participants as unknown[]).map((p, i) => {
        const o = (p ?? {}) as Record<string, unknown>
        return {
          key: str(o.key) || `p${i}`,
          label: str(o.label) || str(o.key) || `P${i + 1}`,
          shape: (str(o.shape) as 'rectangle' | 'actor' | 'cylinder') || 'rectangle',
          fill: str(o.fill) || undefined,
        }
      })
      const messages: SeqMessage[] = (args.messages as unknown[]).map((m) => {
        const o = (m ?? {}) as Record<string, unknown>
        return {
          from: str(o.from),
          to: str(o.to),
          label: str(o.label),
          dashed: bool(o.dashed, false),
          self: bool(o.self, false),
        }
      })

      const scene = store.getOrCreate(sceneName)
      if (bool(args.clear_existing, false)) scene.elements = []
      scene.paper = true

      drawSequenceScene(scene, participants, messages, { title: str(args.title) || undefined })

      centerScene(scene, { padding: 60 })
      store.update(scene)
      return { scene: scene.name, elementCount: scene.elements.length, width: scene.width, height: scene.height }
    },
  })

  // ---- create_er_diagram ----
  reg.register({
    name: 'create_er_diagram',
    description:
      '创建 ER 实体关系图：实体（表）网格排布，关系连线自动路由到实体边缘，支持基数标注（1:1 / 1:N / N:M）。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '场景名（不存在则创建）。' },
        entities: {
          type: 'array',
          description: '[{ key, label, fields: [{ name, type?, key? }], fill?, width?, height? }]',
        },
        relations: {
          type: 'array',
          description: '[{ from, to, fromCard?, toCard?, label?, type? (straight/orthogonal/bezier) }]',
        },
        clear_existing: { type: 'boolean' },
      },
      required: ['scene', 'entities', 'relations'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sceneName = str(args.scene, 'default')
      const entities: ErEntity[] = (args.entities as unknown[]).map((e, i) => {
        const o = (e ?? {}) as Record<string, unknown>
        const fields = Array.isArray(o.fields)
          ? o.fields.map((f) => {
              const fo = (f ?? {}) as Record<string, unknown>
              return { name: str(fo.name), type: str(fo.type) || undefined, key: bool(fo.key, false) }
            })
          : []
        return {
          key: str(o.key) || `e${i}`,
          label: str(o.label) || str(o.key) || `E${i + 1}`,
          fields,
          fill: str(o.fill) || undefined,
        }
      })
      const relations: ErRelation[] = (args.relations as unknown[]).map((r) => {
        const o = (r ?? {}) as Record<string, unknown>
        return {
          from: str(o.from),
          to: str(o.to),
          fromCard: str(o.fromCard) || undefined,
          toCard: str(o.toCard) || undefined,
          label: str(o.label) || undefined,
          type: (str(o.type) as 'straight' | 'orthogonal' | 'bezier') || 'straight',
        }
      })

      const scene = store.getOrCreate(sceneName)
      if (bool(args.clear_existing, false)) scene.elements = []

      drawErScene(scene, entities, relations)

      centerScene(scene, { padding: 60 })
      store.update(scene)
      return { scene: scene.name, elementCount: scene.elements.length, width: scene.width, height: scene.height }
    },
  })
}
