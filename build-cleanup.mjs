/**
 * 发布前清理 dist/：删除 sourcemap 与非导出的 dev 入口，
 * 只保留运行时需要的 JS + .d.ts（.d.ts 供 TS 消费方解析类型）。
 *
 * 被清理的仅影响开发调试，不涉及任何 exports/bin 指向的文件。
 */
import { rmSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('.', import.meta.url).pathname
const dist = join(root, 'dist')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      out.push(...walk(p))
    } else {
      out.push(p)
    }
  }
  return out
}

// 仅这两个是发布入口（单文件 bundle，自包含）；其余 .js 由 tsc 生成、
// 运行时不需要（lib.js/cli.js 已把所有模块打进 bundle），只留 .d.ts 供 TS 解析。
const KEEP_JS = new Set(['cli.js', 'lib.js'])

let removed = 0
for (const p of walk(dist)) {
  const rel = p.slice(dist.length + 1)
  // 1) sourcemap
  if (rel.endsWith('.map')) { rmSync(p, { force: true }); removed++; continue }
  // 2) 除 cli/lib 外的普通 .js（dev 入口 / 模块中间产物）
  if (rel.endsWith('.js') && !KEEP_JS.has(rel)) { rmSync(p, { force: true }); removed++; continue }
  // 3) dev 入口的 .d.ts（index/demo 已不在 exports 中）
  if (rel === 'index.d.ts' || rel === 'demo.d.ts') { rmSync(p, { force: true }); removed++ }
}

console.log(`cleanup: removed ${removed} files from dist/`)
