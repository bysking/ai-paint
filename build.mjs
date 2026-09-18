/**
 * esbuild 打包脚本：把 CLI 与库入口各自打包压缩成单文件，减小 npm 包体积。
 *
 *   npm run bundle
 *
 * 产物（覆盖 tsc 生成的未压缩 JS，.d.ts 仍由 tsc 生成）：
 *   dist/cli.js   — MCP 服务 bin（单文件、压缩）
 *   dist/lib.js   — 库入口（单文件、压缩，外部化 node 内置模块与 @resvg）
 */
import { build } from 'esbuild'
import { rmSync, existsSync } from 'node:fs'

const shared = {
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  // @resvg 原生模块保持外部（动态 import，运行时装）
  external: ['@resvg/resvg-js'],
  // 注意：不加 banner——cli.ts 源文件自带 shebang，esbuild 会保留；
  // 再加 banner 会产生重复的 #!/usr/bin/env node 导致语法错误。
}

const targets = [
  { entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js' },
  { entryPoints: ['src/lib.ts'], outfile: 'dist/lib.js' },
]

for (const t of targets) {
  await build({ ...shared, entryPoints: t.entryPoints, outfile: t.outfile })
  console.log(`bundled ${t.outfile}`)
}

console.log('bundle done')
