import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiffSessions, type DiffSession } from '../src/core/diffSessions'
import { McpWebSocketServer } from '../src/core/mcpServer'
import { buildInstructions, buildTools, type IdeHost } from '../src/core/tools'
import { attempt, connectClient } from './helpers/mcpClient'

const TOKEN = 'secret-token'
const ROOT = '/vault'

function makeHost(files: Record<string, string>): IdeHost {
  return {
    vaultRoot: ROOT,
    vaultName: 'vault',
    readFile: async p => files[p] ?? null,
    diagnosticsFor: async p =>
      p === 'bad.md'
        ? [{ message: 'Unresolved link', severity: 'Warning', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, source: 'vcoder-ide' }]
        : [],
    allDiagnostics: async () => [
      { vaultPath: 'bad.md', diagnostics: [{ message: 'x', severity: 'Warning', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] },
    ],
    openFile: async p => ({ found: p in files, line: 2 }),
    openEditors: () => [{ vaultPath: 'a.md', active: true, dirty: false }],
    currentSelection: () => ({ vaultPath: 'a.md', text: 'hi', selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } }),
    latestSelection: () => null,
    isDirty: () => false,
    save: async () => true,
  }
}

describe('McpWebSocketServer + tools (CLI wire contract)', () => {
  let server: McpWebSocketServer
  let port: number
  let shown: DiffSession[]
  let disposed: string[]

  beforeEach(async () => {
    shown = []
    disposed = []
    const diffs = new DiffSessions({ show: s => void shown.push(s), dispose: n => void disposed.push(n) })
    const host = makeHost({ 'a.md': 'old\n', 'bad.md': '[[x]]' })
    server = new McpWebSocketServer({
      authToken: TOKEN,
      serverName: 'vcoder-obsidian',
      serverVersion: '0.0.0',
      instructions: () => buildInstructions(host),
      tools: buildTools({ host, diffs, absPath: p => `${ROOT}/${p}` }),
    })
    port = await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('binds to loopback on an ephemeral port', () => {
    expect(port).toBeGreaterThan(0)
  })

  it('rejects missing or wrong auth tokens with 401', async () => {
    expect(await attempt(port, undefined)).toBe(401)
    expect(await attempt(port, 'nope')).toBe(401)
  })

  it('rejects clients that do not offer the mcp subprotocol', async () => {
    const r = await attempt(port, TOKEN, ['other'])
    expect(r).not.toBe('open')
  })

  it('completes the MCP handshake with tools capability and instructions', async () => {
    const { client, ws } = await connectClient(port, TOKEN)
    expect(ws.protocol).toBe('mcp')
    expect(client.getServerCapabilities()?.tools).toBeTruthy()
    expect(client.getInstructions()).toContain('Obsidian')
    await client.close()
  })

  it('lists only model-facing tools (internal RPCs stay callable but hidden)', async () => {
    const { client } = await connectClient(port, TOKEN)
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('getDiagnostics')
    expect(names).toContain('openFile')
    expect(names).not.toContain('openDiff')
    expect(names).not.toContain('close_tab')
    await client.close()
  })

  it('getDiagnostics with uri echoes the same uri first (CLI baseline matching)', async () => {
    const { client } = await connectClient(port, TOKEN)
    const res = await client.callTool({ name: 'getDiagnostics', arguments: { uri: 'file:///vault/bad.md' } })
    expect(res.structuredContent).toBeUndefined()
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text)
    expect(parsed[0].uri).toBe('file:///vault/bad.md')
    expect(parsed[0].diagnostics).toHaveLength(1)

    const clean = await client.callTool({ name: 'getDiagnostics', arguments: { uri: 'file:///vault/a.md' } })
    expect(JSON.parse((clean.content as Array<{ text: string }>)[0].text)).toEqual([{ uri: 'file:///vault/a.md', diagnostics: [] }])

    const all = await client.callTool({ name: 'getDiagnostics', arguments: {} })
    expect(JSON.parse((all.content as Array<{ text: string }>)[0].text)[0].uri).toBe('file:///vault/bad.md')
    await client.close()
  })

  it('openDiff blocks until accepted and returns [FILE_SAVED, contents]', async () => {
    const { client } = await connectClient(port, TOKEN)
    const call = client.callTool({
      name: 'openDiff',
      arguments: { old_file_path: '/vault/a.md', new_file_path: '/vault/a.md', new_file_contents: 'new\n', tab_name: 'tab-1' },
    })
    await waitFor(() => shown.length === 1)
    expect(shown[0]).toMatchObject({ vaultPath: 'a.md', oldContents: 'old\n', newContents: 'new\n', fileExists: true })
    shown[0].resolve({ kind: 'saved', contents: 'new (edited)\n' })
    const res = await call
    expect(res.content).toEqual([
      { type: 'text', text: 'FILE_SAVED' },
      { type: 'text', text: 'new (edited)\n' },
    ])
    await client.close()
  })

  it('close_tab unblocks a pending openDiff with TAB_CLOSED', async () => {
    const { client } = await connectClient(port, TOKEN)
    const call = client.callTool({
      name: 'openDiff',
      arguments: { old_file_path: '/vault/new.md', new_file_path: '/vault/new.md', new_file_contents: 'x', tab_name: 'tab-2' },
    })
    await waitFor(() => shown.length === 1)
    expect(shown[0].fileExists).toBe(false)
    await client.callTool({ name: 'close_tab', arguments: { tab_name: 'tab-2' } })
    expect((await call).content).toEqual([{ type: 'text', text: 'TAB_CLOSED' }])
    expect(disposed).toContain('tab-2')
    await client.close()
  })

  it('openDiff outside the vault errors so the CLI falls back to terminal', async () => {
    const { client } = await connectClient(port, TOKEN)
    const res = await client.callTool({
      name: 'openDiff',
      arguments: { old_file_path: '/etc/passwd', new_file_path: '/etc/passwd', new_file_contents: 'x', tab_name: 't' },
    })
    expect(res.isError).toBe(true)
    await client.close()
  })

  it('dropping the connection settles pending diffs', async () => {
    const { client, ws } = await connectClient(port, TOKEN)
    void client
      .callTool({ name: 'openDiff', arguments: { old_file_path: '/vault/a.md', new_file_path: '/vault/a.md', new_file_contents: 'y', tab_name: 'tab-3' } })
      .catch(() => {})
    await waitFor(() => shown.length === 1)
    ws.terminate()
    await waitFor(() => shown[0].settled)
    expect(disposed).toContain('tab-3')
  })

  it('broadcasts notifications (selection_changed) to connected clients', async () => {
    const { client } = await connectClient(port, TOKEN)
    const got = new Promise<unknown>(resolve => {
      client.fallbackNotificationHandler = async n => resolve(n)
    })
    server.notify('selection_changed', { text: 'hi', filePath: '/vault/a.md', selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } })
    expect(await got).toMatchObject({ method: 'selection_changed', params: { text: 'hi' } })
    await client.close()
  })

  it('emits connection on ide_connected and disconnect on close', async () => {
    const events: string[] = []
    server.on('connection', (_n, info) => events.push(`connect:${info.pid}`))
    server.on('disconnect', n => events.push(`disconnect:${n}`))
    const { client } = await connectClient(port, TOKEN)
    await client.notification({ method: 'ide_connected', params: { pid: 999 } })
    await waitFor(() => events.length === 1)
    await client.close()
    await waitFor(() => events.length === 2)
    expect(events).toEqual(['connect:999', 'disconnect:0'])
  })

  it('openFile rejects paths outside the vault', async () => {
    const { client } = await connectClient(port, TOKEN)
    const bad = await client.callTool({ name: 'openFile', arguments: { filePath: '/etc/hosts' } })
    expect(bad.isError).toBe(true)
    const good = await client.callTool({ name: 'openFile', arguments: { filePath: '/vault/a.md', startText: 'old' } })
    expect((good.content as Array<{ text: string }>)[0].text).toBe('Opened a.md at line 3')
    await client.close()
  })
})

async function waitFor(cond: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}
