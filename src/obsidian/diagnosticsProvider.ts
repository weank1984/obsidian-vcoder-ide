import { type App, type CachedMetadata, type TFile, parseYaml, resolveSubpath } from 'obsidian'
import type { Diagnostic } from '../core/protocol'
import { type LinkRef, type LinkResolution, type RuleToggles, linkPath, linkSubpath, runRules } from '../core/diagnostics/rules'

export class DiagnosticsProvider {
  constructor(
    private readonly app: App,
    private readonly getToggles: () => RuleToggles,
    private readonly getMaxFiles: () => number,
  ) {}

  async forPath(vaultPath: string): Promise<Diagnostic[]> {
    const file = this.app.vault.getFileByPath(vaultPath)
    if (!file || file.extension !== 'md') return []
    return this.forFile(file)
  }

  async all(): Promise<Array<{ vaultPath: string; diagnostics: Diagnostic[] }>> {
    const files = this.app.vault.getMarkdownFiles().slice(0, this.getMaxFiles())
    const out: Array<{ vaultPath: string; diagnostics: Diagnostic[] }> = []
    for (const f of files) {
      const diagnostics = await this.forFile(f)
      if (diagnostics.length > 0) out.push({ vaultPath: f.path, diagnostics })
    }
    return out
  }

  async forFile(file: TFile): Promise<Diagnostic[]> {
    // Prefer live editor contents when the note is open with unsaved edits.
    const text = await this.app.vault.cachedRead(file)
    const cache = this.app.metadataCache.getFileCache(file)
    return runRules(
      {
        text,
        links: collectLinks(cache),
        headings: (cache?.headings ?? []).map(h => ({ heading: h.heading, level: h.level, position: h.position })),
      },
      {
        resolveLink: link => this.resolve(link, file, cache),
        parseYaml,
      },
      this.getToggles(),
    )
  }

  private resolve(link: string, source: TFile, sourceCache: CachedMetadata | null): LinkResolution {
    const path = linkPath(link)
    const subpath = linkSubpath(link)
    // External/URL links are not checked.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return { kind: 'ok' }
    let target: TFile | null = source
    let cache = sourceCache
    if (path !== '') {
      target = this.app.metadataCache.getFirstLinkpathDest(decodeLinkPath(path), source.path)
      if (!target) return { kind: 'missing-file' }
      cache = target.extension === 'md' ? this.app.metadataCache.getFileCache(target) : null
    }
    if (!subpath || subpath === '#' || target.extension !== 'md') return { kind: 'ok' }
    if (!cache) return { kind: 'ok' } // not indexed yet — don't guess
    if (resolveSubpath(cache, subpath)) return { kind: 'ok' }
    return { kind: subpath.startsWith('#^') ? 'missing-block' : 'missing-heading' }
  }
}

function collectLinks(cache: CachedMetadata | null): LinkRef[] {
  if (!cache) return []
  return [
    ...(cache.links ?? []).map(l => ({ link: l.link, original: l.original, position: l.position, embed: false })),
    ...(cache.embeds ?? []).map(l => ({ link: l.link, original: l.original, position: l.position, embed: true })),
  ]
}

function decodeLinkPath(p: string): string {
  // Markdown-style links ([x](My%20Note.md)) are URL-encoded.
  if (!/%[0-9A-Fa-f]{2}/.test(p)) return p
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}
