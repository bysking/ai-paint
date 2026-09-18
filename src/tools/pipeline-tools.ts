/**
 * 统一图表管线工具（perf.md 流程的对外入口）：
 *
 *   create_diagram —— 一站式：大模型给出节点/边数组 → 布局 → 后处理 → 缓存 → 绘制
 *                     → 返回最终数据（坐标/碰撞修正/缓存指纹），并可顺手导出 svg+png
 *   export_scene   —— 把场景导出为 svg + png（perf.md 第 7 步）
 *   get_plan / list_plans / delete_plan —— 本地缓存管理
 *
 * 与现有 create_flow_diagram / plan_flow_layout 走同一 core/plan 管线，
 * 只是输入契约更贴近 perf.md（name/description/type + source/target）。
 */

import { createElement, type Scene } from '../core/scene.js'
import { planDiagram, PlanStore, type FinalPlan } from '../core/plan.js'
import { renderSceneSvg } from '../core/render.js'
import { centerScene, fitSceneContent } from '../core/fit.js'
import type { SceneStore } from '../mcp/store.js'
import type { ToolRegistry } from './registry.js'
import { bool, color, intNum, str } from './validators.js'
import { makeId } from './element-tools.js'
import { drawPlanScene, type DiagramKind, type DrawStyle } from './draw.js'

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

const LAYOUT_KINDS = ['layered', 'tree', 'grid', 'circular'] as const
const DIAGRAM_KINDS: DiagramKind[] = ['flow', 'sequence', 'er', 'architecture', ...LAYOUT_KINDS]

function diagramKind(v: unknown): DiagramKind {
  const s = str(v, 'flow').toLowerCase()
  if (DIAGRAM_KINDS.includes(s as DiagramKind)) return s as DiagramKind
  return 'flow'
}

/** 把 kind 归一化为核心布局类型（flow→layered，其余透传）。 */
function layoutKindFor(kind: DiagramKind): 'layered' | 'tree' | 'grid' | 'circular' {
  if (kind === 'flow') return 'layered'
  return kind as 'layered' | 'tree' | 'grid' | 'circular'
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export type ExportFormat = 'svg' | 'png' | 'excalidraw'

export interface ExportResult {
  svgPath?: string
  pngPath?: string
  excalidrawPath?: string
  svgBytes?: number
  pngBytes?: number
  excalidrawBytes?: number
  width?: number
  height?: number
}

/** 渲染并导出 svg / png / excalidraw 到本地文件（默认 cwd/<name>.<ext>）。目录不存在会自动创建。 */
export async function exportSceneFiles(
  scene: Scene,
  opts: { baseName?: string; scale?: number; dir?: string; formats?: ExportFormat[] } = {},
): Promise<ExportResult> {
  const { join } = await import('node:path')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const base = opts.baseName ?? scene.name
  const dir = opts.dir ?? process.cwd()
  const scale = opts.scale ?? 2
  const formats = opts.formats ?? ['svg', 'png']

  // 目录不存在时先创建（嵌套目录也支持）
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录已存在或创建失败时忽略（writeFileSync 会给出明确错误） */
  }

  const out: ExportResult = {}

  if (formats.includes('excalidraw')) {
    const { sceneToExcalidraw } = await import('../core/excalidraw.js')
    const doc = sceneToExcalidraw(scene)
    const json = JSON.stringify(doc, null, 2)
    const path = join(dir, `${base}.excalidraw`)
    writeFileSync(path, json, 'utf8')
    out.excalidrawPath = path
    out.excalidrawBytes = json.length
  }

  if (formats.includes('svg')) {
    const svg = renderSceneSvg(scene)
    const svgPath = join(dir, `${base}.svg`)
    writeFileSync(svgPath, svg, 'utf8')
    out.svgPath = svgPath
    out.svgBytes = svg.length
  }

  if (formats.includes('png')) {
    const { Resvg } = await import('@resvg/resvg-js')
    const svgSrc = renderSceneSvg(scene)
    const resvg = new Resvg(svgSrc, { fitTo: { mode: 'zoom', value: scale } })
    const png = resvg.render().asPng()
    const pngPath = join(dir, `${base}.png`)
    writeFileSync(pngPath, png)
    out.pngPath = pngPath
    out.pngBytes = png.length
    out.width = scene.width * scale
    out.height = scene.height * scale
  }

  return out
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

/** 从 args 计算导出格式：export_svg_png + export_excalidraw → formats。 */
function exportFormatsFromArgs(args: Record<string, unknown>): ExportFormat[] {
  const formats: ExportFormat[] = []
  if (bool(args.export_svg_png, true)) {
    formats.push('svg', 'png')
  }
  if (bool(args.export_excalidraw, false)) {
    formats.push('excalidraw')
  }
  return formats
}

export function registerPipelineTools(reg: ToolRegistry, store: SceneStore): void {
  // ---- create_diagram ----
  reg.register({
    name: 'create_diagram',
    description:
      '统一图表入口（perf.md 流程）：大模型根据图描述给出 nodes（[{name, description?, type?, width?, height?, x?, y?, fill?, layer?, fields?}]）与 edges（[{source, target, label?, type?, dashed?, from_card?, to_card?}]），ai-paint 做布局 → 环/碰撞/位置后处理 → 本地缓存 → 绘制到场景 → 导出 svg+png。type=flow|layered|tree|grid|circular|sequence|er|architecture。返回节点坐标、缓存指纹与导出文件路径。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '场景名（不存在则创建）。' },
        type: {
          type: 'string',
          enum: DIAGRAM_KINDS,
          description:
            '图类型：flow/layered/tree/grid/circular（流程图系列，走 antv 布局）、sequence（时序图）、er（ER 图）、architecture（架构图）。默认 flow。',
        },
        title: { type: 'string', description: '图标题（可选）。' },
        description: { type: 'string', description: '图描述（备注，不影响绘制）。' },
        nodes: {
          type: 'array',
          description:
            '节点数组：[{ name, description?, type? (形状: rectangle/diamond/ellipse/cylinder/...), width?, height?, x?, y?, fill?, layer?, fields? }] — name 唯一；type 即形状；width/height 缺省自动。',
        },
        edges: {
          type: 'array',
          description:
            '边数组：[{ source, target, label?, type? (straight/orthogonal/bezier/smooth/arc), dashed?, from_card?, to_card? }] — source/target 对应节点 name。',
        },
        participants: {
          type: 'array',
          description: '时序图参与者：[{ key, label, shape? (rectangle|actor|cylinder), fill? }]（type=sequence 时用）。',
        },
        messages: {
          type: 'array',
          description: '时序图消息：[{ from, to, label, dashed?, self? }]（type=sequence 时用）。',
        },
        entities: {
          type: 'array',
          description: 'ER 实体：[{ key, label, fields: [{ name, type?, key? }], fill? }]（type=er 时用）。',
        },
        relations: {
          type: 'array',
          description: 'ER 关系：[{ from, to, fromCard?, toCard?, label?, type? }]（type=er 时用）。',
        },
        layers: {
          type: 'array',
          description: '架构图层：[{ key, label, fill?, modules: [{ key, label, fill? }] }]（type=architecture 时用）。',
        },
        links: {
          type: 'array',
          description: '架构图跨层依赖：[{ from, to, label?, type?, dashed? }]（type=architecture 时用）。',
        },
        column_gap: { type: 'number', description: '列间距。默认 80。' },
        row_gap: { type: 'number', description: '行间距。默认 50。' },
        padding: { type: 'number', description: '外边距。默认 60。' },
        direction: { type: 'string', enum: ['TB', 'LR'], description: '流程/树布局方向。默认 TB。' },
        export_svg_png: { type: 'boolean', description: '是否同时导出 svg+png 到本地。默认 true。' },
        export_excalidraw: {
          type: 'boolean',
          description: '是否额外导出可编辑的 .excalidraw 文件（Excalidraw v2，excalidraw.com 可打开编辑）。默认 false。',
        },
        export_dir: { type: 'string', description: '导出目录。默认当前工作目录。' },
        clear_existing: { type: 'boolean', description: '先清空场景。默认 true。' },
      },
      required: ['scene'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sceneName = str(args.scene)
      const kind = diagramKind(args.type)
      const scene = store.getOrCreate(sceneName)
      if (bool(args.clear_existing, true)) scene.elements = []
      scene.paper = true

      const style: DrawStyle = {}
      const drawKind: DiagramKind = kind

      // ---- 非流程图类型直接规划+绘制（各自核心规划函数） ----
      if (kind === 'sequence' || kind === 'er' || kind === 'architecture') {
        const input = {
          kind: drawKind,
          title: str(args.title) || undefined,
          participants: Array.isArray(args.participants) ? (args.participants as never[]) : undefined,
          messages: Array.isArray(args.messages) ? (args.messages as never[]) : undefined,
          entities: Array.isArray(args.entities) ? (args.entities as never[]) : undefined,
          relations: Array.isArray(args.relations) ? (args.relations as never[]) : undefined,
          layers: Array.isArray(args.layers) ? (args.layers as never[]) : undefined,
          links: Array.isArray(args.links) ? (args.links as never[]) : undefined,
          style,
        }
        drawPlanScene(scene, input as never)

        // 时序/ER/架构：内容居中到画布
        centerScene(scene, { padding: 60 })
        store.update(scene)

        let exported: ExportResult | null = null
        if (exportFormatsFromArgs(args).length > 0) {
          exported = await exportSceneFiles(scene, {
            baseName: sceneName,
            scale: 2,
            dir: str(args.export_dir) || process.cwd(),
            formats: exportFormatsFromArgs(args),
          })
        }

        return {
          scene: scene.name,
          type: kind,
          elementCount: scene.elements.length,
          width: scene.width,
          height: scene.height,
          export: exported,
        }
      }

      // ---- 流程图系列：走统一 plan 管线 ----
      const layoutKind = layoutKindFor(kind)
      const plan = await planDiagram(args.nodes, args.edges, {
        name: sceneName,
        title: str(args.title) || undefined,
        description: str(args.description) || undefined,
        kind: layoutKind,
        columnGap: intNum(args.column_gap, 'column_gap', 10, 1000, 80),
        rowGap: intNum(args.row_gap, 'row_gap', 10, 1000, 50),
        padding: intNum(args.padding, 'padding', 0, 2000, 60),
        direction: str(args.direction, 'TB') === 'LR' ? 'LR' : 'TB',
      })

      const drawn = drawPlanScene(scene, { kind: layoutKind, plan: plan.plan, style })
      scene.width = Math.max(scene.width, plan.plan.sceneWidth)
      scene.height = Math.max(scene.height, plan.plan.sceneHeight)
      // 内容居中：捕获平移量，返回的节点坐标与场景元素实际位置一致
      const { width: fitW, height: fitH, dx, dy } = fitSceneContent(scene, { padding: 60 })
      scene.width = fitW
      scene.height = fitH
      store.update(scene)

      let exported: ExportResult | null = null
      if (exportFormatsFromArgs(args).length > 0) {
        exported = await exportSceneFiles(scene, {
          baseName: sceneName,
          scale: 2,
          dir: str(args.export_dir) || process.cwd(),
          formats: exportFormatsFromArgs(args),
        })
      }

      // 返回节点坐标（已随居中平移）
      const nodesOut: Record<string, unknown> = {}
      for (const n of plan.plan.nodeList) {
        const r = plan.plan.nodes[n.key]
        if (!r) continue
        nodesOut[n.key] = {
          id: drawn.nodeIds?.[n.key],
          x: r.x + dx,
          y: r.y + dy,
          width: r.width,
          height: r.height,
        }
      }

      return {
        scene: scene.name,
        type: kind,
        layoutKind,
        direction: plan.plan.direction,
        elementCount: scene.elements.length,
        width: scene.width,
        height: scene.height,
        fromCache: plan.fromCache,
        fingerprint: plan.plan.fingerprint,
        removedSelfLoops: plan.plan.removedSelfLoops,
        collisionFixes: plan.plan.collisionFixes,
        nodes: nodesOut,
        export: exported,
      }
    },
  })

  // ---- export_scene ----
  reg.register({
    name: 'export_scene',
    description:
      '把场景导出为 svg / png / excalidraw 文件（perf.md 第 7 步）。默认写 <scene>.svg + <scene>.png；传 formats:["excalidraw"] 额外产出可编辑的 .excalidraw（Excalidraw v2，excalidraw.com 可打开编辑）。',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: '场景名（必填）。' },
        name: { type: 'string', description: '导出文件基名（不含扩展名）。默认场景名。' },
        scale: { type: 'number', description: 'PNG 缩放（1 = 场景尺寸）。默认 2。' },
        dir: { type: 'string', description: '导出目录。默认当前工作目录。' },
        formats: {
          type: 'array',
          items: { type: 'string' },
          description: '导出格式：["svg","png","excalidraw"] 中的子集。默认 ["svg","png"]。',
        },
      },
      required: ['scene'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene))
      const formatsRaw = args.formats
      const formats: ExportFormat[] = Array.isArray(formatsRaw)
        ? (formatsRaw as string[]).filter((f): f is ExportFormat => f === 'svg' || f === 'png' || f === 'excalidraw')
        : ['svg', 'png']
      const res = await exportSceneFiles(scene, {
        baseName: str(args.name) || scene.name,
        scale: intNum(args.scale, 'scale', 1, 8, 2),
        dir: str(args.dir) || process.cwd(),
        formats,
      })
      return res
    },
  })

  // ---- get_plan / list_plans / delete_plan ----
  reg.register({
    name: 'get_plan',
    description: '读取缓存的最终绘制计划（FinalPlan：布局坐标/节点表/边/碰撞统计）。',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: '缓存指纹（create_diagram / planDiagram 返回）。' },
      },
      required: ['fingerprint'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const fp = str(args.fingerprint)
      const plan = PlanStore.read(fp)
      if (!plan) throw new Error(`plan "${fp}" 未命中缓存（可能已删除或指纹不匹配）`)
      return { plan }
    },
  })

  reg.register({
    name: 'list_plans',
    description: '列出本地缓存的全部绘制计划。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => ({ plans: PlanStore.list() }),
  })

  reg.register({
    name: 'delete_plan',
    description: '删除一条缓存计划。',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: '缓存指纹。' },
      },
      required: ['fingerprint'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const fp = str(args.fingerprint)
      const ok = PlanStore.delete(fp)
      if (!ok) throw new Error(`plan "${fp}" 不存在或删除失败`)
      return { deleted: fp }
    },
  })
}
