import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Lockfile contract consumed by the vcoder CLI (`cli/src/utils/ide.ts`):
 *   <vcoder home>/ide/<port>.lock
 * The port is taken from the file NAME only. `transport: 'ws'` is required —
 * anything else makes the CLI fall back to SSE (which skips token auth).
 */
export interface IdeLockfile {
  workspaceFolders: string[]
  pid: number
  ideName: string
  transport: 'ws'
  runningInWindows: boolean
  authToken: string
}

export interface ResolveIdeDirOptions {
  /** Explicit override from plugin settings (highest priority). */
  override?: string
  env?: NodeJS.ProcessEnv
  home?: string
}

/**
 * Mirrors the CLI's getClaudeConfigHomeDir(): VCODER_HOME > VCODER_CONFIG_DIR
 * > ~/.vcoder, then appends `ide`. Note: Obsidian launched from the Dock does
 * not inherit shell env, so users with a custom VCODER_HOME should set the
 * override in plugin settings.
 */
export function resolveIdeDir(opts: ResolveIdeDirOptions = {}): string {
  const override = opts.override?.trim()
  if (override) return expandHome(override, opts.home)
  const env = opts.env ?? process.env
  const base = env.VCODER_HOME || env.VCODER_CONFIG_DIR || join(opts.home ?? homedir(), '.vcoder')
  return join(expandHome(base, opts.home), 'ide')
}

function expandHome(p: string, home?: string): string {
  if (p === '~') return home ?? homedir()
  if (p.startsWith('~/')) return join(home ?? homedir(), p.slice(2))
  return p
}

export function lockfilePath(ideDir: string, port: number): string {
  return join(ideDir, `${port}.lock`)
}

export function buildLockfile(params: {
  workspaceFolders: string[]
  authToken: string
  pid?: number
  ideName?: string
  platform?: NodeJS.Platform
}): IdeLockfile {
  return {
    workspaceFolders: params.workspaceFolders,
    pid: params.pid ?? process.pid,
    ideName: params.ideName ?? 'Obsidian',
    transport: 'ws',
    runningInWindows: (params.platform ?? process.platform) === 'win32',
    authToken: params.authToken,
  }
}

/** Atomic write (tmp + rename), owner-only permissions. Returns the path. */
export function writeLockfile(ideDir: string, port: number, content: IdeLockfile): string {
  mkdirSync(ideDir, { recursive: true, mode: 0o700 })
  const target = lockfilePath(ideDir, port)
  const tmp = join(ideDir, `.${port}.${randomUUID().slice(0, 8)}.tmp`)
  writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 })
  renameSync(tmp, target)
  return target
}

export function removeLockfile(path: string | undefined): void {
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch {
    // best effort — the CLI also cleans up lockfiles whose pid is dead
  }
}

export function generateAuthToken(): string {
  return randomUUID()
}
