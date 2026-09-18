/**
 * MCP (Model Context Protocol) server for the ai-paint drawing engine.
 * Implements the stdio transport with tools/list + tools/call.
 */

import { randomUUID } from 'node:crypto'
import { SceneStore } from './store.js'
import {
  MCP_ERRORS,
  McpError,
  isJsonRpcRequest,
  MessageReader,
  writeMessage,
} from './protocol.js'
import { ToolRegistry } from '../tools/registry.js'
import { registerElementTools } from '../tools/element-tools.js'
import { registerSceneTools } from '../tools/scene-tools.js'
import { registerDiagramTools } from '../tools/diagram-tools.js'
import { registerExtraDiagramTools } from '../tools/diagram-tools-extra.js'
import { registerSpecialDiagrams } from '../tools/special-diagrams.js'
import { registerArchTools } from '../tools/arch-tools.js'
import { registerPipelineTools } from '../tools/pipeline-tools.js'
import { renderSceneSvg } from '../core/render.js'

export interface McpServerOptions {
  /** Server display name. */
  name?: string
  version?: string
  /** Allow persistence writes (default true). */
  persist?: boolean
  /** Scene store (default: .ai-paint in cwd). */
  store?: SceneStore
}

const SCHEMA_TYPE = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const

export class McpServer {
  readonly name: string
  readonly version: string
  private registry = new ToolRegistry()
  private store: SceneStore
  private persist: boolean
  private lastScene = 'default'
  private running = false

  constructor(opts: McpServerOptions = {}) {
    this.name = opts.name ?? 'ai-paint'
    this.version = opts.version ?? '0.1.0'
    this.persist = opts.persist ?? true
    this.store = opts.store ?? new SceneStore()

    // ctx bridging: element tools need a way to resolve scenes through the store.
    const self = this
    registerElementTools(this.registry, {
      getScene(name) {
        return self.store.getOrCreate(name)
      },
      updateScene(scene) {
        self.lastScene = scene.name
        if (self.persist) self.store.save(scene)
        return scene
      },
    })
    registerSceneTools(this.registry, this.store)
    registerDiagramTools(this.registry, this.store)
    registerExtraDiagramTools(this.registry, this.store)
    registerSpecialDiagrams(this.registry, this.store)
    registerArchTools(this.registry, this.store)
    registerPipelineTools(this.registry, this.store)
  }

  getTools() {
    return this.registry.list()
  }

  /** 本服务支持的协议版本（从新到旧，供协商）。 */
  private static SUPPORTED_VERSIONS = ['2025-06-18', '2024-11-05', '2024-10-07']

  /** Build the MCP initialize result：回显客户端请求的协议版本（若支持），否则取最新的支持版本。 */
  initializeResult(clientVersion?: string) {
    const requested = typeof clientVersion === 'string' ? clientVersion : ''
    const supported = McpServer.SUPPORTED_VERSIONS.includes(requested)
    return {
      protocolVersion: supported ? requested : McpServer.SUPPORTED_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: this.name, version: this.version },
    }
  }

  /** Respond to a tools/call: run handler, wrap errors. */
  async handleToolCall(name: string, args: unknown) {
    try {
      const result = await this.registry.call(name, (args ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (err) {
      const code = err instanceof McpError ? err.code : MCP_ERRORS.INTERNAL_ERROR
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      }
    }
  }

  async handleMessage(msg: unknown): Promise<void> {
    if (!isJsonRpcRequest(msg)) {
      // Notification (no id) — ignore for now.
      if (msg && typeof msg === 'object' && (msg as { method?: string }).method === 'notifications/initialized') {
        return
      }
      return
    }
    const { id, method, params } = msg
    const respond = (result: unknown) =>
      writeMessage({ jsonrpc: '2.0', id, result })
    const respondError = (code: number, message: string, data?: unknown) =>
      writeMessage({ jsonrpc: '2.0', id, error: { code, message, data } })

    try {
      switch (method) {
        case 'initialize': {
          const p = (params ?? {}) as { protocolVersion?: string }
          respond(this.initializeResult(p.protocolVersion))
          break
        }
        case 'tools/list':
          respond({ tools: this.getTools() })
          break
        case 'tools/call': {
          const p = (params ?? {}) as { name?: string; arguments?: unknown }
          if (!p.name) throw new McpError(MCP_ERRORS.INVALID_PARAMS, 'tools/call requires "name"')
          respond(await this.handleToolCall(p.name, p.arguments))
          break
        }
        case 'notifications/initialized':
          respond({})
          break
        case 'ping':
          respond({})
          break
        default:
          respondError(MCP_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`)
      }
    } catch (err) {
      respondError(
        err instanceof McpError ? err.code : MCP_ERRORS.INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Run the stdio loop until stdin closes. */
  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      // Single reader for the whole session: it owns the stdin iterator and
      // the partial-frame buffer, so messages split across chunks (or several
      // arriving in one chunk) are all delivered exactly once.
      const reader = new MessageReader(process.stdin)
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const msg = await reader.read()
        if (msg === null) break
        await this.handleMessage(msg)
      }
    } catch (err) {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: MCP_ERRORS.INTERNAL_ERROR, message: String(err) },
      })
    } finally {
      this.running = false
    }
  }
}

export { renderSceneSvg, SceneStore }
export * from '../core/scene.js'
