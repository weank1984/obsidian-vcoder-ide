import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import WebSocket from 'ws'

/**
 * Mirrors how the vcoder CLI connects to a `ws-ide` server
 * (cli/src/services/mcp/client.ts + utils/mcpWebSocketTransport.ts):
 * subprotocol `mcp`, header `X-Claude-Code-Ide-Authorization`.
 */
export class TestWsTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private opened: Promise<void>

  constructor(private ws: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    ws.on('message', data => this.onmessage?.(JSON.parse(data.toString())))
    ws.on('close', () => this.onclose?.())
    ws.on('error', err => this.onerror?.(err))
  }

  async start() {
    await this.opened
  }
  async send(message: JSONRPCMessage) {
    this.ws.send(JSON.stringify(message))
  }
  async close() {
    this.ws.close()
  }
}

export function openSocket(port: number, token: string | undefined, protocols: string[] = ['mcp']): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`, protocols, {
    headers: token === undefined ? {} : { 'X-Claude-Code-Ide-Authorization': token },
  })
}

export async function connectClient(port: number, token: string) {
  const ws = openSocket(port, token)
  const transport = new TestWsTransport(ws)
  const client = new Client({ name: 'vcoder', version: 'test' }, { capabilities: { roots: {} } })
  await client.connect(transport)
  return { client, ws }
}

/** Resolves to the HTTP status (or 'open') of a raw connection attempt. */
export function attempt(port: number, token: string | undefined, protocols?: string[]): Promise<number | 'open' | 'closed'> {
  return new Promise(resolve => {
    const ws = openSocket(port, token, protocols)
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
    ws.once('open', () => {
      resolve('open')
      ws.close()
    })
    ws.once('error', () => resolve('closed'))
  })
}
