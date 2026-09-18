/**
 * Scene model — Excalidraw-inspired element types.
 * Serialization is snake_case, optimized for AI-agent tool calls.
 */

export type ElementType =
  | 'rectangle'
  | 'ellipse'
  | 'diamond'
  | 'shape'
  | 'line'
  | 'arrow'
  | 'edge'
  | 'text'
  | 'draw'
  | 'image'
  | 'frame'

export type StrokeStyle = 'solid' | 'dashed' | 'dotted'
export type FillStyle = 'hachure' | 'cross-hatch' | 'solid' | 'none'

export interface SceneElementBase {
  id: string
  type: ElementType
  /** Scene coordinates (top-left of bounding box, +y down). */
  x: number
  y: number
  width: number
  height: number
  stroke_color: string
  background_color: string
  /** Thickness in px; 1 = thin, 2 = normal, 4 = bold. */
  stroke_width: number
  stroke_style: StrokeStyle
  fill_style: FillStyle
  /** Roughness 0..2 — how hand-drawn it looks. */
  roughness: number
  opacity: number
  /** Element rotation in radians (absolute). */
  angle: number
  /** Optional dashed pattern override: [dashLen, gapLen]. */
  dash?: [number, number]
  /** Element-specific extra payload (see per-type comments). */
  data?: Record<string, unknown>
}

export interface RectangleElement extends SceneElementBase {
  type: 'rectangle'
}

export interface EllipseElement extends SceneElementBase {
  type: 'ellipse'
}

export interface DiamondElement extends SceneElementBase {
  type: 'diamond'
}

/** 通用形状元素：shape 字段指定形状类型（见 core/shapes.ts）。 */
export interface ShapeElement extends SceneElementBase {
  type: 'shape'
  data: { shape: string; [k: string]: unknown }
}

export interface LineElement extends SceneElementBase {
  type: 'line'
  data: { points: [number, number][] }
}

export interface ArrowElement extends SceneElementBase {
  type: 'arrow'
  data: { points: [number, number][] }
}

/** 连接线元素：data 携带 from/to 节点引用与连线类型（straight/orthogonal/bezier/smooth/arc）。 */
export interface EdgeElement extends SceneElementBase {
  type: 'edge'
  data: {
    from: string
    to: string
    edge_type?: string
    dashed?: boolean
    label?: string
    arrow?: string
    [k: string]: unknown
  }
}

export interface TextElement extends SceneElementBase {
  type: 'text'
  data: {
    text: string
    font_size: number
    text_align: 'left' | 'center' | 'right'
    /** 文字描边颜色（如白色 #ffffff 可增强在彩色底上的可读性）。默认无描边。 */
    text_stroke_color?: string
    /** 文字描边宽度 px。默认 3。 */
    text_stroke_width?: number
  }
}

export interface DrawElement extends SceneElementBase {
  type: 'draw'
  data: { points: [number, number][]; pressure?: number[] }
}

export interface ImageElement extends SceneElementBase {
  type: 'image'
  data: { data_url: string }
}

export interface FrameElement extends SceneElementBase {
  type: 'frame'
  /** Frame fills with background_color; child element ids are clipped. */
  data: { children: string[] }
}

export type SceneElement =
  | RectangleElement
  | EllipseElement
  | DiamondElement
  | ShapeElement
  | LineElement
  | ArrowElement
  | EdgeElement
  | TextElement
  | DrawElement
  | ImageElement
  | FrameElement

export interface Scene {
  name: string
  width: number
  height: number
  background_color: string
  /** true = paper look (slight warm off-white + subtle vignette). */
  paper: boolean
  elements: SceneElement[]
}

export type ElementInput = Omit<Partial<SceneElement>, 'type'> & {
  type?: ElementType
  data?: Record<string, unknown>
}

/** Defaults, mirroring Excalidraw's look. */
export const DEFAULT_ELEMENT: Record<keyof Omit<SceneElement, 'type' | 'data'>, unknown> = {
  id: '',
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  stroke_color: '#1e1e1e',
  background_color: 'transparent',
  stroke_width: 2,
  stroke_style: 'solid',
  fill_style: 'hachure',
  roughness: 1,
  opacity: 100,
  angle: 0,
  dash: undefined,
}

export function createElement<T extends SceneElement>(
  type: T['type'],
  input: Partial<Omit<T, 'type'>> = {},
  ctx: { idSeq?: () => string } = {},
): T {
  const id =
    input.id ||
    (ctx.idSeq
      ? ctx.idSeq()
      : `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
  const base: SceneElementBase = {
    id,
    type,
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: input.width ?? 0,
    height: input.height ?? 0,
    stroke_color: input.stroke_color ?? '#1e1e1e',
    background_color: input.background_color ?? 'transparent',
    stroke_width: input.stroke_width ?? 2,
    stroke_style: input.stroke_style ?? 'solid',
    fill_style: input.fill_style ?? 'hachure',
    roughness: input.roughness ?? 1,
    opacity: input.opacity ?? 100,
    angle: input.angle ?? 0,
    dash: input.dash as [number, number] | undefined,
  }
  const { id: _inputId, ...rest } = input
  return { ...base, ...rest, type } as T
}

export function blankScene(name = 'untitled', width = 2400, height = 1600): Scene {
  return { name, width, height, background_color: '#ffffff', paper: true, elements: [] }
}
