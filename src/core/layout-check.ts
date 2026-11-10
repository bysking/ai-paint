/**
 * 布局优化 / 检测环节（drawing 前的质量闸门）。
 *
 * 背景：AI 生成节点后直接绘制 → 问题往往在导出时才暴露（且是「白图」式的
 * 静默失败）：
 *   1. 节点重叠 / 间距被压成 0（显式尺寸过大、环回退、非 dagre 布局）
 *   2. 连线斜穿非端点节点（布局给出的分层顺序和边语义冲突）
 *   3. 内容外接盒（含回边走廊）超出画布 —— 导出时被 viewBox 裁掉
 *   4. 孤立节点散落在离主干很远的位置，整图被拉高拉宽
 *
 * 本模块在「布局完成、开始绘制」之间插入一步：
 *   analyze → repair（只做安全、可解释的修复）→ 复检 → 通过/不通过
 *
 * 修复策略刻意保守：**只动间距和画布尺寸，不动节点的相对次序**（次序是布局
 * 算法基于边关系算出来的，重排会破坏分层语义）。唯一会移动单个节点的是
 * 「末端孤立节点」的回收 —— 它没有任何边，位置本就无意义。
 */

import type { FinalPlan, NormalizedEdge } from './plan.js'
import type { Scene } from './scene.js'
import { detectOverflow, expandSceneToContent } from './fit.js'

export type IssueLevel = 'error' | 'warn'

export interface LayoutIssue {
  /** 问题类别（稳定标识，便于调用方按类别处理）。 */
  code:
    | 'node-overlap'
    | 'node-too-close'
    | 'edge-through-node'
    | 'content-overflow'
    | 'isolated-node'
    | 'label-overflow'
    | 'empty-nodes'
    | 'disconnected-graph'
  level: IssueLevel
  message: string
  /** 涉及的元素/节点 key（便于定位）。 */
  nodes?: string[]
  /** 定量信息（重叠面积、间隙 px、越界量等）。 */
  metric?: number
}

export interface LayoutCheckResult {
  /** 全部检查项通过（无 level=error 的遗留问题）。 */
  ok: boolean
  issues: LayoutIssue[]
  /** 实际执行的修复动作（便于调用方解释「为什么坐标和我给的不一样」）。 */
  repairs: string[]
  /** 修复后的画布尺寸。 */
  width: number
  height: number
  stats: {
    nodeCount: number
    edgeCount: number
    /** 内容填充率 = 内容面积 / 画布面积。过低说明留白过多。 */
    fillRatio: number
  }
}

export interface LayoutCheckOptions {
  /** 节点之间允许的最小间隙（px）。低于此值记为 node-too-close。 */
  minNodeGap?: number
  /** 自动修复开关（默认 true）。关掉时只检测、报告，不改任何坐标。 */
  repair?: boolean
  /** 画布四周留白（px）。默认 60，与绘制工具的居中留白保持一致。 */
  padding?: number
  /** 最大修复轮数（碰撞推挤迭代）。默认 4。 */
  maxRepairPasses?: number
  /** 内容填充率低于该值时告警（不修复）。默认 0.12。 */
  minFillRatio?: number
  /** 连线段是否穿越节点矩形的判定容差（px）。默认 4。 */
  edgeClearance?: number
}

const DEF: Required<Omit<LayoutCheckOptions, 'repair'>> & { repair: boolean } = {
  minNodeGap: 12,
  repair: true,
  padding: 60,
  maxRepairPasses: 4,
  minFillRatio: 0.12,
  edgeClearance: 4,
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function overlapArea(a: Rect, b: Rect): number {
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return ox > 0 && oy > 0 ? ox * oy : 0
}

/** 两矩形在主轴上的间隙（负数 = 重叠量）。轴取中心距较大的方向。 */
function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)
  const dy = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height)
  return Math.max(dx, dy)
}

/** 节点邻居表（无向），用于孤立节点 / 连通性判定。 */
function neighborMap(plan: FinalPlan): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  for (const k of Object.keys(plan.nodes)) m.set(k, new Set())
  for (const e of plan.edges) {
    if (e.from === e.to) continue
    m.get(e.from)?.add(e.to)
    m.get(e.to)?.add(e.from)
  }
  return m
}

/** 连线段是否穿过节点矩形内部（含 clearance 收缩，避免仅贴边就报警）。 */
function segmentHitsRect(
  p: { x: number; y: number },
  q: { x: number; y: number },
  r: Rect,
  clearance: number,
): boolean {
  const x0 = r.x + clearance
  const y0 = r.y + clearance
  const x1 = r.x + r.width - clearance
  const y1 = r.y + r.height - clearance
  if (x1 <= x0 || y1 <= y0) return false
  // 快速排除：线段包围盒与节点不相交
  if (Math.max(p.x, q.x) < x0 || Math.min(p.x, q.x) > x1) return false
  if (Math.max(p.y, q.y) < y0 || Math.min(p.y, q.y) > y1) return false
  // Liang–Barsky 线段裁剪：是否与矩形内部有交集
  let t0 = 0
  let t1 = 1
  const dx = q.x - p.x
  const dy = q.y - p.y
  const clip = (pv: number, qv: number): boolean => {
    if (Math.abs(pv) < 1e-9) return qv >= 0
    const t = qv / pv
    if (pv < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  if (!clip(-dx, p.x - x0)) return false
  if (!clip(dx, x1 - p.x)) return false
  if (!clip(-dy, p.y - y0)) return false
  if (!clip(dy, y1 - p.y)) return false
  return t1 - t0 > 1e-6
}

/**
 * 分轴推挤：把重叠或过近的节点沿「重叠更浅的那一轴」推开。
 *
 * 与 plan.resolveCollisions 的区别：那个是「往右下怼」的通用兜底，
 * 会把同层节点推成阶梯状；这里优先沿**浅重叠轴**推开 —— 同层节点横向
 * 轻微重叠就横推、跨层错位就纵推，视觉上保持原有网格结构。
 *
 * 判定用「按 gap/2 外扩后的矩形」：这样间隙不足 gap 的节点对也会被推开，
 * 与检查项的 node-too-close 口径一致（否则报告了问题却修不掉）。
 */
function separateAlongAxis(rects: Record<string, Rect>, order: string[], gap: number): number {
  const half = gap / 2
  let fixes = 0
  for (let pass = 0; pass < 6; pass++) {
    let moved = false
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = rects[order[i]]
        const b = rects[order[j]]
        if (!a || !b) continue
        // 外扩后仍不相交 = 间隙已 ≥ gap，无需处理
        const ox = Math.min(a.x + a.width, b.x + b.width) + gap - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.height, b.y + b.height) + gap - Math.max(a.y, b.y)
        if (ox <= 0 || oy <= 0) continue
        if (ox <= oy) {
          // 横向推开
          if (a.x + a.width / 2 <= b.x + b.width / 2) b.x = a.x + a.width + gap
          else a.x = b.x + b.width + gap
        } else if (a.y + a.height / 2 <= b.y + b.height / 2) {
          b.y = a.y + a.height + gap
        } else {
          a.y = b.y + b.height + gap
        }
        fixes++
        moved = true
      }
    }
    if (!moved) break
  }
  void half
  return fixes
}

/**
 * 布局检测 + 优化。**原地修改 plan.nodes**（repair=true 时），并返回检测报告。
 *
 * 调用位置：布局完成之后、drawFlowScene 之前。修复后返回的 plan 才是最终
 * 绘制数据，因此调用方拿到的坐标就是画布上的真实坐标。
 */
export function checkAndRepairLayout(
  plan: FinalPlan,
  edges: NormalizedEdge[],
  opts: LayoutCheckOptions = {},
): LayoutCheckResult {
  const o = { ...DEF, ...opts }
  const issues: LayoutIssue[] = []
  const repairs: string[] = []
  const order = plan.nodeList.map((n) => n.key).filter((k) => plan.nodes[k])
  const dir: 'TB' | 'LR' = plan.direction === 'LR' ? 'LR' : 'TB'

  if (order.length === 0) {
    return {
      ok: false,
      issues: [{ code: 'empty-nodes', level: 'error', message: '没有可布局的节点' }],
      repairs,
      width: plan.sceneWidth,
      height: plan.sceneHeight,
      stats: { nodeCount: 0, edgeCount: edges.length, fillRatio: 0 },
    }
  }

  const neighbors = neighborMap(plan)

  // ---- 1. 孤立节点（无任何边） ----
  // 它们没有位置语义，布局引擎常把它们甩到很远。先报告，修复阶段再回收。
  const isolated = order.filter((k) => (neighbors.get(k)?.size ?? 0) === 0)
  if (isolated.length > 0) {
    issues.push({
      code: 'isolated-node',
      level: isolated.length === order.length ? 'warn' : 'warn',
      message: `${isolated.length} 个节点没有任何连线：${isolated.slice(0, 6).join('、')}${isolated.length > 6 ? ' 等' : ''}`,
      nodes: isolated,
      metric: isolated.length,
    })
  }

  // ---- 2. 连通分量（边语义断裂的强信号） ----
  {
    const seen = new Set<string>()
    let components = 0
    for (const k of order) {
      if (seen.has(k)) continue
      components++
      const stack = [k]
      seen.add(k)
      while (stack.length) {
        const cur = stack.pop()!
        for (const nb of neighbors.get(cur) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb)
            stack.push(nb)
          }
        }
      }
    }
    if (components > 1 && components <= Math.max(2, Math.ceil(order.length / 3))) {
      issues.push({
        code: 'disconnected-graph',
        level: 'warn',
        message: `图分成 ${components} 个互不连通的子图（可能是 edges 里有写错的 source/target）`,
        metric: components,
      })
    }
  }

  // ---- 3. 节点重叠 / 间距过小 ----
  const collectSpacing = (): { overlaps: number; tooClose: number } => {
    let overlaps = 0
    let tooClose = 0
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = plan.nodes[order[i]]
        const b = plan.nodes[order[j]]
        if (!a || !b) continue
        if (overlapArea(a, b) > 1) overlaps++
        else if (gapBetween(a, b) < o.minNodeGap) tooClose++
      }
    }
    return { overlaps, tooClose }
  }
  const spacingBefore = collectSpacing()
  if (spacingBefore.overlaps > 0) {
    issues.push({
      code: 'node-overlap',
      level: 'error',
      message: `${spacingBefore.overlaps} 对节点互相重叠`,
      metric: spacingBefore.overlaps,
    })
  }
  if (spacingBefore.tooClose > 0) {
    issues.push({
      code: 'node-too-close',
      level: 'warn',
      message: `${spacingBefore.tooClose} 对节点间隙小于 ${o.minNodeGap}px（文字/连线容易糊在一起）`,
      metric: spacingBefore.tooClose,
    })
  }

  // ---- 4. 修复：孤立节点回收 + 分轴推挤 ----
  if (o.repair) {
    if (spacingBefore.overlaps > 0 || spacingBefore.tooClose > 0) {
      let total = 0
      for (let pass = 0; pass < o.maxRepairPasses; pass++) {
        const n = separateAlongAxis(plan.nodes, order, o.minNodeGap)
        total += n
        if (n === 0) break
        const s = collectSpacing()
        if (s.overlaps === 0 && s.tooClose === 0) break
      }
      if (total > 0) repairs.push(`分轴推挤 ${total} 次，消除节点重叠/过近`)
    }

    // 孤立节点回收：把它们排到主内容右侧的一列（保持不与人重叠）。
    // 只移动「完全没有边」的节点 —— 它们的原始坐标不含任何拓扑信息。
    if (isolated.length > 0 && isolated.length < order.length) {
      const connected = order.filter((k) => !isolated.includes(k))
      if (connected.length > 0) {
        let maxX = -Infinity
        let minY = Infinity
        for (const k of connected) {
          const r = plan.nodes[k]
          if (!r) continue
          maxX = Math.max(maxX, r.x + r.width)
          minY = Math.min(minY, r.y)
        }
        if (Number.isFinite(maxX) && Number.isFinite(minY)) {
          const colGap = Math.max(o.minNodeGap, 40)
          let y = minY
          for (const k of isolated) {
            const r = plan.nodes[k]
            if (!r) continue
            r.x = maxX + colGap
            r.y = y
            y += r.height + o.minNodeGap
          }
          repairs.push(`${isolated.length} 个孤立节点收拢到主内容右侧一列`)
        }
      }
    }
  }

  // ---- 5. 连线穿节点 ----
  {
    const hits: string[] = []
    for (const e of edges) {
      if (e.from === e.to) continue
      const a = plan.nodes[e.from]
      const b = plan.nodes[e.to]
      if (!a || !b) continue
      // 用「中心 → 中心」的近似走线判断：真实路由会避开障碍，
      // 但若中心连线都穿过第三个节点，说明分层顺序与边语义冲突，
      // 真实正交路由只能绕远（产生大 U 型绕行）。
      const p = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
      const q = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      for (const k of order) {
        if (k === e.from || k === e.to) continue
        const r = plan.nodes[k]
        if (!r) continue
        if (segmentHitsRect(p, q, r, o.edgeClearance)) {
          hits.push(`${e.from}→${e.to} 穿过 ${k}`)
          break
        }
      }
    }
    if (hits.length > 0) {
      issues.push({
        code: 'edge-through-node',
        level: 'warn',
        message: `${hits.length} 条边的连线方向穿过其他节点：${hits.slice(0, 4).join('；')}${hits.length > 4 ? ' 等' : ''}`,
        metric: hits.length,
      })
    }
  }

  // ---- 6. 尺寸归一化 + 画布贴合内容 ----
  {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const k of order) {
      const r = plan.nodes[k]
      if (!r) continue
      minX = Math.min(minX, r.x)
      minY = Math.min(minY, r.y)
      maxX = Math.max(maxX, r.x + r.width)
      maxY = Math.max(maxY, r.y + r.height)
    }
    const contentW = maxX - minX
    const contentH = maxY - minY
    if (o.repair && minX < o.padding - 0.5) {
      // 内容被推到负坐标（推挤后的常见副作用）→ 整体平移回 padding 起点
      const dx = o.padding - minX
      for (const k of order) {
        const r = plan.nodes[k]
        if (!r) continue
        r.x += dx
      }
      repairs.push(`内容整体右移 ${Math.round(dx)}px（推挤后出现负坐标）`)
    }
    const shifted = o.repair ? contentW + o.padding * 2 : plan.sceneWidth
    const shiftedH = o.repair ? contentH + o.padding * 2 : plan.sceneHeight
    if (o.repair && (Math.abs(shifted - plan.sceneWidth) > 0.5 || Math.abs(shiftedH - plan.sceneHeight) > 0.5)) {
      plan.sceneWidth = Math.max(1, shifted)
      plan.sceneHeight = Math.max(1, shiftedH)
    }
  }

  // ---- 7. 填充率（留白过多 → 图会显得松散，但不阻断） ----
  const fillRatio =
    plan.sceneWidth > 0 && plan.sceneHeight > 0
      ? Math.min(
          1,
          order.reduce((acc, k) => {
            const r = plan.nodes[k]
            return acc + (r ? r.width * r.height : 0)
          }, 0) /
            (plan.sceneWidth * plan.sceneHeight),
        )
      : 0
  if (fillRatio < o.minFillRatio && order.length > 1) {
    issues.push({
      code: 'label-overflow',
      level: 'warn',
      message: `内容填充率仅 ${(fillRatio * 100).toFixed(1)}%（画布留白过多，可能是孤立节点把包围盒拉大了）`,
      metric: fillRatio,
    })
  }

  // ---- 8. 复检：修复后仍有 overlap 才算失败 ----
  const spacingAfter = collectSpacing()
  if (spacingAfter.overlaps > 0) {
    issues.push({
      code: 'node-overlap',
      level: 'error',
      message: `修复后仍有 ${spacingAfter.overlaps} 对节点重叠（尝试降低节点尺寸或增大间距）`,
      metric: spacingAfter.overlaps,
    })
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    repairs,
    width: plan.sceneWidth,
    height: plan.sceneHeight,
    stats: { nodeCount: order.length, edgeCount: edges.length, fillRatio },
  }
}

export interface GateResult extends LayoutCheckResult {
  /** 调用方关闭了检测（此时既没检查也没修复）。 */
  skipped?: boolean
  /** 未通过（存在 error 级问题）。绘制照常进行，但调用方应把 issues 透给用户。 */
  failed?: boolean
}

/**
 * 绘制前的闸门：检测 + 修复，并把 plan 的最终尺寸算进 scene 尺寸。
 *
 * 这是各绘图工具的统一入口 —— 保证「AI 生成节点 → 布局检测 → 绘制」
 * 这条链路在所有流程图类工具里行为一致。
 */
export function runLayoutGate(
  plan: FinalPlan,
  opts: { enabled?: boolean; repair?: boolean; padding?: number } = {},
): GateResult {
  if (opts.enabled === false) {
    return {
      ok: true,
      skipped: true,
      issues: [],
      repairs: [],
      width: plan.sceneWidth,
      height: plan.sceneHeight,
      stats: {
        nodeCount: plan.nodeList.length,
        edgeCount: plan.edges.length,
        fillRatio: 0,
      },
    }
  }
  const res = checkAndRepairLayout(plan, plan.edges, {
    repair: opts.repair ?? true,
    padding: opts.padding ?? 60,
  })
  return { ...res, failed: !res.ok }
}

/**
 * 场景级布局检测（绘制之后、导出之前）。
 *
 * 流程图走 checkAndRepairLayout（在 plan 上修）；但时序/ER/架构图的元素是
 * 规划器直接产出的，没有 FinalPlan。这里对最终场景做一次统一体检。
 * 对场景只做「扩画布」这类不动坐标的修复 —— 已绘制元素的位置不再改动。
 */
export function checkSceneLayout(
  scene: Scene,
  opts: LayoutCheckOptions = {},
): { ok: boolean; issues: LayoutIssue[]; repairs: string[]; width: number; height: number } {
  const issues: LayoutIssue[] = []
  const repairs: string[] = []
  const repair = opts.repair ?? true

  if (scene.elements.length === 0) {
    return {
      ok: false,
      issues: [{ code: 'empty-nodes', level: 'error', message: '场景为空，没有可导出的内容' }],
      repairs,
      width: scene.width,
      height: scene.height,
    }
  }

  // 越界检测：画布是否真的包住了全部内容（含连线真实路径）。
  const overflow = detectOverflow(scene)
  if (overflow.overflow) {
    const sides: string[] = []
    if (overflow.left > 0.5) sides.push(`左 ${Math.ceil(overflow.left)}px`)
    if (overflow.top > 0.5) sides.push(`上 ${Math.ceil(overflow.top)}px`)
    if (overflow.right > 0.5) sides.push(`右 ${Math.ceil(overflow.right)}px`)
    if (overflow.bottom > 0.5) sides.push(`下 ${Math.ceil(overflow.bottom)}px`)
    issues.push({
      code: 'content-overflow',
      level: 'warn',
      message: `${overflow.elements.length} 个元素超出画布（${sides.join('/')}），导出时会按内容范围渲染`,
      nodes: overflow.elements.slice(0, 10),
      metric: Math.max(overflow.left, overflow.top, overflow.right, overflow.bottom),
    })
  }

  if (repair) {
    // 布局器给的 scene 尺寸可能小于真实内容（回边走廊比节点包围盒宽得多），
    // 这里一次性撑到包住内容，避免导出时被裁。
    const expanded = expandSceneToContent(scene, { padding: 0 })
    if (expanded.expanded) {
      repairs.push(`画布扩到 ${expanded.width}×${expanded.height} 以容纳全部内容`)
    }
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    repairs,
    width: scene.width,
    height: scene.height,
  }
}
