/**
 * Element-level tools: add_* shape tools. Each mutates a named scene.
 * Scene helpers (new_scene, list_scenes, ...) live in scene-tools.ts.
 */

import { createElement, type Scene, type SceneElement, type TextElement } from '../core/scene.js'
import type { ToolDefinition, ToolRegistry } from './registry.js'
import {
  angleRad,
  bool,
  clampNum,
  color,
  fillStyle,
  intNum,
  points,
  safeText,
  str,
  strokeStyle,
  textWidth,
} from './validators.js'

/** Shared arg schema fields for every element. */
const COMMON_PROPS = {
  scene: { type: 'string', description: 'Scene name (created via new_scene if missing)' },
  id: { type: 'string', description: 'Optional element id. Auto-generated if omitted.' },
  x: { type: 'number', description: 'X (scene coords, top-left). Default 0.' },
  y: { type: 'number', description: 'Y (scene coords, top-left). Default 0.' },
  width: { type: 'number', description: 'Width in px. Default 100.' },
  height: { type: 'number', description: 'Height in px. Default 60.' },
  stroke_color: { type: 'string', description: 'Stroke color (hex or CSS color). Default #1e1e1e.' },
  background_color: { type: 'string', description: 'Fill color (hex). Default transparent.' },
  stroke_width: { type: 'number', description: 'Stroke thickness: 1 | 2 | 4. Default 2.' },
  stroke_style: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: 'Default solid.' },
  fill_style: { type: 'string', enum: ['hachure', 'cross-hatch', 'solid', 'none'], description: 'Default hachure.' },
  roughness: { type: 'number', description: 'Hand-drawn jitter 0..2. Default 1.' },
  opacity: { type: 'number', description: '0..100. Default 100.' },
  angle: { type: 'number', description: 'Rotation in radians. Default 0.' },
  dash: { type: 'array', description: '[dashLen, gapLen] pattern override.' },
} satisfies Record<string, { type: string; description?: string; enum?: string[]; items?: { type: string } }>

type CommonArgs = Record<string, unknown>

function commonFromArgs(
  a: CommonArgs,
  scene: Scene,
  defaults: { width?: number; height?: number; background_color?: string } = {},
): Omit<SceneElement, 'id' | 'type' | 'data'> & { id?: string } {
  return {
    id: str(a.id) || undefined,
    x: clampNum(a.x, 'x', -100000, 100000, 0),
    y: clampNum(a.y, 'y', -100000, 100000, 0),
    width: clampNum(a.width, 'width', 0, 100000, defaults.width ?? 100),
    height: clampNum(a.height, 'height', 0, 100000, defaults.height ?? 60),
    stroke_color: color(a.stroke_color, '#1e1e1e'),
    background_color: color(a.background_color, defaults.background_color ?? 'transparent'),
    stroke_width: intNum(a.stroke_width, 'stroke_width', 1, 8, 2),
    stroke_style: strokeStyle(a.stroke_style),
    fill_style: fillStyle(a.fill_style),
    roughness: clampNum(a.roughness, 'roughness', 0, 2, 1),
    opacity: intNum(a.opacity, 'opacity', 0, 100, 100),
    angle: angleRad(a.angle),
    dash: Array.isArray(a.dash) && a.dash.length === 2 ? [Number(a.dash[0]), Number(a.dash[1])] : undefined,
  }
}

export interface ToolCtx {
  getScene(name: string): Scene
  updateScene(scene: Scene): Scene
}

let seq = 0
export function makeId(prefix: string): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`
}

function sceneFor(ctx: ToolCtx, name: string | undefined): Scene {
  const n = str(name, 'default')
  return ctx.getScene(n)
}

function pushElement(ctx: ToolCtx, scene: Scene, el: SceneElement): SceneElement {
  scene.elements.push(el)
  ctx.updateScene(scene)
  return el
}

function define(
  name: string,
  description: string,
  extraProps: Record<string, unknown>,
  builder: (a: CommonArgs, ctx: ToolCtx, scene: Scene) => SceneElement,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...COMMON_PROPS, ...extraProps },
      additionalProperties: false,
    },
    handler(args) {
      const scene = sceneFor(ctxHolder, args.scene as string | undefined)
      const el = builder(args, ctxHolder, scene)
      pushElement(ctxHolder, scene, el)
      return { id: el.id, type: el.type, message: `${el.type} added to scene "${scene.name}"` }
    },
  }
}

// Filled at registration time — registry provides the ctx. See registerElementTools.
const ctxHolder: ToolCtx = {
  getScene: () => {
    throw new Error('element tools not initialized')
  },
  updateScene: (s) => s,
}

export function registerElementTools(reg: ToolRegistry, ctx: ToolCtx): void {
  // bind ctx
  ctxHolder.getScene = ctx.getScene
  ctxHolder.updateScene = ctx.updateScene

  reg.register(
    define(
      'add_rectangle',
      'Add a hand-drawn (rough) rectangle to a scene. Use fill_style="hachure"/"cross-hatch" for the Excalidraw look.',
      {},
      (a, _ctx, scene) =>
        createElement('rectangle', commonFromArgs(a, scene), { idSeq: () => makeId('rect') }),
    ),
  )

  reg.register(
    define(
      'add_ellipse',
      'Add a hand-drawn ellipse (or circle when width=height) to a scene.',
      {},
      (a, _ctx, scene) =>
        createElement('ellipse', commonFromArgs(a, scene), { idSeq: () => makeId('ellipse') }),
    ),
  )

  reg.register(
    define(
      'add_diamond',
      'Add a hand-drawn diamond (decision node in flowcharts) to a scene.',
      {},
      (a, _ctx, scene) =>
        createElement('diamond', commonFromArgs(a, scene), { idSeq: () => makeId('diamond') }),
    ),
  )

  reg.register(
    define(
      'add_line',
      'Add a hand-drawn polyline. Provide data.points as [[x,y],...] (scene coords, relative to the element).',
      { data: { type: 'object', description: 'Element data. Must include points: [[x,y],...]' } },
      (a, _ctx, scene) => {
        const pts = points((a.data as Record<string, unknown>)?.points)
        const el = createElement('line', commonFromArgs(a, scene, { width: 0, height: 0 }), {
          idSeq: () => makeId('line'),
        })
        el.data = { points: pts }
        // auto-size bounding box from points (so transforms/rotation work)
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        el.x = Math.min(...xs)
        el.y = Math.min(...ys)
        el.width = Math.max(...xs) - el.x
        el.height = Math.max(...ys) - el.y
        return el
      },
    ),
  )

  reg.register(
    define(
      'add_arrow',
      'Add a hand-drawn arrow. Provide data.points [[x,y],...]; an arrowhead is drawn at the last point.',
      { data: { type: 'object', description: 'Element data. Must include points: [[x,y],...]' } },
      (a, _ctx, scene) => {
        const pts = points((a.data as Record<string, unknown>)?.points)
        const el = createElement('arrow', commonFromArgs(a, scene, { width: 0, height: 0 }), {
          idSeq: () => makeId('arrow'),
        })
        el.data = { points: pts }
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        el.x = Math.min(...xs)
        el.y = Math.min(...ys)
        el.width = Math.max(...xs) - el.x
        el.height = Math.max(...ys) - el.y
        return el
      },
    ),
  )

  reg.register(
    define(
      'add_text',
      'Add a hand-written-style text label (Virgil/Comic Sans font family). data.text is the label.',
      {
        data: {
          type: 'object',
          description:
            'Element data. { text: string; font_size?: number (default 20); text_align?: "left"|"center"|"right"; text_stroke_color?: string (描边色，默认 "#ffffff" 白描边；传 "none" 关闭); text_stroke_width?: number (描边宽，默认 3) }',
        },
      },
      (a, _ctx, scene) => {
        const d = (a.data ?? {}) as Record<string, unknown>
        const text = safeText(d.text)
        const lines = text.split('\n').length
        const maxLine = Math.max(...text.split('\n').map((l) => l.length), 1)
        const el = createElement('text', commonFromArgs(a, scene, {}), {
          idSeq: () => makeId('text'),
        })
        // 字号自适应：传了 width 时按宽度收缩，否则按文本自然宽度定字号
        let fontSize = clampNum(d.font_size, 'font_size', 8, 200, 20)
        if (el.width && el.width > 0) {
          const fit = Math.floor((el.width - 6) / Math.max(textWidth(text, fontSize) / fontSize, 0.1))
          fontSize = Math.max(8, Math.min(fontSize, fit))
        }
        el.width = el.width || maxLine * fontSize * 0.6
        el.height = el.height || lines * fontSize * 1.3
        const strokeColor = safeText(d.text_stroke_color, '#ffffff')
        const data: TextElement['data'] = {
          text,
          font_size: fontSize,
          text_align: d.text_align === 'center' || d.text_align === 'right' ? d.text_align : 'left',
        }
        // 默认白描边（在彩色/hachure 底上可读性更好）；传 "none" 关闭
        if (strokeColor && strokeColor !== 'none') {
          data.text_stroke_color = strokeColor
          data.text_stroke_width = clampNum(d.text_stroke_width, 'text_stroke_width', 1, 20, 3)
        }
        el.data = data
        return el
      },
    ),
  )

  reg.register(
    define(
      'add_draw',
      'Add a freehand stroke. data.points is a dense list of [[x,y],...] samples.',
      { data: { type: 'object', description: 'Element data. Must include points: [[x,y],...]' } },
      (a, _ctx, scene) => {
        const pts = points((a.data as Record<string, unknown>)?.points)
        const el = createElement('draw', commonFromArgs(a, scene, { width: 0, height: 0 }), {
          idSeq: () => makeId('draw'),
        })
        el.data = { points: pts }
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        el.x = Math.min(...xs)
        el.y = Math.min(...ys)
        el.width = Math.max(...xs) - el.x
        el.height = Math.max(...ys) - el.y
        return el
      },
    ),
  )

  reg.register(
    define(
      'add_image',
      'Add a raster image to a scene. data.data_url must be a data: URL (e.g. data:image/png;base64,...).',
      {
        data: {
          type: 'object',
          description: 'Element data. { data_url: "data:image/png;base64,..." }',
        },
      },
      (a, _ctx, scene) => {
        const d = (a.data ?? {}) as Record<string, unknown>
        const dataUrl = str(d.data_url, '')
        if (!dataUrl.startsWith('data:')) {
          throw new Error('data.data_url must be a data: URL')
        }
        const el = createElement('image', commonFromArgs(a, scene, {}), {
          idSeq: () => makeId('image'),
        })
        el.data = { data_url: dataUrl }
        return el
      },
    ),
  )

  reg.register(
    define(
      'add_frame',
      'Add a frame (a rough rectangle that groups children by id — children render inside it).',
      { data: { type: 'object', description: 'Element data. { children: string[] }' } },
      (a, _ctx, scene) => {
        const d = (a.data ?? {}) as Record<string, unknown>
        const children = Array.isArray(d.children) ? d.children.map(String) : []
        const el = createElement('frame', commonFromArgs(a, scene, {}), {
          idSeq: () => makeId('frame'),
        })
        el.data = { children }
        return el
      },
    ),
  )
}
