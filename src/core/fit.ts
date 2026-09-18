/**
 * 场景内容自适应：计算所有元素的外接盒，把内容平移到画布中心。
 *
 * 所有图表工具在“清空场景 + 重新绘制”后会调用 fitSceneContent：
 *   - 画布尺寸 = 内容尺寸 + 2×padding（不再依赖旧的 Math.max 累加逻辑）
 *   - 所有元素坐标平移，使内容恰好水平 / 垂直居中
 */

import type { Scene, SceneElement } from './scene.js'

export interface FitOptions {
  /** 内容四周留白。默认 60。 */
  padding?: number
  /** 最小画布宽。默认 2400。 */
  minWidth?: number
  /** 最小画布高。默认 1600。 */
  minHeight?: number
}

/** 元素内容外接盒（不含画布背景 rect）。 */
export function contentBounds(scene: Scene): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of scene.elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
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
  const minWidth = opts.minWidth ?? 2400
  const minHeight = opts.minHeight ?? 1600
  const bounds = contentBounds(scene)
  if (!bounds) return { width: minWidth, height: minHeight, dx: 0, dy: 0 }

  const cw = Math.max(bounds.maxX - bounds.minX, 0)
  const ch = Math.max(bounds.maxY - bounds.minY, 0)
  // 画布 = 内容 + 留白，不足最小画布时用最小画布（保证大图起点）
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
