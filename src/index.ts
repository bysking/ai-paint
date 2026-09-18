#!/usr/bin/env node
/**
 * ai-paint — Excalidraw-style drawing engine exposed as an MCP stdio server.
 *
 * Usage:
 *   ai-paint                # run as MCP stdio server
 *   ai-paint --serve        # same
 *   ai-paint demo <name>    # write a demo scene + save SVG, then exit
 */

import { McpServer } from './mcp/server.js'
import { renderDemoScene, renderDemoEr } from './demo.js'
import { planArchitectureDiagram } from './core/arch.js'
import { createElement, blankScene, type Scene } from './core/scene.js'
import { writeFileSync } from 'node:fs'

const arg = process.argv[2] ?? ''

if (arg === 'demo') {
  const name = process.argv[3] ?? 'demo'
  const scene = await renderDemoScene(name)
  const { renderSceneSvg } = await import('./core/render.js')
  const svg = renderSceneSvg(scene)
  writeFileSync(`${name}.svg`, svg, 'utf8')

  const erScene = renderDemoEr('demo_er')
  writeFileSync(`demo-er.svg`, renderSceneSvg(erScene), 'utf8')

  // 架构图 demo
  const arch = planArchitectureDiagram(
    [
      {
        key: 'presentation', label: '展示层', fill: '#ffd8a8',
        modules: [{ key: 'web', label: 'Web 前端' }, { key: 'mobile', label: '移动端' }, { key: 'admin', label: '管理后台' }],
      },
      {
        key: 'gateway', label: '网关层', fill: '#b2f2bb',
        modules: [{ key: 'api', label: 'API 网关' }, { key: 'auth', label: '认证中心' }],
      },
      {
        key: 'service', label: '服务层', fill: '#a5d8ff',
        modules: [{ key: 'order', label: '订单服务' }, { key: 'user', label: '用户服务' }, { key: 'pay', label: '支付服务' }],
      },
      {
        key: 'data', label: '数据层', fill: '#d0bfff',
        modules: [{ key: 'mysql', label: 'MySQL' }, { key: 'redis', label: 'Redis' }],
      },
    ],
    [
      { from: 'web', to: 'api', label: 'HTTPS' },
      { from: 'mobile', to: 'api', label: 'HTTPS' },
      { from: 'admin', to: 'api', label: 'HTTPS' },
      { from: 'api', to: 'auth', label: '校验' },
      { from: 'api', to: 'order' },
      { from: 'api', to: 'user' },
      { from: 'api', to: 'pay' },
      { from: 'order', to: 'mysql' },
      { from: 'user', to: 'mysql' },
      { from: 'pay', to: 'redis' },
    ],
  )
  const archScene = blankScene('demo_arch', arch.width, arch.height)
  const moduleIds: Record<string, string> = {}
  let ai = 0
  const aid = (p: string) => `${p}_${++ai}`
  for (const l of Object.values(arch.layers)) {
    archScene.elements.push(
      createElement('frame', {
        id: aid('arch_layer'), x: l.x, y: l.y, width: l.width, height: l.height,
        stroke_color: '#495057', background_color: l.fill, fill_style: 'solid',
        stroke_width: 2, stroke_style: 'dashed', data: { children: [] },
      }),
      createElement('text', {
        id: aid('arch_title'), x: l.x + 12, y: l.y + 10, width: l.width - 24, height: 24,
        stroke_color: '#343a40', data: { text: l.label, font_size: 16, text_align: 'left' },
      }),
    )
    for (const [mk, m] of Object.entries(l.modules)) {
      const mid = aid('arch_module')
      moduleIds[mk] = mid
      archScene.elements.push(
        createElement('shape', {
          id: mid, x: m.x, y: m.y, width: m.width, height: m.height,
          stroke_color: '#1e1e1e', background_color: m.fill, fill_style: 'hachure',
          stroke_width: 2, data: { shape: 'rectangle' },
        }),
        createElement('text', {
          id: aid('arch_label'), x: m.x, y: m.y + m.height / 2 - 10, width: m.width, height: 20,
          stroke_color: '#1e1e1e', data: { text: mk, font_size: 13, text_align: 'center' },
        }),
      )
    }
  }
  for (const link of arch.links) {
    const fid = moduleIds[link.from]
    const tid = moduleIds[link.to]
    if (!fid || !tid) continue
    archScene.elements.push(
      createElement('edge', {
        id: aid('arch_link'), x: 0, y: 0, width: 0, height: 0,
        stroke_color: '#1e1e1e', stroke_width: 2,
        data: { from: fid, to: tid, edge_type: link.type, dashed: link.dashed === false ? false : true, label: link.label, arrow: 'triangle' },
      }),
    )
  }
  writeFileSync(`demo-arch.svg`, renderSceneSvg(archScene), 'utf8')

  console.log(`wrote ${name}.svg (${scene.elements.length} elements) + demo-er.svg (${erScene.elements.length}) + demo-arch.svg (${archScene.elements.length})`)
  process.exit(0)
}

const server = new McpServer()
await server.run()
