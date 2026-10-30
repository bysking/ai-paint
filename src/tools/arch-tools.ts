/**
 * 架构图工具：create_architecture_diagram
 * 自上而下分层布局（每层一个大框 + 标题 + 配色，层内多个子模块），
 * 跨层依赖连线默认正交路由避障。绘制复用 tools/draw.ts（drawArchScene）。
 */

import { centerScene } from '../core/fit.js'
import type { SceneStore } from '../mcp/store.js'
import type { ToolRegistry } from './registry.js'
import { bool, intNum, str } from './validators.js'
import { drawArchScene } from './draw.js'
import type { ArchOptions } from '../core/arch.js'
import type { ArchLayer, ArchLink } from '../core/arch.js'

export function registerArchTools(reg: ToolRegistry, store: SceneStore): void {
  reg.register({
    name: 'create_architecture_diagram',
    description:
      '创建架构图（architecture diagram）：按层自上而下布局，每层是一个大框（frame）带标题与配色，层内含多个子模块；跨层依赖连线默认正交路由避障。适合系统架构、分层设计、微服务拓扑等。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '场景名（不存在则创建）。' },
        layers: {
          type: 'array',
          description:
            '[{ key, label, fill?, modules: [{ key, label, fill? }] }] — 每层一个大框，modules 为层内子模块。',
        },
        links: {
          type: 'array',
          description:
            '[{ from, to, label?, type? (straight/orthogonal/bezier/smooth/arc), dashed? }] — 跨层模块依赖，默认 orthogonal。',
        },
        padding: { type: 'number', description: '外边距。默认 60。' },
        layer_gap: { type: 'number', description: '层间距。默认 70。' },
        module_gap: { type: 'number', description: '层内模块间距。默认 24。' },
        module_width: { type: 'number', description: '子模块宽。默认 170。' },
        module_height: { type: 'number', description: '子模块高。默认 56。' },
        link_type: {
          type: 'string',
          enum: ['orthogonal', 'bezier', 'smooth', 'arc', 'straight'],
          description:
            '默认连线类型（单条 link 的 type 优先）。曲线只在层框之间的空隙里弯曲，不会穿过或贴住层框边框。默认 orthogonal。',
        },
        clear_existing: { type: 'boolean', description: '先清空场景。默认 false。' },
      },
      required: ['scene', 'layers', 'links'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sceneName = str(args.scene, 'default')
      const layers: ArchLayer[] = (args.layers as unknown[]).map((l, li) => {
        const o = (l ?? {}) as Record<string, unknown>
        const mods = (Array.isArray(o.modules) ? o.modules : []).map((m, mi) => {
          const mo = (m ?? {}) as Record<string, unknown>
          return { key: str(mo.key) || `m${li}_${mi}`, label: str(mo.label) || str(mo.key) || `M${mi + 1}`, fill: str(mo.fill) || undefined }
        })
        return {
          key: str(o.key) || `layer${li}`,
          label: str(o.label) || str(o.key) || `Layer ${li + 1}`,
          fill: str(o.fill) || undefined,
          modules: mods,
        }
      })
      const links: ArchLink[] = (args.links as unknown[]).map((r) => {
        const o = (r ?? {}) as Record<string, unknown>
        const t = str(o.type)
        const edgeTypes = ['straight', 'orthogonal', 'bezier', 'smooth', 'arc']
        return {
          from: str(o.from),
          to: str(o.to),
          label: str(o.label) || undefined,
          type: (edgeTypes.includes(t) ? t : undefined) as ArchLink['type'],
          dashed: bool(o.dashed, false),
        }
      })

      const scene = store.getOrCreate(sceneName)
      if (bool(args.clear_existing, false)) scene.elements = []
      scene.paper = true

      const edgeTypes = ['straight', 'orthogonal', 'bezier', 'smooth', 'arc']
      const lt = str(args.link_type)
      const { moduleIds, layerRects, moduleRects, width, height } = drawArchScene(
        scene,
        layers,
        links,
        { strokeWidth: 2, roughness: 1 },
        {
          linkType: (edgeTypes.includes(lt) ? lt : 'orthogonal') as ArchOptions['linkType'],
          layerGap: intNum(args.layer_gap, 'layer_gap', 20, 500, 96),
          moduleGap: intNum(args.module_gap, 'module_gap', 0, 300, 24),
          moduleWidth: intNum(args.module_width, 'module_width', 60, 600, 170),
          moduleHeight: intNum(args.module_height, 'module_height', 30, 300, 56),
          padding: intNum(args.padding, 'padding', 0, 500, 60),
        },
      )

      centerScene(scene, { padding: 60 })
      store.update(scene)

      const layerOut = Object.fromEntries(
        layers.map((l) => {
          const lr = layerRects[l.key] ?? { x: 0, y: 0, width: 0, height: 0 }
          return [
            l.key,
            {
              x: lr.x,
              y: lr.y,
              width: lr.width,
              height: lr.height,
              modules: Object.fromEntries(
                l.modules.map((m) => {
                  const mr = moduleRects[m.key] ?? { x: 0, y: 0, width: 0, height: 0 }
                  return [m.key, { id: moduleIds[m.key], ...mr }]
                }),
              ),
            },
          ]
        }),
      )

      return {
        scene: scene.name,
        elementCount: scene.elements.length,
        width: scene.width,
        height: scene.height,
        layers: layerOut,
      }
    },
  })
}
