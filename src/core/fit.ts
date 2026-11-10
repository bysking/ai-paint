/**
 * 场景内容自适应：计算所有元素的外接盒，把内容平移到画布中心。
 *
 * 所有图表工具在“清空场景 + 重新绘制”后会调用 fitSceneContent：
 *   - 画布尺寸 = 内容尺寸 + 2×padding（不再依赖旧的 Math.max 累加逻辑）
 *   - 所有元素坐标平移，使内容恰好水平 / 垂直居中
 */

import type { Scene, SceneElement } from './scene.js'
import { routeSceneEdges } from './render.js'

export interface FitOptions {
  /** 内容四周留白。默认 60。 */
  padding?: number
  /** 最小画布宽。默认 320（仅为极端小图兜底，不再强制撑到大画布）。 */
  minWidth?: number
  /** 最小画布高。默认 240。 */
  minHeight?: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 内容越过画布四边的距离（正数 = 超出多少 px，负数 = 该边剩余留白）。 */
export interface SceneOverflow {
  left: number
  top: number
  right: number
  bottom: number
  /** 四边都未越界时为 false。 */
  overflow: boolean
  /** 越界的元素 id（用于告警，指明是谁跑出了画布）。 */
  elements: string[]
  bounds: Bounds
}

/**
 * 折线点集（line / arrow / draw）：路径点就在 data.points（场景坐标）。
 * 返回其外接盒；不是折线或点非法时返回 null。
 */
function pointsBounds(el: SceneElement): Bounds | null {
  if (el.type !== 'line' && el.type !== 'arrow' && el.type !== 'draw') return null
  const pts = (el.data as { points?: unknown } | undefined)?.points
  if (!Array.isArray(pts)) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 2) continue
    const px = Number(p[0])
    const py = Number(p[1])
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue
    minX = Math.min(minX, px)
    minY = Math.min(minY, py)
    maxX = Math.max(maxX, px)
    maxY = Math.max(maxY, py)
  }
  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

/** 合并两个外接盒（任一为 null 时返回另一个）。 */
function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b
  if (!b) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/** pathD 中所有真实坐标点（直线端点 / 贝塞尔控制点 / 圆弧终点）。 */
function pathBounds(pathD: string): Bounds | null {
  let b: Bounds | null = null
  const add = (px: number, py: number) => {
    if (!Number.isFinite(px) || !Number.isFinite(py)) return
    b = b
      ? { minX: Math.min(b.minX, px), minY: Math.min(b.minY, py), maxX: Math.max(b.maxX, px), maxY: Math.max(b.maxY, py) }
      : { minX: px, minY: py, maxX: px, maxY: py }
  }
  // 按命令逐段解析。
  // 注意不能简单抓「两个连续数字」—— 圆弧命令 A rx ry rot largeArc sweep x y
  // 里也有数字对（如 "A 18 18 0 0 1 160 178"），会把 rx/ry、largeArc/sweep
  // 误当成坐标（产生假的 x=0）。
  for (const m of pathD.matchAll(/([MLCA])([^MLCA]*)/g)) {
    const cmd = m[1]
    const nums = (m[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite)
    if (cmd === 'A') {
      // A rx ry rot largeArc sweep x y —— 只取最后两个
      if (nums.length >= 7) add(nums[nums.length - 2], nums[nums.length - 1])
      continue
    }
    for (let i = 0; i + 1 < nums.length; i += 2) add(nums[i], nums[i + 1])
  }
  return b
}

/**
 * 每个元素自己的外接盒（含连线的真实路由，含折线的点集）。
 *
 * 用于精确判断「谁越出了画布」。edge 的 x/y/width/height 恒为 0（或平移后残留），
 * 其真实几何必须由渲染同款路由算出，否则会拿 0 当作边界、误判越界。
 */
export function elementBounds(scene: Scene): Map<string, Bounds> {
  const out = new Map<string, Bounds>()
  const edgeEls = scene.elements.filter((el) => el.type === 'edge')
  let routedByEl = new Map<SceneElement, { points: { x: number; y: number }[]; pathD: string; arrowTip: { x: number; y: number } }>()
  if (edgeEls.length > 0) {
    try {
      const { routedEdges } = routeSceneEdges(scene)
      routedByEl = new Map(routedEdges.map(({ el, routed }) => [el, routed]))
    } catch {
      /* 路由失败时连线不参与越界判定（不影响其余元素） */
    }
  }
  const PAD = 12 // 箭头/线宽余量
  // 边标签的真实绘制位置：渲染层会围绕锚点做防重叠偏移（见 routeSceneEdges），
  // 长标签常被推到右侧走廊外（实测 x 到 337 而画布只有 388 宽）。
  // 标签不是独立元素，光算路径会漏掉它，导出时就被裁掉半个字。
  const labelBoxes = new Map<string, Bounds>()
  if (edgeEls.length > 0) {
    try {
      const { labelPlacements } = routeSceneEdges(scene)
      for (const [id, lp] of labelPlacements) {
        const w = Math.min(160, lp.text.length * 7.5 + 12)
        labelBoxes.set(id, { minX: lp.x, minY: lp.y - 13, maxX: lp.x + w, maxY: lp.y + 5 })
      }
    } catch {
      /* 标签定位失败时只算路径 */
    }
  }
  for (const el of scene.elements) {
    if (el.type === 'edge') {
      const routed = routedByEl.get(el)
      if (!routed) continue
      let b = pathBounds(routed.pathD)
      for (const p of routed.points) b = unionBounds(b, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y })
      b = unionBounds(b, {
        minX: routed.arrowTip.x - PAD,
        minY: routed.arrowTip.y - PAD,
        maxX: routed.arrowTip.x + PAD,
        maxY: routed.arrowTip.y + PAD,
      })
      b = unionBounds(b, labelBoxes.get(el.id) ?? null)
      if (b) out.set(el.id, b)
      continue
    }
    const box: Bounds = { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height }
    out.set(el.id, unionBounds(box, pointsBounds(el)) ?? box)
  }
  return out
}

/**
 * 场景内容外接盒（不含画布背景 rect），**包含连线的真实路径**。
 *
 * 连线是图形的一部分：回边会绕到节点包围盒外侧很远，贝塞尔/弧线也会外扩。
 * 只统计元素矩形会让外接盒偏小，导致四周留白不均（实测左边距 0、右边距 10）。
 *
 * edge 的路径必须用「与渲染完全相同的路由」来算（routeSceneEdges），
 * 不能读 data.points —— 那是布局期的坐标，渲染时会重新路由，两者对不上。
 */
export function contentBounds(scene: Scene): Bounds | null {
  let b: Bounds | null = null
  for (const box of elementBounds(scene).values()) b = unionBounds(b, box)
  return b
}

/**
 * 检测内容是否越出画布（导出前的「越界守卫」）。
 *
 * export_scene 严格按 scene.width/height 作为 viewBox 渲染，落在画布外的元素
 * 会被**静默裁掉**——白图不报错、不提示。这里提前量出四边超出量，
 * 让调用方要么自动扩画布（autoFit），要么在结果里拿到明确告警。
 */
export function detectOverflow(scene: Scene): SceneOverflow {
  const empty: SceneOverflow = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    overflow: false,
    elements: [],
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  }
  let union: Bounds | null = null
  const outside: string[] = []
  for (const [id, b] of elementBounds(scene)) {
    union = unionBounds(union, b)
    if (b.minX < -0.5 || b.minY < -0.5 || b.maxX > scene.width + 0.5 || b.maxY > scene.height + 0.5) {
      outside.push(id)
    }
  }
  if (!union) return empty
  const res: SceneOverflow = {
    left: Math.max(0, -union.minX),
    top: Math.max(0, -union.minY),
    right: Math.max(0, union.maxX - scene.width),
    bottom: Math.max(0, union.maxY - scene.height),
    overflow: false,
    elements: outside,
    bounds: union,
  }
  res.overflow = res.left > 0.5 || res.top > 0.5 || res.right > 0.5 || res.bottom > 0.5
  return res
}

/**
 * 只扩不缩：把画布撑到刚好包住全部内容（含连线路径）。
 *
 * 与 fitSceneContent 的区别 —— 后者会把内容**平移**到画布中心（会改动坐标，
 * 因此必须在绘制/返回坐标之前调用）；本函数**不动任何元素坐标**，
 * 只改 scene.width/height，适合导出前补画布。
 *
 * @returns 是否发生了扩边，以及扩边后的尺寸
 */
export function expandSceneToContent(
  scene: Scene,
  opts: { padding?: number; minWidth?: number; minHeight?: number } = {},
): { expanded: boolean; width: number; height: number; overflow: SceneOverflow } {
  const padding = opts.padding ?? 0
  const before = detectOverflow(scene)
  if (!before.overflow) {
    return { expanded: false, width: scene.width, height: scene.height, overflow: before }
  }
  const b = before.bounds
  // 内容有负坐标时，扩边并不能让元素落回画布 —— 需要平移，交给 fitSceneContent。
  // 这里只处理「右下越界」这一最常见情形，并保证左上留白不被改成负数。
  const width = Math.max(scene.width, Math.ceil(b.maxX + padding), opts.minWidth ?? 0)
  const height = Math.max(scene.height, Math.ceil(b.maxY + padding), opts.minHeight ?? 0)
  const expanded = width > scene.width || height > scene.height
  if (expanded) {
    scene.width = width
    scene.height = height
  }
  return { expanded, width, height, overflow: before }
}

/**
 * 把场景内容平移并缩放到画布中心。
 * 返回新的画布尺寸与平移量；调用方可直接写入 scene.width / scene.height。
 */
export function fitSceneContent(
  scene: Scene,
  opts: FitOptions = {},
): { width: number; height: number; dx: number; dy: number } {
  const padding = opts.padding ?? 60
  const minWidth = opts.minWidth ?? 320
  const minHeight = opts.minHeight ?? 240
  const bounds = contentBounds(scene)
  if (!bounds) return { width: minWidth, height: minHeight, dx: 0, dy: 0 }

  const cw = Math.max(bounds.maxX - bounds.minX, 0)
  const ch = Math.max(bounds.maxY - bounds.minY, 0)
  // 画布 = 内容 + 留白。最小尺寸只用于兜底极端小图（例如只有一个节点），
  // 不再强制放大到固定大画布 —— 那会让小图产生大量空白（实测 ER 图填充率仅 1.7%）。
  const width = Math.max(minWidth, cw + padding * 2)
  const height = Math.max(minHeight, ch + padding * 2)

  const dx = (width - cw) / 2 - bounds.minX
  const dy = (height - ch) / 2 - bounds.minY

  for (const el of scene.elements) {
    el.x += dx
    el.y += dy
    // line / arrow / draw 的坐标实际存在 data.points（scene 坐标），需要一并平移
    if (el.type === 'line' || el.type === 'arrow' || el.type === 'draw') {
      el.data = {
        ...(el.data ?? {}),
        points: (el.data?.points ?? []).map(([px, py]) => [px + dx, py + dy]),
      }
    }
  }
  return { width, height, dx, dy }
}

/** 便捷：对场景应用居中并更新其尺寸字段。 */
export function centerScene(scene: Scene, opts?: FitOptions): Scene {
  const { width, height } = fitSceneContent(scene, opts)
  scene.width = width
  scene.height = height
  return scene
}

/** 平移一个元素的坐标（供外部精确调整时使用）。 */
export function translateElement(el: SceneElement, dx: number, dy: number): void {
  el.x += dx
  el.y += dy
  if (el.type === 'line' || el.type === 'arrow' || el.type === 'draw') {
    el.data = {
      ...(el.data ?? {}),
      points: (el.data?.points ?? []).map(([px, py]) => [px + dx, py + dy]),
    }
  }
}
