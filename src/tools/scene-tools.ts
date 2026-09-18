/**
 * Scene-level tools: create / inspect / mutate scenes.
 */

import { createElement, type Scene, type SceneElement } from '../core/scene.js'
import { renderSceneSvg } from '../core/render.js'
import type { SceneStore } from '../mcp/store.js'
import type { ToolRegistry } from './registry.js'
import { bool, clampNum, intNum, str } from './validators.js'
import { makeId } from './element-tools.js'

export function registerSceneTools(reg: ToolRegistry, store: SceneStore): void {
  reg.register({
    name: 'new_scene',
    description:
      'Create a new empty scene (whiteboard). Returns the scene summary. Scenes persist to .ai-paint/<name>.json.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique scene name (required).' },
        width: { type: 'number', description: 'Canvas width in px. Default 2400.' },
        height: { type: 'number', description: 'Canvas height in px. Default 1600.' },
        background_color: { type: 'string', description: 'Background color. Default #ffffff.' },
        paper: { type: 'boolean', description: 'Paper look (off-white + vignette). Default true.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const name = str(args.name)
      if (!name) throw new Error('name is required')
      const existing = store.get(name)
      if (existing) throw new Error(`scene "${name}" already exists — use a different name or delete_scene first`)
      const width = intNum(args.width, 'width', 100, 100000, 2400)
      const height = intNum(args.height, 'height', 100, 100000, 1600)
      const scene = store.create(name, width, height, str(args.background_color, '#ffffff'))
      scene.paper = bool(args.paper, true)
      return summarize(scene)
    },
  })

  reg.register({
    name: 'list_scenes',
    description: 'List all scenes and their element counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => ({ scenes: store.list() }),
  })

  reg.register({
    name: 'get_scene',
    description: 'Get a scene: elements (ids, types, bboxes) and canvas info. Use this to plan a drawing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Scene name (required).' },
        include_elements: { type: 'boolean', description: 'Include full element JSON. Default true.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.name))
      const summary = summarize(scene)
      if (bool(args.include_elements, true)) {
        return { ...summary, elements: scene.elements }
      }
      return summary
    },
  })

  reg.register({
    name: 'update_scene',
    description: 'Batch-update scene properties (width/height/background/paper).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Scene name (required).' },
        width: { type: 'number' },
        height: { type: 'number' },
        background_color: { type: 'string' },
        paper: { type: 'boolean' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.name))
      if (args.width !== undefined) scene.width = intNum(args.width, 'width', 100, 100000, scene.width)
      if (args.height !== undefined) scene.height = intNum(args.height, 'height', 100, 100000, scene.height)
      if (args.background_color !== undefined) scene.background_color = str(args.background_color, scene.background_color)
      if (args.paper !== undefined) scene.paper = bool(args.paper, scene.paper)
      store.update(scene)
      return summarize(scene)
    },
  })

  reg.register({
    name: 'delete_element',
    description: 'Remove one element by id from a scene.',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'Scene name (required).' },
        id: { type: 'string', description: 'Element id (required).' },
      },
      required: ['scene', 'id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene))
      const id = str(args.id)
      const idx = scene.elements.findIndex((e) => e.id === id)
      if (idx === -1) throw new Error(`element "${id}" not found in scene "${scene.name}"`)
      scene.elements.splice(idx, 1)
      store.update(scene)
      return { deleted: id, elementCount: scene.elements.length }
    },
  })

  reg.register({
    name: 'clear_scene',
    description: 'Remove all elements from a scene (keeps canvas settings).',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'Scene name (required).' },
      },
      required: ['scene'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene))
      scene.elements = []
      store.update(scene)
      return { cleared: true, elementCount: 0 }
    },
  })

  reg.register({
    name: 'delete_scene',
    description: 'Delete a scene entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Scene name (required).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const name = str(args.name)
      const ok = store.delete(name)
      if (!ok) throw new Error(`scene "${name}" does not exist`)
      return { deleted: name }
    },
  })

  reg.register({
    name: 'get_scene_svg',
    description:
      'Render the scene to an SVG string. Returns the raw SVG markup (use save_svg_to_file to persist).',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'Scene name (required).' },
      },
      required: ['scene'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene))
      return { svg: renderSceneSvg(scene) }
    },
  })

  reg.register({
    name: 'save_scene_svg',
    description:
      'Render the scene to an SVG file on disk. Returns the file path. Use when the agent needs a file for the user.',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'Scene name (required).' },
        path: { type: 'string', description: 'Output path (e.g. ./output/flow.svg). Default: <scene>.svg in cwd.' },
      },
      required: ['scene'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene))
      const svg = renderSceneSvg(scene)
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join, dirname } = await import('node:path')
      const outPath = str(args.path) || join(process.cwd(), `${scene.name}.svg`)
      // 目录不存在时先创建
      try {
        mkdirSync(dirname(outPath), { recursive: true })
      } catch {
        /* ignore */
      }
      writeFileSync(outPath, svg, 'utf8')
      return { path: outPath, bytes: svg.length }
    },
  })

  reg.register({
    name: 'save_scene_png',
    description:
      'Render the scene to a PNG file on disk (rasterized via resvg), and automatically write a companion editable .excalidraw file alongside it. Returns the file paths. Great for agent-hosted previews.',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'Scene name (required).' },
        path: { type: 'string', description: 'Output path (e.g. ./output/flow.png). Default: <scene>.png in cwd.' },
        scale: { type: 'number', description: 'Output scale (1 = scene size). Default 2.' },
        export_excalidraw: {
          type: 'boolean',
          description: '是否同时生成可编辑的 .excalidraw 文件（Excalidraw v2，excalidraw.com 可打开编辑）。默认 true。',
        },
      },
      required: ['scene'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene))
      const svg = renderSceneSvg(scene)
      const { Resvg } = await import('@resvg/resvg-js')
      const scale = clampNum(args.scale, 'scale', 0.25, 8, 2)
      const resvg = new Resvg(svg, { fitTo: { mode: 'zoom', value: scale } })
      const png = resvg.render().asPng()
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join, dirname, basename } = await import('node:path')
      const outPath = str(args.path) || join(process.cwd(), `${scene.name}.png`)
      // 目录不存在时先创建（支持 ./output/xxx.png 这类嵌套路径）
      try {
        mkdirSync(dirname(outPath), { recursive: true })
      } catch {
        /* ignore */
      }
      writeFileSync(outPath, png)

      // 伴随导出：在 PNG 同目录生成同名 .excalidraw（可编辑文件）
      let excalidrawPath: string | null = null
      let excalidrawBytes = 0
      if (bool(args.export_excalidraw, true)) {
        const { sceneToExcalidraw } = await import('../core/excalidraw.js')
        const doc = sceneToExcalidraw(scene)
        const json = JSON.stringify(doc, null, 2)
        const dirPath = dirname(outPath)
        const baseName = basename(outPath, '.png')
        excalidrawPath = join(dirPath, `${baseName}.excalidraw`)
        writeFileSync(excalidrawPath, json, 'utf8')
        excalidrawBytes = json.length
      }

      return {
        path: outPath,
        bytes: png.length,
        width: scene.width * scale,
        height: scene.height * scale,
        excalidrawPath,
        excalidrawBytes,
      }
    },
  })

  reg.register({
    name: 'update_element',
    description: 'Update style/properties of an existing element by id (position, size, colors, roughness, ...).',
    inputSchema: {
      type: 'object',
      properties: {
        scene: { type: 'string', description: 'Scene name (required).' },
        id: { type: 'string', description: 'Element id (required).' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        stroke_color: { type: 'string' },
        background_color: { type: 'string' },
        stroke_width: { type: 'number' },
        stroke_style: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
        fill_style: { type: 'string', enum: ['hachure', 'cross-hatch', 'solid', 'none'] },
        roughness: { type: 'number', description: '0..2' },
        opacity: { type: 'number', description: '0..100' },
        angle: { type: 'number', description: 'Radians' },
      },
      required: ['scene', 'id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const scene = store.getOrCreate(str(args.scene))
      const id = str(args.id)
      const el = scene.elements.find((e) => e.id === id)
      if (!el) throw new Error(`element "${id}" not found in scene "${scene.name}"`)
      const a = args as Record<string, unknown>
      if (a.x !== undefined) el.x = clampNum(a.x, 'x', -100000, 100000, el.x)
      if (a.y !== undefined) el.y = clampNum(a.y, 'y', -100000, 100000, el.y)
      if (a.width !== undefined) el.width = clampNum(a.width, 'width', 0, 100000, el.width)
      if (a.height !== undefined) el.height = clampNum(a.height, 'height', 0, 100000, el.height)
      if (a.stroke_color !== undefined) el.stroke_color = str(a.stroke_color, el.stroke_color)
      if (a.background_color !== undefined) el.background_color = str(a.background_color, el.background_color)
      if (a.stroke_width !== undefined) el.stroke_width = intNum(a.stroke_width, 'stroke_width', 1, 8, el.stroke_width)
      if (a.roughness !== undefined) el.roughness = clampNum(a.roughness, 'roughness', 0, 2, el.roughness)
      if (a.opacity !== undefined) el.opacity = intNum(a.opacity, 'opacity', 0, 100, el.opacity)
      if (a.angle !== undefined) el.angle = clampNum(a.angle, 'angle', -Math.PI * 4, Math.PI * 4, el.angle)
      if (a.stroke_style !== undefined) {
        const s = str(a.stroke_style, 'solid')
        el.stroke_style = s === 'dashed' || s === 'dotted' ? s : 'solid'
      }
      if (a.fill_style !== undefined) {
        const f = str(a.fill_style, 'hachure')
        el.fill_style = f === 'solid' || f === 'cross-hatch' || f === 'none' ? f : 'hachure'
      }
      store.update(scene)
      return { id: el.id, type: el.type, updated: true }
    },
  })
}

function summarize(scene: Scene): Record<string, unknown> {
  const byType: Record<string, number> = {}
  for (const el of scene.elements) {
    byType[el.type] = (byType[el.type] ?? 0) + 1
  }
  return {
    name: scene.name,
    width: scene.width,
    height: scene.height,
    background_color: scene.background_color,
    paper: scene.paper,
    elementCount: scene.elements.length,
    elementsByType: byType,
  }
}
