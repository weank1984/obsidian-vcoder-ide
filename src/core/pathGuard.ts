import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Converts an absolute path (or `file://` URI) coming from the CLI into a
 * vault-relative POSIX path. Returns null when the path is outside the vault.
 */
export function toVaultPath(vaultRoot: string, input: string): string | null {
  if (!input) return null
  let p = input
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length)
    // Tolerate percent-encoded URIs even though the CLI sends raw paths.
    if (/%[0-9A-Fa-f]{2}/.test(p)) {
      try {
        p = decodeURIComponent(p)
      } catch {
        /* keep raw */
      }
    }
  }
  const root = resolve(vaultRoot)
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(root, abs)
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

export function toAbsolutePath(vaultRoot: string, vaultPath: string): string {
  return resolve(vaultRoot, ...vaultPath.split('/'))
}

/** Unencoded file URI; the CLI compares it after stripping `file://`. */
export function toFileUri(absPath: string): string {
  return `file://${absPath}`
}
