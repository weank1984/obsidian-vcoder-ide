// Fake "Obsidian" IDE peer for protocol testing against a real vcoder CLI.
//
//   npm run smoke -- [vaultDir]
//
// Starts the plugin's MCP WebSocket server (same code as the plugin) with a
// file-system-backed host, writes the lockfile to ~/.vcoder/ide, and auto-
// answers openDiff according to FAKE_IDE_DIFF=accept|reject|hold (default
// accept). Then run `vcoder` inside vaultDir and use /ide.
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const outDir = resolve('node_modules/.cache/vcoder-ide-smoke')
mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, 'core.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export * from './src/core/mcpServer'
      export * from './src/core/lockfile'
      export * from './src/core/tools'
      export * from './src/core/diffSessions'
      export * from './src/core/pathGuard'
    `,
    resolveDir: resolve('.'),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  external: ['ws', 'diff'],
  logLevel: 'silent',
})
const core = await import(pathToFileURL(outfile).href)

const vault = resolve(process.argv[2] ?? join(tmpdir(), 'vcoder-fake-vault'))
mkdirSync(vault, { recursive: true })
const mode = process.env.FAKE_IDE_DIFF ?? 'accept'
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const walk = dir =>
  readdirSync(dir).flatMap(n => {
    if (n.startsWith('.')) return []
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const host = {
  vaultRoot: vault,
  vaultName: 'fake-vault',
  readFile: async p => (existsSync(join(vault, p)) ? readFileSync(join(vault, p), 'utf8') : null),
  diagnosticsFor: async p => {
    const abs = join(vault, p)
    if (!existsSync(abs)) return []
    const text = readFileSync(abs, 'utf8')
    return text.split('\n').flatMap((line, i) =>
      [...line.matchAll(/\[\[([^\]|#]+)/g)]
        .filter(m => !existsSync(join(vault, `${m[1]}.md`)))
        .map(m => ({
          message: `Unresolved link: "${m[1]}" does not exist`,
          severity: 'Warning',
          range: { start: { line: i, character: m.index }, end: { line: i, character: m.index + m[0].length + 2 } },
          source: 'vcoder-ide',
          code: 'unresolved-link',
        })),
    )
  },
  allDiagnostics: async () => {
    const out = []
    for (const abs of walk(vault).filter(p => p.endsWith('.md'))) {
      const vaultPath = abs.slice(vault.length + 1)
      const diagnostics = await host.diagnosticsFor(vaultPath)
      if (diagnostics.length) out.push({ vaultPath, diagnostics })
    }
    return out
  },
  openFile: async (p, opts) => {
    log('openFile', p, JSON.stringify(opts))
    return { found: existsSync(join(vault, p)), line: 0 }
  },
  openEditors: () => [],
  currentSelection: () => null,
  latestSelection: () => null,
  isDirty: () => false,
  save: async () => false,
}

const diffs = new core.DiffSessions({
  show: s => {
    log(`openDiff ${s.vaultPath} (${s.fileExists ? 'modify' : 'create'}) tab=${s.tabName} → ${mode}`)
    if (mode === 'accept') setTimeout(() => s.resolve({ kind: 'saved', contents: s.newContents }), 300)
    if (mode === 'reject') setTimeout(() => s.resolve({ kind: 'rejected' }), 300)
  },
  dispose: tab => log('dispose', tab),
})

const authToken = core.generateAuthToken()
const server = new core.McpWebSocketServer({
  authToken,
  serverName: 'vcoder-obsidian',
  serverVersion: 'smoke',
  instructions: () => core.buildInstructions(host),
  tools: core.buildTools({ host, diffs, absPath: p => core.toAbsolutePath(vault, p) }),
  log,
})
server.on('connection', (n, info) => log(`ide_connected pid=${info.pid} (connections=${n})`))
server.on('disconnect', n => log(`disconnect (connections=${n})`))

const port = await server.start()
const lock = core.writeLockfile(core.resolveIdeDir(), port, core.buildLockfile({ workspaceFolders: [vault], authToken, ideName: 'Obsidian' }))
log(`listening ws://127.0.0.1:${port}  lockfile=${lock}`)
log(`vault=${vault}  diff=${mode}`)
log(`run:  cd ${JSON.stringify(vault)} && VCODER_SSE_PORT=${port} vcoder`)

// Optional: push a selection after connect, to test the CLI footer.
server.on('connection', () => {
  const first = walk(vault).find(p => p.endsWith('.md'))
  if (!first) return
  const text = readFileSync(first, 'utf8').split('\n').slice(0, 2).join('\n')
  setTimeout(() => {
    server.notify('selection_changed', {
      text,
      filePath: first,
      fileUrl: `file://${first}`,
      selection: { start: { line: 0, character: 0 }, end: { line: 1, character: text.split('\n')[1]?.length ?? 0 }, isEmpty: false },
    })
    log('sent selection_changed', first)
  }, 500)
})

const shutdown = async () => {
  core.removeLockfile(lock)
  await server.stop()
  log('stopped, lockfile removed')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
