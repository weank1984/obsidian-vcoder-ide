import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { fail, type ToolResult } from './protocol'

export const AUTH_HEADER = 'x-claude-code-ide-authorization'
export const SUBPROTOCOL = 'mcp'
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const MAX_PAYLOAD = 32 * 1024 * 1024

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** When false the tool is callable but not listed (internal RPCs like openDiff). Default true. */
  listed?: boolean
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult> | ToolResult
}

export interface ToolCallContext {
  /** Aborted when the calling connection closes. */
  signal: AbortSignal
}

export interface McpServerOptions {
  authToken: string
  serverName: string
  serverVersion: string
  instructions?: () => string | undefined
  tools: ToolDefinition[]
  host?: string
  port?: number
  log?: (msg: string, extra?: unknown) => void
}

type JsonRpcId = string | number
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

export interface McpServerEvents {
  connection: [count: number, info: { pid?: number }]
  disconnect: [count: number]
}

/**
 * Minimal MCP server over WebSocket, compatible with the vcoder CLI's `ws-ide`
 * client: subprotocol `mcp`, auth header `X-Claude-Code-Ide-Authorization`,
 * one JSON-RPC 2.0 message per text frame.
 */
export class McpWebSocketServer extends EventEmitter {
  private wss: WebSocketServer | undefined
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly sockets = new Set<WebSocket>()
  private readonly aborters = new WeakMap<WebSocket, AbortController>()
  private readonly opts: McpServerOptions

  constructor(opts: McpServerOptions) {
    super()
    this.opts = opts
    for (const t of opts.tools) this.tools.set(t.name, t)
  }

  get connectionCount(): number {
    return this.sockets.size
  }

  get port(): number | undefined {
    const addr = this.wss?.address() as AddressInfo | null | undefined
    return addr?.port
  }

  async start(): Promise<number> {
    const host = this.opts.host ?? '127.0.0.1'
    const wss = new WebSocketServer({
      host,
      port: this.opts.port ?? 0,
      maxPayload: MAX_PAYLOAD,
      handleProtocols: protocols => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
      verifyClient: (info, cb) => {
        if (!this.isAuthorized(info.req)) {
          cb(false, 401, 'Unauthorized')
          return
        }
        cb(true)
      },
    })
    this.wss = wss
    wss.on('connection', (ws, req) => this.onConnection(ws, req))
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve)
      wss.once('error', reject)
    })
    return this.port!
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) {
      this.aborters.get(ws)?.abort()
      ws.terminate()
    }
    this.sockets.clear()
    const wss = this.wss
    this.wss = undefined
    if (wss) await new Promise<void>(resolve => wss.close(() => resolve()))
  }

  /** Broadcast a JSON-RPC notification to every connected client. */
  notify(method: string, params: Record<string, unknown>): void {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params })
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame)
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const raw = req.headers[AUTH_HEADER]
    const got = Array.isArray(raw) ? raw[0] : raw
    if (typeof got !== 'string') return false
    const a = Buffer.from(got)
    const b = Buffer.from(this.opts.authToken)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage): void {
    // handleProtocols already rejects clients without `mcp`, but double check.
    if (ws.protocol !== SUBPROTOCOL) {
      ws.close(1002, 'subprotocol mcp required')
      return
    }
    this.sockets.add(ws)
    this.aborters.set(ws, new AbortController())
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      void this.onMessage(ws, data.toString())
    })
    ws.on('close', () => {
      this.aborters.get(ws)?.abort()
      this.sockets.delete(ws)
      this.emit('disconnect', this.sockets.size)
    })
    ws.on('error', err => this.opts.log?.('ws error', err))
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  private reply(ws: WebSocket, id: JsonRpcId, result: unknown): void {
    this.send(ws, { jsonrpc: '2.0', id, result })
  }

  private replyError(ws: WebSocket, id: JsonRpcId | null, code: number, message: string): void {
    this.send(ws, { jsonrpc: '2.0', id, error: { code, message } })
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: JsonRpcRequest
    try {
      msg = JSON.parse(raw)
    } catch {
      this.replyError(ws, null, -32700, 'Parse error')
      return
    }
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      // Responses to server-initiated requests (we send none) or garbage.
      return
    }
    const isRequest = msg.id !== undefined && msg.id !== null
    try {
      if (!isRequest) {
        this.onNotification(msg)
        return
      }
      const id = msg.id as JsonRpcId
      switch (msg.method) {
        case 'initialize':
          this.reply(ws, id, this.initializeResult(msg.params))
          return
        case 'ping':
          this.reply(ws, id, {})
          return
        case 'tools/list':
          this.reply(ws, id, {
            tools: [...this.tools.values()]
              .filter(t => t.listed !== false)
              .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          })
          return
        case 'tools/call':
          this.reply(ws, id, await this.callTool(ws, msg.params))
          return
        case 'resources/list':
          this.reply(ws, id, { resources: [] })
          return
        case 'prompts/list':
          this.reply(ws, id, { prompts: [] })
          return
        default:
          this.replyError(ws, id, -32601, `Method not found: ${msg.method}`)
      }
    } catch (err) {
      if (isRequest) this.replyError(ws, msg.id as JsonRpcId, -32603, errorMessage(err))
    }
  }

  private onNotification(msg: JsonRpcRequest): void {
    if (msg.method === 'ide_connected') {
      const pid = typeof msg.params?.pid === 'number' ? msg.params.pid : undefined
      this.emit('connection', this.sockets.size, { pid })
    }
    // notifications/initialized, notifications/cancelled etc. need no action.
  }

  private initializeResult(params: Record<string, unknown> | undefined) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined
    const protocolVersion =
      requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]
    const instructions = this.opts.instructions?.()
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.opts.serverName, version: this.opts.serverVersion },
      ...(instructions ? { instructions } : {}),
    }
  }

  private async callTool(ws: WebSocket, params: Record<string, unknown> | undefined): Promise<ToolResult> {
    const name = typeof params?.name === 'string' ? params.name : ''
    const tool = this.tools.get(name)
    if (!tool) return fail(`Unknown tool: ${name}`)
    const args = (params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<
      string,
      unknown
    >
    const signal = this.aborters.get(ws)?.signal ?? new AbortController().signal
    try {
      return await tool.handler(args, { signal })
    } catch (err) {
      return fail(errorMessage(err))
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
