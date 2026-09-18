/**
 * ts-svg — 内置的 TypeScript SVG 构建器（等价实现）。
 *
 * npm 上的 `ts-svg` 包目前是 "Coming soon" 空包（v0.0.0，无法安装），因此本项目
 * 内置一个功能等价、类型安全、零依赖的 SVG 构建器模块，供渲染层与用户 API 使用。
 *
 * 用法：
 *   Svg.doc(800, 600, '#fff', Svg.g({}, [
 *     Svg.line(0, 0, 100, 100, { stroke: '#000' }),
 *     Svg.text(50, 50, 'hi', { 'font-size': 16 }),
 *   ]))
 */

export type SvgAttrs = Record<string, string | number | undefined>

/** 数值格式化为紧凑字符串（最多保留 2 位小数）。 */
export function fmt(v: number, digits = 2): string {
  const q = 10 ** digits
  const r = Math.round(v * q) / q
  return Object.is(r, -0) ? '0' : String(r)
}

function attrString(attrs?: SvgAttrs): string {
  if (!attrs) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${k}="${String(v)}"`)
  }
  return parts.length ? ' ' + parts.join(' ') : ''
}

export function escapeXml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return c
    }
  })
}

export interface SvgPoint {
  x: number
  y: number
}

export const Svg = {
  /** 任意元素（用于 defs 等）。 */
  el(tag: string, attrs?: SvgAttrs, children?: string[]): string {
    const open = `<${tag}${attrString(attrs)}`
    if (!children || children.length === 0) return `${open}/>`
    return `${open}>${children.join('')}</${tag}>`
  },

  g(attrs: SvgAttrs, children: string[]): string {
    return `<g${attrString(attrs)}>${children.join('')}</g>`
  },

  line(x1: number, y1: number, x2: number, y2: number, attrs?: SvgAttrs): string {
    return this.el('line', {
      x1: fmt(x1), y1: fmt(y1), x2: fmt(x2), y2: fmt(y2), ...attrs,
    })
  },

  path(d: string, attrs?: SvgAttrs): string {
    return this.el('path', { d, ...attrs })
  },

  polyline(points: SvgPoint[], attrs?: SvgAttrs): string {
    return this.el('polyline', {
      points: points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' '),
      ...attrs,
    })
  },

  polygon(points: SvgPoint[], attrs?: SvgAttrs): string {
    return this.el('polygon', {
      points: points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' '),
      ...attrs,
    })
  },

  rect(x: number, y: number, w: number, h: number, attrs?: SvgAttrs): string {
    return this.el('rect', { x: fmt(x), y: fmt(y), width: fmt(w), height: fmt(h), ...attrs })
  },

  ellipse(cx: number, cy: number, rx: number, ry: number, attrs?: SvgAttrs): string {
    return this.el('ellipse', { cx: fmt(cx), cy: fmt(cy), rx: fmt(rx), ry: fmt(ry), ...attrs })
  },

  text(x: number, y: number, content: string, attrs?: SvgAttrs): string {
    return this.el('text', { x: fmt(x), y: fmt(y), ...attrs }, [escapeXml(content)])
  },

  tspan(x: number, dy: number, content: string, attrs?: SvgAttrs): string {
    return this.el('tspan', { x: fmt(x), dy: fmt(dy), ...attrs }, [escapeXml(content)])
  },

  /**
   * 构建完整 SVG 文档。
   * @param width  逻辑宽度
   * @param height 逻辑高度
   * @param body   画布主体子元素
   * @param defs   可选的 <defs> 内容（渐变、marker 等）
   * @param opts   背景色、字体族、附加 viewBox（不传则用 0 0 w h）
   */
  doc(
    width: number,
    height: number,
    body: string[],
    opts: { background?: string; defs?: string; fontFamily?: string; viewBox?: string } = {},
  ): string {
    const parts: string[] = []
    const vb = opts.viewBox ?? `0 0 ${fmt(width, 0)} ${fmt(height, 0)}`
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width, 0)}" height="${fmt(height, 0)}" viewBox="${vb}" font-family="${opts.fontFamily ?? "'Virgil','Segoe Print','Comic Sans MS','Comic Sans',cursive,sans-serif"}">`,
    )
    if (opts.defs) parts.push(`<defs>${opts.defs}</defs>`)
    if (opts.background) parts.push(this.rect(0, 0, width, height, { fill: opts.background }))
    parts.push(...body)
    parts.push(`</svg>`)
    return parts.join('\n')
  },
}

/** 常见颜色工具：hex → rgba 字符串。 */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}
