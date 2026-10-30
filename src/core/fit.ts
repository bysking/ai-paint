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

/**
 * 场景内容外接盒（不含画布背景 rect），**包含连线的真实路径**。
 *
 * 连线是图形的一部分：回边会绕到节点包围盒外侧很远，贝塞尔/弧线也会外扩。
 * 只统计元素矩形会让外接盒偏小，导致四周留白不均（实测左边距 0、右边距 10）。
 *
 * edge 的路径必须用「与渲染完全相同的路由」来算（routeSceneEdges），
 * 不能读 data.points —— 那是布局期的坐标，渲染时会重新路由，两者对不上。
 */
export function contentBounds(scene: Scene): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of scene.elements) {
    // edge 元素的 x/y/width/height 恒为 0（或平移后的残留值），
    // 它的真实几何由两端节点决定，渲染时才算出 —— 不能用自身矩形参与边界，
    // 否则平移后 edge.x 变成 dx，会被误当成内容左边界。
    if (el.type !== 'edge') {
      minX = Math.min(minX, el.x)
      minY = Math.min(minY, el.y)
      maxX = Math.max(maxX, el.x + el.width)
      maxY = Math.max(maxY, el.y + el.height)
    }

    // 独立折线（line/arrow/draw）：路径点就在 data.points
    if (el.type === 'line' || el.type === 'arrow' || el.type === 'draw') {
      const pts = (el.data as { points?: unknown } | undefined)?.points
      if (Array.isArray(pts)) {
        for (const p of pts) {
          if (Array.isArray(p) && p.length >= 2) {
            const px = Number(p[0])
            const py = Number(p[1])
            if (Number.isFinite(px) && Number.isFinite(py)) {
              minX = Math.min(minX, px)
              minY = Math.min(minY, py)
              maxX = Math.max(maxX, px)
              maxY = Math.max(maxY, py)
            }
          }
        }
      }
    }
  }

  // 连线（edge）：用真实路由结果参与边界计算。
  // 直接从 pathD 里抽出所有坐标 —— 直线/贝塞尔控制点/圆弧端点都在里面，
  // 这样不论哪种连线类型都不会漏算外扩部分。
  const hasEdge = scene.elements.some((el) => el.type === 'edge')
  if (hasEdge) {
    try {
      const { routedEdges } = routeSceneEdges(scene)
      const PAD = 12 // 箭头/线宽余量
      for (const { routed } of routedEdges) {
        for (const p of routed.points) {
          minX = Math.min(minX, p.x)
          minY = Math.min(minY, p.y)
          maxX = Math.max(maxX, p.x)
          maxY = Math.max(maxY, p.y)
        }
        // 解析 pathD 中的坐标对。
        // 注意不能简单抓「两个连续数字」—— 圆弧命令 A rx ry rot largeArc sweep x y
        // 里也有数字对（如 "A 18 18 0 0 1 160 178"），会把 rx/ry、largeArc/sweep
        // 误当成坐标（产生假的 x=0）。
        // 这里按命令逐段解析，只取真正的端点/控制点。
        for (const m of routed.pathD.matchAll(/([MLCA])([^MLCA]*)/g)) {
          const cmd = m[1]
          const nums = (m[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite)
          let pairs: [number, number][] = []
          if (cmd === 'A') {
            // A rx ry rot largeArc sweep x y —— 只取最后两个
            if (nums.length >= 7) pairs = [[nums[nums.length - 2], nums[nums.length - 1]]]
          } else {
            for (let i = 0; i + 1 < nums.length; i += 2) pairs.push([nums[i], nums[i + 1]])
          }
          for (const [px, py] of pairs) {
            minX = Math.min(minX, px)
            minY = Math.min(minY, py)
            maxX = Math.max(maxX, px)
            maxY = Math.max(maxY, py)
          }
        }
        minX = Math.min(minX, routed.arrowTip.x - PAD)
        maxX = Math.max(maxX, routed.arrowTip.x + PAD)
        minY = Math.min(minY, routed.arrowTip.y - PAD)
        maxY = Math.max(maxY, routed.arrowTip.y + PAD)
      }
    } catch {
      /* 路由失败时退回只算元素矩形 */
    }
  }

  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
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
