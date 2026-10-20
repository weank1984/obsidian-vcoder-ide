import type { Diagnostic, DiagnosticSeverity, Range } from '../protocol'

/** Subset of Obsidian's Loc/Pos (0-based line/col). */
export interface Loc {
  line: number
  col: number
}
export interface Pos {
  start: Loc
  end: Loc
}

export interface LinkRef {
  /** Raw link target, e.g. `Note#Heading` or `Note#^block` or `#Local`. */
  link: string
  /** Original source text, e.g. `[[Note#Heading|alias]]`. */
  original: string
  position: Pos
  embed: boolean
}

export interface HeadingRef {
  heading: string
  level: number
  position: Pos
}

export type LinkResolution =
  | { kind: 'ok' }
  | { kind: 'missing-file' }
  | { kind: 'missing-heading' }
  | { kind: 'missing-block' }

export interface NoteSnapshot {
  text: string
  links: LinkRef[]
  headings: HeadingRef[]
}

export interface RuleDeps {
  /** Resolves a link target relative to the current note (Obsidian semantics). */
  resolveLink: (link: string) => LinkResolution
  /** YAML parser (Obsidian's parseYaml). Throws on invalid YAML. */
  parseYaml: (yaml: string) => unknown
}

export interface RuleToggles {
  links: boolean
  subpaths: boolean
  frontmatter: boolean
  structure: boolean
}

export const ALL_RULES: RuleToggles = { links: true, subpaths: true, frontmatter: true, structure: true }

export const SOURCE = 'vcoder-ide'

const range = (sl: number, sc: number, el: number, ec: number): Range => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

const posToRange = (p: Pos): Range => range(p.start.line, p.start.col, p.end.line, p.end.col)

function diag(message: string, severity: DiagnosticSeverity, r: Range, code: string): Diagnostic {
  return { message, severity, range: r, source: SOURCE, code }
}

export function runRules(note: NoteSnapshot, deps: RuleDeps, toggles: RuleToggles = ALL_RULES): Diagnostic[] {
  const lines = note.text.split(/\r?\n/)
  const fm = findFrontmatter(lines)
  const out: Diagnostic[] = []
  if (toggles.links || toggles.subpaths) out.push(...checkLinks(note.links, deps, toggles))
  if (toggles.frontmatter && fm) out.push(...checkFrontmatter(lines, fm, deps))
  if (toggles.structure) {
    out.push(...checkFences(lines, fm ? fm.end + 1 : 0))
    out.push(...checkHeadings(note.headings))
  }
  return out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
}

// ── 1 + 2. Links / embeds / heading & block references ────────────────────

export function checkLinks(links: LinkRef[], deps: RuleDeps, toggles: RuleToggles = ALL_RULES): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const l of links) {
    const res = deps.resolveLink(l.link)
    const what = l.embed ? 'embed' : 'link'
    switch (res.kind) {
      case 'missing-file':
        if (toggles.links)
          out.push(diag(`Unresolved ${what}: "${linkPath(l.link)}" does not exist`, 'Warning', posToRange(l.position), 'unresolved-link'))
        break
      case 'missing-heading':
        if (toggles.subpaths)
          out.push(
            diag(`Heading not found: ${l.original} — "${linkSubpath(l.link)}" does not match any heading`, 'Warning', posToRange(l.position), 'unresolved-heading'),
          )
        break
      case 'missing-block':
        if (toggles.subpaths)
          out.push(
            diag(`Block not found: ${l.original} — "${linkSubpath(l.link)}" does not match any block id`, 'Warning', posToRange(l.position), 'unresolved-block'),
          )
        break
    }
  }
  return out
}

export function linkPath(link: string): string {
  const i = link.indexOf('#')
  return i === -1 ? link : link.slice(0, i)
}

export function linkSubpath(link: string): string {
  const i = link.indexOf('#')
  return i === -1 ? '' : link.slice(i)
}

// ── 3. Frontmatter ────────────────────────────────────────────────────────

export interface FrontmatterBlock {
  /** Line index of the opening `---` (always 0). */
  start: number
  /** Line index of the closing `---`. */
  end: number
}

export function findFrontmatter(lines: string[]): FrontmatterBlock | null {
  if (lines[0]?.trimEnd() !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') return { start: 0, end: i }
  }
  return null
}

const TOP_LEVEL_KEY = /^(?:"([^"]+)"|'([^']+)'|([^\s#\-?:|>][^:#]*?))\s*:(?:\s|$)/

export function checkFrontmatter(lines: string[], fm: FrontmatterBlock, deps: Pick<RuleDeps, 'parseYaml'>): Diagnostic[] {
  const out: Diagnostic[] = []
  const seen = new Map<string, number>()
  for (let i = fm.start + 1; i < fm.end; i++) {
    const m = TOP_LEVEL_KEY.exec(lines[i])
    if (!m) continue
    const key = (m[1] ?? m[2] ?? m[3]).trim()
    const first = seen.get(key)
    if (first !== undefined) {
      out.push(
        diag(`Duplicate frontmatter key "${key}" (first defined on line ${first + 1})`, 'Warning', range(i, 0, i, lines[i].length), 'frontmatter-duplicate-key'),
      )
    } else {
      seen.set(key, i)
    }
  }

  const yaml = lines.slice(fm.start + 1, fm.end).join('\n')
  try {
    deps.parseYaml(yaml)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Duplicate keys are already reported precisely above.
    if (!(out.length > 0 && /duplicat/i.test(message))) {
      const errLine = yamlErrorLine(err)
      const line = errLine !== undefined ? Math.min(fm.start + 1 + errLine, fm.end - 1) : fm.start
      out.push(
        diag(`Invalid frontmatter YAML: ${firstLine(message)}`, 'Error', range(line, 0, line, lines[line]?.length ?? 0), 'frontmatter-yaml'),
      )
    }
  }
  return out
}

function yamlErrorLine(err: unknown): number | undefined {
  const e = err as { mark?: { line?: number }; linePos?: Array<{ line: number }> }
  if (typeof e?.mark?.line === 'number') return e.mark.line // js-yaml (0-based)
  if (typeof e?.linePos?.[0]?.line === 'number') return e.linePos[0].line - 1 // `yaml` package (1-based)
  return undefined
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim()
}

// ── 4. Markdown structure ─────────────────────────────────────────────────

const CONTAINER_PREFIX = /^(?:\s*>)*\s*/
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/

export function checkFences(lines: string[], fromLine = 0): Diagnostic[] {
  let open: { line: number; char: string; len: number; col: number } | null = null
  for (let i = fromLine; i < lines.length; i++) {
    const prefix = CONTAINER_PREFIX.exec(lines[i])![0]
    const body = lines[i].slice(prefix.length)
    if (!open) {
      const m = FENCE_OPEN.exec(body)
      if (!m) continue
      // Backtick fence info strings may not contain backticks.
      if (m[1][0] === '`' && m[2].includes('`')) continue
      open = { line: i, char: m[1][0], len: m[1].length, col: prefix.length }
    } else {
      const m = /^(`{3,}|~{3,})\s*$/.exec(body)
      if (m && m[1][0] === open.char && m[1].length >= open.len) open = null
    }
  }
  if (!open) return []
  return [
    diag(
      `Unclosed code block: fence opened here is never closed — the rest of the note renders as code`,
      'Error',
      range(open.line, open.col, open.line, lines[open.line].length),
      'unclosed-fence',
    ),
  ]
}

export function checkHeadings(headings: HeadingRef[]): Diagnostic[] {
  const out: Diagnostic[] = []
  let prev: HeadingRef | undefined
  const seen = new Map<string, HeadingRef>()
  for (const h of headings) {
    if (prev && h.level > prev.level + 1) {
      out.push(diag(`Heading level skips from H${prev.level} to H${h.level}`, 'Info', posToRange(h.position), 'heading-skip'))
    }
    const key = h.heading.trim().toLowerCase()
    const dup = seen.get(key)
    if (dup) {
      out.push(
        diag(
          `Duplicate heading "${h.heading.trim()}" (also on line ${dup.position.start.line + 1}) — [[#${h.heading.trim()}]] links are ambiguous`,
          'Hint',
          posToRange(h.position),
          'duplicate-heading',
        ),
      )
    } else {
      seen.set(key, h)
    }
    prev = h
  }
  return out
}
