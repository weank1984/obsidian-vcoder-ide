import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  checkFences,
  checkFrontmatter,
  checkHeadings,
  findFrontmatter,
  runRules,
  type HeadingRef,
  type LinkRef,
  type LinkResolution,
  type RuleDeps,
} from '../src/core/diagnostics/rules'

const pos = (line: number, col: number, endCol: number) => ({ start: { line, col }, end: { line, col: endCol } })

const deps = (table: Record<string, LinkResolution['kind']> = {}): RuleDeps => ({
  resolveLink: link => ({ kind: table[link] ?? 'ok' }) as LinkResolution,
  parseYaml: y => parseYaml(y, { uniqueKeys: false }),
})

describe('link rules', () => {
  const links: LinkRef[] = [
    { link: 'Missing', original: '[[Missing]]', position: pos(2, 0, 11), embed: false },
    { link: 'img.png', original: '![[img.png]]', position: pos(3, 0, 12), embed: true },
    { link: 'Note#Nope', original: '[[Note#Nope]]', position: pos(4, 0, 13), embed: false },
    { link: 'Note#^abc', original: '[[Note#^abc]]', position: pos(5, 0, 13), embed: false },
    { link: 'Fine', original: '[[Fine]]', position: pos(6, 0, 8), embed: false },
  ]
  const d = deps({ Missing: 'missing-file', 'img.png': 'missing-file', 'Note#Nope': 'missing-heading', 'Note#^abc': 'missing-block' })
  const note = { text: '\n'.repeat(7), links, headings: [] }

  it('reports unresolved links, embeds, headings and blocks with 0-based ranges', () => {
    const out = runRules(note, d)
    expect(out.map(x => [x.code, x.severity, x.range.start.line])).toEqual([
      ['unresolved-link', 'Warning', 2],
      ['unresolved-link', 'Warning', 3],
      ['unresolved-heading', 'Warning', 4],
      ['unresolved-block', 'Warning', 5],
    ])
    expect(out[1].message).toContain('Unresolved embed')
    expect(out[0].source).toBe('vcoder-ide')
  })

  it('respects rule toggles', () => {
    const out = runRules(note, d, { links: true, subpaths: false, frontmatter: true, structure: true })
    expect(out.map(x => x.code)).toEqual(['unresolved-link', 'unresolved-link'])
  })
})

describe('frontmatter rules', () => {
  it('finds frontmatter only at the top', () => {
    expect(findFrontmatter(['---', 'a: 1', '---', 'body'])).toEqual({ start: 0, end: 2 })
    expect(findFrontmatter(['body', '---', 'a: 1', '---'])).toBeNull()
    expect(findFrontmatter(['---', 'a: 1'])).toBeNull()
  })

  it('reports duplicate top-level keys but not nested ones', () => {
    const lines = ['---', 'title: a', 'tags:', '  - x', 'meta:', '  title: nested', 'title: b', '---']
    const out = checkFrontmatter(lines, findFrontmatter(lines)!, deps())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: 'frontmatter-duplicate-key', severity: 'Warning', range: { start: { line: 6 } } })
    expect(out[0].message).toContain('line 2')
  })

  it('reports invalid YAML as Error near the offending line', () => {
    const lines = ['---', 'title: ok', 'bad: [unclosed', '---', 'body']
    const out = checkFrontmatter(lines, findFrontmatter(lines)!, deps())
    expect(out).toHaveLength(1)
    expect(out[0].code).toBe('frontmatter-yaml')
    expect(out[0].severity).toBe('Error')
    expect(out[0].range.start.line).toBeGreaterThanOrEqual(1)
    expect(out[0].range.start.line).toBeLessThanOrEqual(2)
  })

  it('valid frontmatter is clean', () => {
    const lines = ['---', 'title: ok', 'tags: [a, b]', '"quoted key": 1', '---']
    expect(checkFrontmatter(lines, findFrontmatter(lines)!, deps())).toEqual([])
  })
})

describe('structure rules', () => {
  it('flags an unclosed fence at its opening line', () => {
    const out = checkFences(['text', '```js', 'code', '~~~', 'more'])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: 'unclosed-fence', severity: 'Error', range: { start: { line: 1 } } })
  })

  it('accepts closed fences, longer closers and fences in callouts', () => {
    expect(checkFences(['```', 'a', '```'])).toEqual([])
    expect(checkFences(['````md', '```', 'inner', '```', '````'])).toEqual([])
    expect(checkFences(['> ```', '> code', '> ```'])).toEqual([])
    expect(checkFences(['~~~', '```', '~~~'])).toEqual([])
  })

  it('ignores inline triple backticks with backticks in the info string', () => {
    expect(checkFences(['```a```'])).toEqual([])
  })

  it('reports heading level skips and duplicate headings', () => {
    const h = (heading: string, level: number, line: number): HeadingRef => ({ heading, level, position: pos(line, 0, heading.length + level + 1) })
    const out = checkHeadings([h('Title', 1, 0), h('Deep', 3, 2), h('Intro', 2, 4), h('Intro', 2, 6)])
    expect(out.map(d => [d.code, d.severity, d.range.start.line])).toEqual([
      ['heading-skip', 'Info', 2],
      ['duplicate-heading', 'Hint', 6],
    ])
  })

  it('does not inspect fences inside frontmatter', () => {
    const text = ['---', 'x: "```"', '---', 'body'].join('\n')
    expect(runRules({ text, links: [], headings: [] }, deps())).toEqual([])
  })
})
