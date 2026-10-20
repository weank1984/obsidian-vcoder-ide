import { describe, expect, it } from 'vitest'
import { toFileUri, toVaultPath } from '../src/core/pathGuard'

describe('toVaultPath', () => {
  const root = '/Users/me/Vault'
  it('maps absolute paths and file URIs inside the vault', () => {
    expect(toVaultPath(root, '/Users/me/Vault/notes/a.md')).toBe('notes/a.md')
    expect(toVaultPath(root, 'file:///Users/me/Vault/notes/a.md')).toBe('notes/a.md')
    expect(toVaultPath(root, 'file:///Users/me/Vault/my%20note.md')).toBe('my note.md')
    expect(toVaultPath(root, '/Users/me/Vault/中文 笔记.md')).toBe('中文 笔记.md')
  })
  it('treats relative input as vault-relative', () => {
    expect(toVaultPath(root, 'notes/a.md')).toBe('notes/a.md')
  })
  it('returns empty string for the vault root itself', () => {
    expect(toVaultPath(root, '/Users/me/Vault')).toBe('')
  })
  it('rejects paths outside the vault and traversal', () => {
    expect(toVaultPath(root, '/Users/me/Other/a.md')).toBeNull()
    expect(toVaultPath(root, '/Users/me/VaultX/a.md')).toBeNull()
    expect(toVaultPath(root, '/Users/me/Vault/../secret.md')).toBeNull()
    expect(toVaultPath(root, '../secret.md')).toBeNull()
    expect(toVaultPath(root, '')).toBeNull()
  })
})

describe('toFileUri', () => {
  it('does not percent-encode (CLI compares raw path)', () => {
    expect(toFileUri('/a b/c.md')).toBe('file:///a b/c.md')
  })
})
