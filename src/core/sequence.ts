/**
 * 时序图（sequence diagram）生成器。
 * 返回场景坐标与文本/连线数据，供渲染层或工具层消费。
 *
 * 布局：参与者在顶部水平排开；消息在参与者之间水平往返，逐行下移。
 */

export interface SeqParticipant {
  key: string
  label: string
  /** rectangle / actor / database 等形状。 */
  shape?: 'rectangle' | 'actor' | 'database' | 'cylinder'
  fill?: string
}

export interface SeqMessage {
  from: string
  to: string
  label: string
  /** 是否虚线。默认自动：与更早某条消息方向相反（回程）即视为返回消息画虚线；
   * 传 true/false 可显式覆盖自动判断。 */
  dashed?: boolean
  /** 自消息（从 from 指向 from 自己）。 */
  self?: boolean
}

export interface SeqLifeline {
  key: string
  x: number
  /** 顶盒 y 与高度。 */
  boxY: number
  boxHeight: number
  lineY1: number
  lineY2: number
}

export interface SequenceDiagram {
  width: number
  height: number
  participants: SeqLifeline[]
  /** 消息行（用于绘制箭头 + 标签）。 */
  rows: {
    from: string
    to: string
    label: string
    dashed: boolean
    self: boolean
    y: number
    x1: number
    x2: number
  }[]
  /** 各参与者的激活段（lifeline 上的生命周期矩形条）。
   * 参与者从「第一次发出消息」到「最后一次收到消息」处于激活状态。 */
  activations: { key: string; x: number; y1: number; y2: number }[]
}

export interface SeqOptions {
  boxWidth?: number
  boxHeight?: number
  participantGap?: number
  rowHeight?: number
  padding?: number
  title?: string
}

const DEFAULT = { boxWidth: 140, boxHeight: 56, participantGap: 120, rowHeight: 52, padding: 60 }

export function planSequenceDiagram(
  participants: SeqParticipant[],
  messages: SeqMessage[],
  opts: SeqOptions = {},
): SequenceDiagram {
  const { boxWidth, boxHeight, participantGap, rowHeight, padding } = { ...DEFAULT, ...opts }
  const n = participants.length
  const laneW = Math.max(boxWidth, participantGap)
  const totalW = n * laneW + padding * 2

  const titleH = opts.title ? 60 : 0
  const boxY = padding + titleH
  const headerBottom = boxY + boxHeight + 30

  // 参与者 x（盒子中心）
  const centers = participants.map((_, i) => padding + laneW * i + laneW / 2)

  const lifelines: SeqLifeline[] = participants.map((p, i) => ({
    key: p.key,
    x: centers[i],
    boxY,
    boxHeight,
    lineY1: boxY + boxHeight,
    lineY2: headerBottom + messages.length * rowHeight + 40,
  }))

  // 返回消息自动识别：与更早某条非自消息方向相反（A→B 之后的 B→A）即视为返回，
  // 默认画虚线；显式传入 dashed 优先。
  const directions = new Set<string>()
  const rows = messages.map((m, i) => {
    const y = headerBottom + i * rowHeight + rowHeight / 2
    const fromIdx = participants.findIndex((p) => p.key === m.from)
    const toIdx = m.self ? fromIdx : participants.findIndex((p) => p.key === m.to)
    const isReturn = !m.self && fromIdx >= 0 && toIdx >= 0 && directions.has(`${toIdx}->${fromIdx}`)
    if (!m.self && fromIdx >= 0 && toIdx >= 0) directions.add(`${fromIdx}->${toIdx}`)
    return {
      from: m.from,
      to: m.self ? m.from : m.to,
      label: m.label,
      dashed: m.dashed ?? isReturn,
      self: m.self ?? false,
      y,
      x1: centers[Math.max(0, fromIdx)],
      x2: centers[Math.max(0, toIdx)],
    }
  })

  const height = (headerBottom + messages.length * rowHeight + 60) + (opts.title ? 20 : 0)

  // 激活段：每个参与者从「第一次发出消息」到「最后一次收到消息」。
  // 实线消息（发出）作为激活开始，虚线返回（收到）作为激活延续；
  // 简单起见：参与者参与的所有消息行（发出 + 接收）的最小 y 到最大 y 为激活范围。
  const involvement = new Map<string, { min: number; max: number }>()
  const track = (key: string, y: number) => {
    const e = involvement.get(key)
    if (!e) { involvement.set(key, { min: y, max: y }); return }
    e.min = Math.min(e.min, y)
    e.max = Math.max(e.max, y)
  }
  messages.forEach((m, i) => {
    const rowY = headerBottom + i * rowHeight + rowHeight / 2
    track(m.from, rowY)
    if (!m.self && m.to) track(m.to, rowY)
  })
  const activations = participants
    .filter((p) => involvement.has(p.key))
    .map((p, i) => {
      const iv = involvement.get(p.key)!
      const actW = 6
      return {
        key: p.key,
        x: centers[i] - actW / 2,
        y1: iv.min - rowHeight / 2 + 4,
        y2: iv.max + rowHeight / 2 - 4,
      }
    })

  return { width: totalW, height, participants: lifelines, rows, activations }
}
