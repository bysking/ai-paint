/**
 * In-memory scene store with JSON file persistence.
 * Sessions are keyed by scene name; files live in <cwd>/.ai-paint/.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { blankScene, type Scene } from '../core/scene.js'

export interface SceneStoreOptions {
  dir?: string
}

export class SceneStore {
  private dir: string
  private scenes = new Map<string, Scene>()

  constructor(opts: SceneStoreOptions = {}) {
    this.dir = opts.dir ?? join(process.cwd(), '.ai-paint')
    mkdirSync(this.dir, { recursive: true })
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

  getOrCreate(name: string): Scene {
    const existing = this.scenes.get(name)
    if (existing) return existing
    const onDisk = this.loadFromDisk(name)
    if (onDisk) {
      this.scenes.set(name, onDisk)
      return onDisk
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
        const { rmSync } = require('node:fs') as typeof import('node:fs')
        rmSync(this.fileFor(name), { force: true })
      } catch {
        /* ignore */
      }
    }
    return had
  }

  save(scene: Scene): void {
    try {
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
