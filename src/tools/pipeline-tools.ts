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
import {
  centerScene,
  fitSceneContent,
  detectOverflow,
  expandSceneToContent,
  type SceneOverflow,
} from '../core/fit.js'
import { runLayoutGate, checkSceneLayout } from '../core/layout-check.js'
import { DEF_COLUMN_GAP, DEF_ROW_GAP } from '../core/layout.js'
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
  /** 导出图像的实际像素尺寸（fit_content 生效时可能大于画布尺寸）。 */
  width?: number
  height?: number
  /** 导出时元素的四边越界量；overflow=true 说明有元素原本落在画布外。 */
  overflow?: SceneOverflow
  /** 导出前的自动修复（扩画布）。 */
  repairs?: string[]
  /** 面向调用方的告警（越界被扩画布兜住时也会给出，避免「静默裁切」）。 */
  warnings?: string[]
}

/** 把越界信息转成人可读的告警文案。 */
export function overflowWarnings(overflow: SceneOverflow, canvas: { width: number; height: number }): string[] {
  if (!overflow.overflow) return []
  const sides: string[] = []
  if (overflow.left > 0.5) sides.push(`左 ${Math.ceil(overflow.left)}px`)
  if (overflow.top > 0.5) sides.push(`上 ${Math.ceil(overflow.top)}px`)
  if (overflow.right > 0.5) sides.push(`右 ${Math.ceil(overflow.right)}px`)
  if (overflow.bottom > 0.5) sides.push(`下 ${Math.ceil(overflow.bottom)}px`)
  const who = overflow.elements.length
    ? `（涉及 ${overflow.elements.length} 个元素）`
    : ''
  return [
    `有内容超出画布 ${canvas.width}×${canvas.height}：${sides.join('/')}${who}。` +
      `已按实际内容范围渲染（fit_content），未发生裁切；如需严格贴合画布，请先调用 fit / 调整节点位置。`,
  ]
}

export interface ExportOptions {
  baseName?: string
  scale?: number
  dir?: string
  formats?: ExportFormat[]
  /**
   * 按实际内容范围渲染（默认 true）。
   *
   * 关闭时严格按 scene.width/height 出图 —— 落在画布外的元素会被 viewBox
   * 静默裁掉（白图不报错）。打开时 viewBox 取「画布 ∪ 内容包围盒」，
   * 越界内容照样可见，并在结果里给出 warnings。
   */
  fitContent?: boolean
  /** 内容四周留白（fitContent 时生效）。默认 24。 */
  contentPadding?: number
  /** 导出前自动扩画布，让 scene.width/height 真正包住内容（默认 false）。 */
  autoExpand?: boolean
}

/**
 * 渲染并导出 svg / png / excalidraw 到本地文件（默认 cwd/<name>.<ext>）。
 * 目录不存在会自动创建。
 *
 * 画布与内容不一致是「导出白图」的头号原因：export_scene 严格按画布矩形
 * 渲染，画布外的元素会被静默裁掉。这里统一用 fitContent（viewBox 取并集）
 * 兜底，并把越界情况作为 warnings 返回给调用方。
 */
export async function exportSceneFiles(scene: Scene, opts: ExportOptions = {}): Promise<ExportResult> {
  const { join } = await import('node:path')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const base = opts.baseName ?? scene.name
  const dir = opts.dir ?? process.cwd()
  const scale = opts.scale ?? 2
  const formats = opts.formats ?? ['svg', 'png']
  const contentPadding = opts.contentPadding ?? 24

  // 目录不存在时先创建（嵌套目录也支持）
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录已存在或创建失败时忽略（writeFileSync 会给出明确错误） */
  }

  const out: ExportResult = {}
  const repairs: string[] = []

  // 先测一次越界（autoExpand 之前）：这是「画布是否真的包住了内容」的真实答案，
  // 也是 fit_content=false 时会被裁掉的那部分。
  const overflow = detectOverflow(scene)
  const canvasBefore = { width: scene.width, height: scene.height }

  if (opts.autoExpand && overflow.overflow) {
    const res = expandSceneToContent(scene, { padding: contentPadding })
    if (res.expanded) repairs.push(`画布扩展到 ${res.width}×${res.height} 以容纳全部内容`)
  }

  out.overflow = overflow
  const warnings: string[] = []
  if (opts.fitContent === false) {
    if (overflow.overflow) {
      warnings.push(
        `fit_content=false 且内容超出画布 ${canvasBefore.width}×${canvasBefore.height}，超出部分已被裁掉（白图风险）。` +
          `请改用 fit_content=true 或先调整节点位置。`,
      )
    }
  } else {
    // fit_content 兜住了裁切，但画布本身没包住内容这件事仍要告诉调用方
    warnings.push(...overflowWarnings(overflow, canvasBefore))
  }
  if (repairs.length) out.repairs = repairs
  if (warnings.length) out.warnings = warnings

  const renderOpts = {
    fitContent: opts.fitContent !== false,
    contentPadding,
  }

  if (formats.includes('excalidraw')) {
    const { sceneToExcalidraw } = await import('../core/excalidraw.js')
    const doc = sceneToExcalidraw(scene)
    const json = JSON.stringify(doc, null, 2)
    const path = join(dir, `${base}.excalidraw`)
    writeFileSync(path, json, 'utf8')
    out.excalidrawPath = path
    out.excalidrawBytes = json.length
  }

  let svgSrc = ''
  let viewW = scene.width
  let viewH = scene.height
  if (formats.includes('svg') || formats.includes('png')) {
    svgSrc = renderSceneSvg(scene, renderOpts)
    // 从 viewBox 反算真实导出尺寸（fitContent 生效时可能大于画布）
    const vb = svgSrc.match(/viewBox="([^"]+)"/)
    if (vb) {
      const nums = vb[1].trim().split(/\s+/).map(Number)
      if (nums.length === 4 && nums.every(Number.isFinite)) {
        viewW = nums[2]
        viewH = nums[3]
      }
    }
  }

  if (formats.includes('svg')) {
    const svgPath = join(dir, `${base}.svg`)
    writeFileSync(svgPath, svgSrc, 'utf8')
    out.svgPath = svgPath
    out.svgBytes = svgSrc.length
    out.width = Math.round(viewW)
    out.height = Math.round(viewH)
  }

  if (formats.includes('png')) {
    const { Resvg } = await import('@resvg/resvg-js')
    const resvg = new Resvg(svgSrc, { fitTo: { mode: 'zoom', value: scale } })
    const png = resvg.render().asPng()
    const pngPath = join(dir, `${base}.png`)
    writeFileSync(pngPath, png)
    out.pngPath = pngPath
    out.pngBytes = png.length
    out.width = Math.round(viewW * scale)
    out.height = Math.round(viewH * scale)
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
        column_gap: { type: 'number', description: '同层节点之间的实际像素间隙。默认 60。' },
        row_gap: { type: 'number', description: '相邻层之间的实际像素间隙。默认 70。' },
        padding: { type: 'number', description: '外边距。默认 60。' },
        direction: { type: 'string', enum: ['TB', 'LR'], description: '流程/树布局方向。默认 TB。' },
        export_svg_png: { type: 'boolean', description: '是否同时导出 svg+png 到本地。默认 true。' },
        export_excalidraw: {
          type: 'boolean',
          description: '是否额外导出可编辑的 .excalidraw 文件（Excalidraw v2，excalidraw.com 可打开编辑）。默认 false。',
        },
        export_dir: { type: 'string', description: '导出目录。默认当前工作目录。' },
        layout_check: {
          type: 'boolean',
          description:
            '绘制前的布局检测（默认 true）：检查节点重叠/间距/连线穿节点/孤立节点/填充率，通过后才开始绘制。返回结果里的 layoutCheck 字段给出问题清单。',
        },
        auto_fix_layout: {
          type: 'boolean',
          description: '检测到布局问题时自动修复（分轴推挤节点、收拢孤立节点、贴合内容重算画布）。默认 true。',
        },
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

        // 时序/ER/架构：内容居中到画布（居中后画布 = 内容包围盒 + 2×padding）
        centerScene(scene, { padding: 60 })
        // 绘制后的布局体检：这些类型没有 FinalPlan，检查的是最终场景（越界/空场景）
        const gate = bool(args.layout_check, true)
          ? checkSceneLayout(scene, { repair: bool(args.auto_fix_layout, true) })
          : { ok: true, issues: [], repairs: [] as string[], width: scene.width, height: scene.height }
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
          layoutCheck: gate,
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
        columnGap: intNum(args.column_gap, 'column_gap', 10, 1000, DEF_COLUMN_GAP),
        rowGap: intNum(args.row_gap, 'row_gap', 10, 1000, DEF_ROW_GAP),
        padding: intNum(args.padding, 'padding', 0, 2000, 60),
        direction: str(args.direction, 'TB') === 'LR' ? 'LR' : 'TB',
      })

      // ---- 绘制前的布局优化 / 检测（通过后才开始绘制） ----
      const gate = runLayoutGate(plan.plan, {
        enabled: bool(args.layout_check, true),
        repair: bool(args.auto_fix_layout, true),
      })

      const drawn = drawPlanScene(scene, {
        kind: layoutKind,
        plan: plan.plan,
        style,
        title: str(args.title) || undefined,
      })
      // 画布取规划尺寸（不沿用场景旧画布 —— 旧的 2400×1600 会让小图只剩大片空白），
      // 随后 fitSceneContent 收缩到贴合内容
      scene.width = plan.plan.sceneWidth
      scene.height = plan.plan.sceneHeight
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
        layoutCheck: gate,
        nodes: nodesOut,
        export: exported,
      }
    },
  })

  // ---- export_scene ----
  reg.register({
    name: 'export_scene',
    description:
      '把场景导出为 svg / png / excalidraw 文件（perf.md 第 7 步）。默认写 <scene>.svg + <scene>.png；传 formats:["excalidraw"] 额外产出可编辑的 .excalidraw（Excalidraw v2，excalidraw.com 可打开编辑）。默认按实际内容范围渲染（fit_content），画布外的元素不会被静默裁掉，越界情况会以 warnings 返回。',
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
        fit_content: {
          type: 'boolean',
          description:
            '按实际内容范围渲染（默认 true）。viewBox 取「画布 ∪ 内容包围盒」，画布外的元素照样可见。设为 false 则严格按画布矩形渲染，越界内容会被裁掉（会返回 warning）。',
        },
        auto_fit: {
          type: 'boolean',
          description: '导出前把 scene.width/height 撑到刚好包住内容（只扩不缩，不移动元素）。默认 true。',
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
      const autoFit = bool(args.auto_fit, true)
      const res = await exportSceneFiles(scene, {
        baseName: str(args.name) || scene.name,
        scale: intNum(args.scale, 'scale', 1, 8, 2),
        dir: str(args.dir) || process.cwd(),
        formats,
        fitContent: bool(args.fit_content, true),
        autoExpand: autoFit,
      })
      if (autoFit) store.update(scene)
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
