import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLockfile, removeLockfile, resolveIdeDir, writeLockfile } from '../src/core/lockfile'

describe('resolveIdeDir', () => {
  it('defaults to ~/.vcoder/ide', () => {
    expect(resolveIdeDir({ env: {}, home: '/h' })).toBe('/h/.vcoder/ide')
  })
  it('honours VCODER_HOME over VCODER_CONFIG_DIR', () => {
    expect(resolveIdeDir({ env: { VCODER_HOME: '/a', VCODER_CONFIG_DIR: '/b' }, home: '/h' })).toBe('/a/ide')
    expect(resolveIdeDir({ env: { VCODER_CONFIG_DIR: '/b' }, home: '/h' })).toBe('/b/ide')
  })
  it('settings override wins and expands ~', () => {
    expect(resolveIdeDir({ override: '~/custom/ide', env: { VCODER_HOME: '/a' }, home: '/h' })).toBe('/h/custom/ide')
    expect(resolveIdeDir({ override: '   ', env: {}, home: '/h' })).toBe('/h/.vcoder/ide')
  })
})

describe('lockfile write/remove', () => {
  it('writes <port>.lock with the CLI contract and 0600 perms', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'vcoder-ide-')), 'ide')
    const content = buildLockfile({ workspaceFolders: ['/vault'], authToken: 'tok', pid: 42, platform: 'darwin' })
    const path = writeLockfile(dir, 51234, content)
    expect(path).toBe(join(dir, '51234.lock'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      workspaceFolders: ['/vault'],
      pid: 42,
      ideName: 'Obsidian',
      transport: 'ws',
      runningInWindows: false,
      authToken: 'tok',
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // no tmp files left behind
    expect(readdirSync(dir)).toEqual(['51234.lock'])
    removeLockfile(path)
    expect(existsSync(path)).toBe(false)
    expect(() => removeLockfile(path)).not.toThrow()
  })
})
