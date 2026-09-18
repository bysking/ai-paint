/**
 * Shared input validation / normalization helpers for drawing tools.
 */

export function clampNum(v: unknown, name: string, min: number, max: number, def: number): number {
  const n = typeof v === 'number' && !Number.isNaN(v) ? v : def
  return Math.max(min, Math.min(max, n))
}

export function intNum(v: unknown, name: string, min: number, max: number, def: number): number {
  return Math.round(clampNum(v, name, min, max, def))
}

export function str(v: unknown, def = ''): string {
  return typeof v === 'string' ? v : def
}

/**
 * 文本安全化：移除渲染层字体（手写体 + sans-serif）不支持的字符。
 * 只保留：
 *   - ASCII 可打印（0x20–0x7E）
 *   - CJK 统一表意文字 / 扩展 A（汉字）
 *   - 常用 CJK 标点（、。『』「」《》【】（）—…等）
 *   - 全角标点（FF00–FFEF）
 * emoji、箭头、数学符号、带圈字符等会渲染成豆腐块/问号，一律剔除。
 * 注意：换行保留（renderText 按 \n 分行）。
 */
export function safeText(v: unknown, def = ''): string {
  const s = str(v, def)
  return [...s]
    .filter((ch) => {
      if (ch === '\n') return true
      const c = ch.codePointAt(0)!
      // ASCII 可打印
      if (c >= 0x20 && c <= 0x7e) return true
      // CJK 统一表意 + 扩展 A
      if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) return true
      // CJK 标点/全角
      if (c >= 0x3000 && c <= 0x303f) return true
      if (c >= 0xff00 && c <= 0xffef) return true
      // 常用补充标点：破折号、省略号、弯引号
      if (c === 0x2014 || c === 0x2026 || c === 0x2018 || c === 0x2019 || c === 0x201c || c === 0x201d) return true
      // 常用数学/排版符号：sans-serif 回退字体普遍支持，且不会渲染成豆腐块
      if (c === 0x2265 || c === 0x2264 || c === 0x2260 || c === 0x00d7 || c === 0x00f7 || c === 0x221a || c === 0x00b7 || c === 0x00b1) return true
      return false
    })
    .join('')
}

/** 估算字符串在指定字号（px）下的渲染宽度。CJK 按全角 ≈1em，ASCII 按半角 ≈0.55em。 */
export function textWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    if (ch === '\n') continue
    const c = ch.codePointAt(0) ?? 0
    const cjk = c >= 0x3000 && c <= 0x9fff // CJK 标点 + 汉字统一表意
    const wide = cjk || c === 0x2014 || c === 0x2026 || c === 0xff0c || c === 0xff1a
    w += wide ? 1 : 0.55
  }
  return Math.ceil(w * fontSize)
}

export function bool(v: unknown, def = false): boolean {
  return typeof v === 'boolean' ? v : def
}

/** Normalize a hex color (#rgb/#rgba/#rrggbb/#rrggbbaa) or pass through css colors. */
export function color(v: unknown, def = ''): string {
  const s = str(v, def).trim()
  if (s === 'transparent' || s === 'none') return 'transparent'
  if (s.startsWith('#')) {
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s
    return def
  }
  // named colors / rgb() / hsl() passthrough
  if (/^[a-zA-Z]+$/.test(s) || /^(rgb|rgba|hsl|hsla)\(/.test(s)) return s
  return def
}

export function strokeStyle(v: unknown): 'solid' | 'dashed' | 'dotted' {
  const s = str(v, 'solid')
  return s === 'dashed' || s === 'dotted' ? s : 'solid'
}

export function fillStyle(v: unknown): 'hachure' | 'cross-hatch' | 'solid' | 'none' {
  const s = str(v, 'hachure')
  if (s === 'solid' || s === 'cross-hatch' || s === 'none') return s
  return 'hachure'
}

/** Normalize a points array [[x,y],...] into a number[][]. */
export function points(v: unknown): [number, number][] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error('points must be a non-empty array of [x, y] pairs')
  }
  const out: [number, number][] = []
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2) {
      throw new Error(`invalid point: ${JSON.stringify(p)} (expected [x, y])`)
    }
    const x = Number(p[0])
    const y = Number(p[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`invalid point: ${JSON.stringify(p)}`)
    }
    out.push([x, y])
  }
  return out
}

export function angleRad(v: unknown, def = 0): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def
  return n
}
