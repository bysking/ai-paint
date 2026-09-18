/**
 * 架构图（architecture diagram）生成器。
 *
 * 布局特点（自上而下分层）：
 *   - 每一层是一个"大框"（frame），有自己的标题与配色
 *   - 每层包含多个子模块（小盒子），层内水平排布、水平居中
 *   - 跨层连线（模块间依赖）默认走【正交路由】避障
 *   - 整体垂直布局：层与层之间留白，模块连接受层边界约束
 *
 * 输出：层框坐标 + 子模块坐标 + 跨层关系（供工具层绘制 frame / shape / edge）。
 */

import type { ConnectorNode } from './connectors.js'
import { routeEdgeBundle, type EdgeType } from './edge-bundle.js'

export interface ArchLayer {
  /** 层 key（唯一）。 */
  key: string
  /** 层标题。 */
  label: string
  /** 层背景色（hex）。 */
  fill?: string
  /** 层内子模块。 */
  modules: { key: string; label: string; fill?: string }[]
}

export interface ArchLink {
  from: string
  to: string
  label?: string
  /** 连线类型，默认 orthogonal。 */
  type?: EdgeType
  dashed?: boolean
}

export interface ArchDiagram {
  width: number
  height: number
  /** 层框（含内部子模块布局）。 */
  layers: Record<
    string,
    {
      key: string
      label: string
      fill: string
      x: number
      y: number
      width: number
      height: number
      modules: Record<string, { x: number; y: number; width: number; height: number; fill: string }>
    }
  >
  /** 跨层关系（正交路由后的路径点）。 */
  links: {
    from: string
    to: string
    label?: string
    /** undefined = 未指定（工具层默认虚线）；false = 显式实线。 */
    dashed?: boolean
    type: EdgeType
    points: { x: number; y: number }[]
  }[]
}

export interface ArchOptions {
  padding?: number
  layerGap?: number
  moduleGap?: number
  headerHeight?: number
  moduleWidth?: number
  moduleHeight?: number
}

const DEF: Required<ArchOptions> = {
  padding: 60,
  layerGap: 70,
  moduleGap: 24,
  headerHeight: 40,
  moduleWidth: 170,
  moduleHeight: 56,
}

/** 层默认配色（柔和糖果色）。 */
export const ARCH_PALETTE = ['#ffd8a8', '#b2f2bb', '#a5d8ff', '#ffc9c9', '#d0bfff', '#ffec99', '#c3fae8', '#f1f3f5']

/**
 * 计算架构图布局：
 * 1) 每层子模块水平排布（moduleGap 间隔），层宽 = 内容宽 + 内边距
 * 2) 层框自上而下堆叠（layerGap 间隔），各层左对齐（按最宽层居中可选——这里统一左对齐 + 居中到画布）
 * 3) 跨层关系正交路由，障碍 = 所有子模块（排除 from/to 所在层内同层模块? 仅排除端点模块自身）
 */
export function planArchitectureDiagram(
  layers: ArchLayer[],
  links: ArchLink[],
  opts: ArchOptions = {},
): ArchDiagram {
  const { padding, layerGap, moduleGap, headerHeight, moduleWidth, moduleHeight } = { ...DEF, ...opts }

  // ---- 1. 每层内部布局 ----
  const layerRects = new Map<string, { x: number; y: number; width: number; height: number }>()
  const moduleRects = new Map<string, { x: number; y: number; width: number; height: number }>()
  const moduleFill = new Map<string, string>()
  const moduleLayer = new Map<string, string>()

  // 先计算每层内容宽度，取最宽层作为所有层的统一宽度（层内模块水平居中）
  const contentWList = layers.map((layer) =>
    layer.modules.length > 0
      ? layer.modules.reduce((acc) => acc + moduleWidth, 0) + moduleGap * (layer.modules.length - 1)
      : 0,
  )
  const maxContentW = Math.max(...contentWList, 0)
  // 层宽统一 = 最宽内容 + 内边距（各层左右对齐居中到画布）
  const layerW = Math.max(maxContentW + moduleGap * 2, 160)

  let totalH = 0
  let y = padding
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li]
    const mods = layer.modules
    const contentW = contentWList[li]
    const layerH = headerHeight + moduleHeight + moduleGap * 2

    // 层内模块排布：水平居中（同一水平线上）
    const startX = padding + (layerW - contentW) / 2
    let mx = startX
    for (const m of mods) {
      moduleRects.set(m.key, { x: mx, y: y + headerHeight + moduleGap, width: moduleWidth, height: moduleHeight })
      moduleFill.set(m.key, m.fill ?? layer.fill ?? '#ffffff')
      moduleLayer.set(m.key, layer.key)
      mx += moduleWidth + moduleGap
    }

    layerRects.set(layer.key, {
      x: padding,
      y,
      width: layerW,
      height: layerH,
    })
    y += layerH + layerGap
    totalH = y - layerGap
  }

  // 画布宽度 = 统一层宽
  const width = layerW + padding * 2
  const height = totalH + padding

  // ---- 2. 跨层关系正交路由 ----
  const nodeMap = new Map<string, ConnectorNode>()
  for (const [k, r] of moduleRects) {
    nodeMap.set(k, { key: k, shape: 'rectangle', x: r.x, y: r.y, width: r.width, height: r.height })
  }
  const bundle = routeEdgeBundle(
    nodeMap,
    links.map((l) => ({
      from: l.from,
      to: l.to,
      type: l.type ?? 'orthogonal',
      dashed: l.dashed ?? false,
      label: l.label,
      arrow: 'triangle',
    })),
    { minBends: 1 }, // 架构图：非对齐连线强制 ≥3 段正交路由（U 型）
  )
  const routedMap = new Map(bundle.edges.map((e) => [`${e.from}->${e.to}`, e]))

  const outLinks = links.map((l) => {
    const t = (l.type ?? 'orthogonal') as EdgeType
    const routed = routedMap.get(`${l.from}->${l.to}`)
    return {
      from: l.from,
      to: l.to,
      label: l.label,
      // 保留用户原值：undefined = 未指定（工具层默认虚线），false = 显式实线
      dashed: l.dashed,
      type: t,
      points: routed?.points ?? [],
    }
  })

  // ---- 3. 组装输出 ----
  const layersOut: ArchDiagram['layers'] = {}
  const paletteIdx = { i: 0 }
  for (const layer of layers) {
    const lr = layerRects.get(layer.key)!
    const fill = layer.fill ?? ARCH_PALETTE[paletteIdx.i++ % ARCH_PALETTE.length]
    const modsOut: ArchDiagram['layers'][string]['modules'] = {}
    for (const m of layer.modules) {
      const mr = moduleRects.get(m.key)!
      modsOut[m.key] = { ...mr, fill: moduleFill.get(m.key) ?? '#ffffff' }
    }
    layersOut[layer.key] = { ...lr, key: layer.key, label: layer.label, fill, modules: modsOut }
  }

  return { width, height, layers: layersOut, links: outLinks }
}
