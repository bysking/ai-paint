/**
 * End-to-end smoke test:
 *  1. Boots the MCP server as a child process (stdio).
 *  2. Runs initialize → tools/list → tools/call sequence.
 *  3. Draws a mini scene, renders SVG, asserts on output.
 */

import { spawn } from 'node:child_process'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const ROOT = new URL('..', import.meta.url).pathname
// 用发布产物的 bin 入口（dist/cli.js）做端到端验证，而不是 dist/index.js ——
// dist/index.js 会被 build-cleanup 在 prepack 时删除，两者入口行为需保持一致。
const SERVER = join(ROOT, 'dist', 'cli.js')

let buf = ''
const messages = []
const pending = new Map()

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + '\n')
}

function request(child, method, params) {
  return new Promise((resolve, reject) => {
    const id = `r${pending.size + 1}`
    pending.set(id, { resolve, reject, method })
    send(child, { jsonrpc: '2.0', id, method, params })
  })
}

async function main() {
  assert.ok(existsSync(SERVER), `server not built: ${SERVER} (run npm run build first)`)

  const child = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] })
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      } else {
        messages.push(msg)
      }
    }
  })

  const waitFor = (ms) => new Promise((r) => setTimeout(r, ms))
  await waitFor(300)

  // initialize
  const init = await request(child, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  })
  assert.ok(init.serverInfo?.name === 'ai-paint', 'initialize failed')

  // tools/list
  const tools = await request(child, 'tools/list', {})
  const names = tools.tools.map((t) => t.name)
  for (const required of [
    'new_scene', 'add_rectangle', 'add_arrow', 'add_text', 'get_scene_svg', 'save_scene_svg',
    'add_shape', 'add_edge', 'create_flow_diagram', 'create_sequence_diagram', 'create_er_diagram',
    'plan_flow_layout', 'save_scene_png',
    'create_diagram', 'export_scene', 'get_plan', 'list_plans', 'delete_plan',
  ]) {
    assert.ok(names.includes(required), `missing tool: ${required}`)
  }

  // draw
  const scene = 'smoke_' + Date.now()
  await request(child, 'tools/call', { name: 'new_scene', arguments: { name: scene, width: 400, height: 300 } })
  const r1 = await request(child, 'tools/call', {
    name: 'add_rectangle',
    arguments: { scene, x: 50, y: 50, width: 200, height: 100, background_color: '#ffd8a8', fill_style: 'hachure' },
  })
  const rect = JSON.parse(r1.content[0].text)
  assert.ok(rect.id, 'add_rectangle should return id')

  await request(child, 'tools/call', {
    name: 'add_text',
    arguments: { scene, x: 90, y: 80, data: { text: 'Hello MCP' } },
  })
  await request(child, 'tools/call', {
    name: 'add_arrow',
    arguments: { scene, data: { points: [[50, 220], [250, 220]] } },
  })

  // svg
  const svgRes = await request(child, 'tools/call', { name: 'get_scene_svg', arguments: { scene } })
  const svg = JSON.parse(svgRes.content[0].text).svg
  assert.ok(svg.includes('<svg'), 'svg should start with <svg')
  assert.ok(svg.includes('Hello MCP'), 'text should be in svg')
  assert.ok(svg.includes('stroke="#1e1e1e"'), 'default stroke color present')

  // element count
  const sceneRes = await request(child, 'tools/call', { name: 'get_scene', arguments: { name: scene } })
  const sceneInfo = JSON.parse(sceneRes.content[0].text)
  assert.ok(sceneInfo.elementCount === 3, `expected 3 elements, got ${sceneInfo.elementCount}`)

  // unified pipeline: create_diagram (perf.md flow)
  const flowRes = await request(child, 'tools/call', {
    name: 'create_diagram',
    arguments: {
      scene: 'smoke_flow_' + Date.now(),
      type: 'flow',
      nodes: [{ name: 'a', type: 'start' }, { name: 'b', type: 'process' }, { name: 'c', type: 'end' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
      export_svg_png: false,
    },
  })
  const flow = JSON.parse(flowRes.content[0].text)
  assert.ok(flow.fingerprint, 'create_diagram should return fingerprint')
  assert.ok(flow.nodes.a && flow.nodes.a.x >= 0, 'create_diagram should return node coordinates')
  assert.ok(flow.scene === 'smoke_flow_' + (flow.scene.match(/\d+$/) || [''])[0], 'scene name set')

  // save_scene_png should also write a companion .excalidraw file
  const pngRes = await request(child, 'tools/call', {
    name: 'save_scene_png',
    arguments: { scene: flow.scene, scale: 1 },
  })
  const png = JSON.parse(pngRes.content[0].text)
  assert.ok(png.path && png.path.endsWith('.png'), 'save_scene_png returns png path')
  assert.ok(png.excalidrawPath && png.excalidrawPath.endsWith('.excalidraw'), 'save_scene_png writes companion .excalidraw')
  assert.ok(png.excalidrawBytes > 0, 'companion .excalidraw has content')
  assert.ok(existsSync(png.excalidrawPath), 'companion .excalidraw file exists on disk')

  // error handling: unknown tool
  const badRes = await request(child, 'tools/call', { name: 'nope', arguments: {} })
  assert.ok(badRes.isError === true, 'unknown tool should be an error')

  // unknown method → JSON-RPC error (request helper rejects on error)
  let badMethodError = null
  try {
    await request(child, 'unknown/method', {})
  } catch (e) {
    badMethodError = e
  }
  assert.ok(badMethodError && /Method not found/.test(badMethodError.message), 'unknown method should error')

  child.stdin.end()
  await waitFor(200)
  child.kill()

  console.log('✅ smoke test passed')
}

main().catch((err) => {
  console.error('❌ smoke test failed:', err.message)
  process.exit(1)
})
