/**
 * In-memory scene store with JSON file persistence.
 * Sessions are keyed by scene name; files live in <cwd>/.ai-paint/.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { blankScene, type Scene } from '../core/scene.js'

export interface SceneStoreOptions {
  dir?: string
}

export class SceneStore {
  private dir: string
  private scenes = new Map<string, Scene>()

  constructor(opts: SceneStoreOptions = {}) {
    // 目录在首次写入时才创建：仅启动 MCP 服务不应在 cwd 产生 .ai-paint/
    this.dir = opts.dir ?? join(process.cwd(), '.ai-paint')
  }

  private fileFor(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  create(name: string, width = 2400, height = 1600, background = '#ffffff'): Scene {
    const scene = blankScene(name, width, height)
    scene.background_color = background
    this.scenes.set(name, scene)
    this.save(scene)
    return scene
  }

  get(name: string): Scene | undefined {
    return this.scenes.get(name)
  }

  /**
   * 只读查找：内存 → 磁盘，绝不创建。
   *
   * 与 getOrCreate 的区别就在未命中时：peek 返回 undefined，getOrCreate 会建一个
   * 空场景并 save() 落盘。只读工具（get_scene / get_scene_svg）走这里 ——
   * 读一个不存在的场景名不该在 cwd/.ai-paint 里凭空多出一个空 json。
   */
  peek(name: string): Scene | undefined {
    return this.scenes.get(name) ?? this.loadFromDisk(name)
  }

  getOrCreate(name: string): Scene {
    const found = this.peek(name)
    if (found) {
      this.scenes.set(name, found)
      return found
    }
    return this.create(name)
  }

  list(): { name: string; elementCount: number; width: number; height: number }[] {
    return [...this.scenes.values()].map((s) => ({
      name: s.name,
      elementCount: s.elements.length,
      width: s.width,
      height: s.height,
    }))
  }

  update(scene: Scene): Scene {
    this.scenes.set(scene.name, scene)
    this.save(scene)
    return scene
  }

  delete(name: string): boolean {
    const had = this.scenes.delete(name)
    if (had) {
      try {
        // 必须用 ESM import 的 rmSync：本包是 "type": "module"，
        // require('node:fs') 会抛 ERR_REQUIRE_ESM，被下面的 catch 吞掉后
        // 文件根本删不掉（delete_scene 报成功但磁盘上的 json 还在）。
        rmSync(this.fileFor(name), { force: true })
      } catch {
        /* ignore */
      }
    }
    return had
  }

  save(scene: Scene): void {
    try {
      // 唯一的建目录点：只有真的要落盘时才创建，构造/只读查找都不碰磁盘。
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.fileFor(scene.name), JSON.stringify(scene, null, 2), 'utf8')
    } catch (err) {
      console.error(`[ai-paint] failed to persist scene: ${(err as Error).message}`)
    }
  }

  loadFromDisk(name: string): Scene | undefined {
    try {
      const raw = readFileSync(this.fileFor(name), 'utf8')
      const parsed = JSON.parse(raw) as Scene
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.elements)) {
        return parsed
      }
    } catch {
      /* not found / invalid */
    }
    return undefined
  }

  snapshot(name: string): Scene {
    const scene = this.getOrCreate(name)
    return JSON.parse(JSON.stringify(scene)) as Scene
  }
}
