/**
 * Minimal JSON-RPC 2.0 helper for MCP (Model Context Protocol).
 *
 * Framing: the official MCP stdio transport uses
 * `Content-Length: <N>\r\n\r\n<body>` (like LSP). Some lightweight clients
 * use newline-delimited JSON instead. This reader supports both, transparently.
 *
 * A single MessageReader instance is created once and reused across the whole
 * session — it owns the stream iterator and the partial-frame buffer, so
 * frames split across multiple chunks (and multiple messages arriving in one
 * chunk) are reassembled correctly.
 */

export class McpError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
    this.name = 'McpError'
  }
}

export const MCP_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export function isJsonRpcRequest(v: unknown): v is {
  jsonrpc: string
  id: string | number | null
  method: string
  params?: unknown
} {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (v as Record<string, unknown>).method === 'string' &&
    'id' in v
  )
}

export function isNotification(v: unknown): v is {
  jsonrpc: string
  method: string
  params?: unknown
} {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (v as Record<string, unknown>).method === 'string' &&
    !('id' in v)
  )
}

export function writeMessage(msg: unknown): void {
  const body = JSON.stringify(msg)
  if (!body) return
  process.stdout.write(body + '\n')
}

export function notify(method: string, params: unknown): void {
  writeMessage({ jsonrpc: '2.0', method, params })
}

/**
 * Incremental message reader for one stdio stream. Create ONCE per session
 * and call `read()` for each frame — buffering and iterator state live here,
 * so messages arriving in the same chunk (e.g. initialize + tools/list written
 * together) are each delivered once, and Content-Length frames that span
 * multiple chunks are reassembled.
 */
export class MessageReader {
  private reader: AsyncIterableIterator<Buffer> | null
  /** 原始字节缓冲。Content-Length 是【字节数】，用字符串按字符数 slice 会在
   *  含 CJK（UTF-8 每字 3 字节）时算错，导致帧边界错位、后续帧全部丢失。 */
  private buf = Buffer.alloc(0)
  /** 当前 Content-Length 帧的剩余字节数；null = 不在帧体内。 */
  private contentLength: number | null = null

  constructor(stream: NodeJS.ReadableStream) {
    this.reader = (stream as unknown as {
      [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>
    })[Symbol.asyncIterator]()
  }

  /** 尝试从字节缓冲里解析一个完整的 Content-Length 帧；不足则返回 undefined。 */
  private tryContentLengthFrame(): string | undefined {
    if (this.contentLength === null) {
      // 找帧头（LSP/MCP stdio 标准：Content-Length: N\r\n\r\n）
      const headerEnd = this.buf.indexOf('\r\n\r\n')
      if (headerEnd === -1) return undefined
      const header = this.buf.subarray(0, headerEnd).toString('utf8')
      const m = header.match(/Content-Length:\s*(\d+)/i)
      if (m) this.contentLength = parseInt(m[1], 10)
      // 吃掉帧头（不管是否识别出 Content-Length；识别不出按无头裸体处理）
      this.buf = this.buf.subarray(headerEnd + 4)
      if (this.contentLength === null) return undefined
    }
    if (this.buf.length < this.contentLength) return undefined // 帧体跨多个 chunk
    const body = this.buf.subarray(0, this.contentLength).toString('utf8')
    this.buf = this.buf.subarray(this.contentLength)
    this.contentLength = null
    return body
  }

  /** 尝试从字节缓冲里解析一个完整的新行分隔帧；不足则返回 undefined。 */
  private tryNewlineFrame(): string | undefined {
    const nl = this.buf.indexOf('\n')
    if (nl === -1) return undefined
    const line = this.buf.subarray(0, nl).toString('utf8').trim()
    this.buf = this.buf.subarray(nl + 1)
    if (!line) return undefined
    return line
  }

  /** Read the next frame as a parsed JSON value, or null on EOF. */
  async read(): Promise<unknown | null> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 1) Content-Length framing（官方 MCP stdio 传输，字节级）
      const clFrame = this.tryContentLengthFrame()
      if (clFrame !== undefined) {
        try {
          return JSON.parse(clFrame)
        } catch {
          return null
        }
      }

      // 2) Newline-delimited JSON framing（轻量客户端）
      const nlFrame = this.tryNewlineFrame()
      if (nlFrame !== undefined) {
        try {
          return JSON.parse(nlFrame)
        } catch {
          return null
        }
      }

      // 3) Need more bytes — pull the next chunk from the stream.
      const iter = this.reader
      if (iter === null) return null // stream already exhausted
      const { value, done } = await iter.next()
      if (done) {
        this.reader = null
        // EOF: deliver whatever remains (bare trailing frame), then null.
        if (this.buf.length > 0) {
          const rest = this.buf.toString('utf8').trim()
          this.buf = Buffer.alloc(0)
          if (rest) {
            try {
              return JSON.parse(rest)
            } catch {
              return null
            }
          }
        }
        return null
      }
      this.buf = Buffer.concat([this.buf, value])
    }
  }
}

/**
 * Read a single message from a stream using an ad-hoc MessageReader.
 * Kept for compatibility — long-lived sessions should create one
 * MessageReader and call read() repeatedly instead.
 */
export async function readMessage(stream: NodeJS.ReadableStream): Promise<unknown | null> {
  return new MessageReader(stream).read()
}
