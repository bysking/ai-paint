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
  /**
   * 默认连线类型（未在单条 link 上指定 type 时使用）。
   * 支持 orthogonal / bezier / smooth / arc / straight —— 曲线只会在层框之间的
   * 空隙里弯曲，不会穿过或贴着层框边框。
   */
  linkType?: EdgeType
}

const DEF: Required<ArchOptions> = {
  padding: 60,
  // 层间距需要容纳「跨层连线的水平转向段」：连线要在两层框之间的通道里拐弯，
  // 通道太窄会导致正交路由找不到位置、退回贴边或斜穿。96 是实测的舒适值。
  layerGap: 96,
  moduleGap: 24,
  linkType: 'orthogonal' as EdgeType,
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
  const { padding, layerGap, moduleGap, headerHeight, moduleWidth, moduleHeight, linkType } = { ...DEF, ...opts }

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

  // 层框内边距（独立于 moduleGap）：
  //   H = 模块与层框左右边；V = 模块与层框上下边。
  // 垂直内边距要比水平小，否则层框显得臃肿；但又要容纳「出线 + END_GAP」。
  const modulePadH = 40
  const modulePadV = 28

  // 层框宽度按【各自内容】决定，而不是所有层统一取最宽层。
  // 统一宽度会让模块少的层出现大片空白（5 模块层和 3 模块层同宽时，
  // 后者两侧各有 170px+ 的空区），整张图看起来松散。
  // 各层按画布中线居中，视觉上仍然是整齐的分层结构。
  const canvasContentW = maxContentW
  const layerWidths = contentWList.map((w) => Math.max(w + modulePadH * 2, 200))

  let totalH = 0
  let y = padding
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li]
    const mods = layer.modules
    const contentW = contentWList[li]
    const layerW = layerWidths[li]
    // 层框高度 = 标题栏 + 模块高 + 模块上下内边距（垂直内边距独立于水平 moduleGap）
    const layerH = headerHeight + moduleHeight + modulePadV * 2

    // 层框在画布上居中；模块在该层框内居中
    const layerX = padding + (canvasContentW + modulePadH * 2 - layerW) / 2
    // 相邻层模块数相同时，网格会完全对齐 —— 上一层的 x 中心正好落在下一层的
    // x 中心上，导致「上一层的出线」与「下一层的入线」共用同一条垂直线段而重叠
    // （实测 中间件层 与 数据层 完全重合，重叠 172px）。
    // 给奇数层叠加半个模块间距的错位，让相邻层的网格自然交错。
    const stagger = li % 2 === 1 ? moduleGap / 2 : 0
    const startX = layerX + (layerW - contentW) / 2 + stagger
    let mx = startX
    for (const m of mods) {
      moduleRects.set(m.key, { x: mx, y: y + headerHeight + modulePadV, width: moduleWidth, height: moduleHeight })
      moduleFill.set(m.key, m.fill ?? layer.fill ?? '#ffffff')
      moduleLayer.set(m.key, layer.key)
      mx += moduleWidth + moduleGap
    }

    layerRects.set(layer.key, {
      x: layerX,
      y,
      width: layerW,
      height: layerH,
    })
    y += layerH + layerGap
    totalH = y - layerGap
  }

  // 画布宽度 = 最宽层 + 两侧留白
  const width = canvasContentW + modulePadH * 2 + padding * 2
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
      type: l.type ?? linkType,
      dashed: l.dashed ?? false,
      label: l.label,
      arrow: 'triangle',
    })),
    { minBends: 1 }, // 架构图：非对齐连线强制 ≥3 段正交路由（U 型）
  )
  const routedMap = new Map(bundle.edges.map((e) => [`${e.from}->${e.to}`, e]))

  const outLinks = links.map((l) => {
    const t = (l.type ?? linkType) as EdgeType
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
