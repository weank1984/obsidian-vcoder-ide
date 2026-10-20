import { describe, expect, it } from 'vitest'
import { buildSelectionParams, fileOnlyParams, locateRange, selectionKey } from '../src/core/editorState'

function docOf(text: string) {
  return {
    posAt(offset: number) {
      const before = text.slice(0, offset).split('\n')
      return { line: before.length - 1, character: before[before.length - 1].length }
    },
  }
}

describe('buildSelectionParams', () => {
  const text = 'line0\nline1 abc\nline2'
  it('produces 0-based ranges and normalises reversed selections', () => {
    const p = buildSelectionParams('/v/a.md', docOf(text), 15, 8, 'ne1 abc')
    expect(p.selection.start).toEqual({ line: 1, character: 2 })
    expect(p.selection.end).toEqual({ line: 1, character: 9 })
    expect(p.selection.isEmpty).toBe(false)
    expect(p.fileUrl).toBe('file:///v/a.md')
  })
  it('represents a bare cursor as start==end with empty text', () => {
    const p = buildSelectionParams('/v/a.md', docOf(text), 3, 3, '')
    expect(p.selection.start).toEqual(p.selection.end)
    expect(p.selection.isEmpty).toBe(true)
    expect(p.text).toBe('')
  })
  it('selectionKey dedupes identical selections', () => {
    const a = buildSelectionParams('/v/a.md', docOf(text), 1, 4, 'ine')
    const b = buildSelectionParams('/v/a.md', docOf(text), 1, 4, 'ine')
    expect(selectionKey(a)).toBe(selectionKey(b))
    expect(selectionKey(a)).not.toBe(selectionKey(fileOnlyParams('/v/a.md')))
  })
})

describe('locateRange', () => {
  const c = 'alpha\nbeta gamma\ndelta\nepsilon'
  it('finds startText', () => {
    expect(locateRange(c, { startText: 'gamma' })).toEqual([11, 16])
  })
  it('extends to endText after start', () => {
    const [s, e] = locateRange(c, { startText: 'beta', endText: 'delta' })!
    expect(c.slice(s, e)).toBe('beta gamma\ndelta')
  })
  it('selectToEndOfLine extends to line end', () => {
    const [s, e] = locateRange(c, { startText: 'beta', selectToEndOfLine: true })!
    expect(c.slice(s, e)).toBe('beta gamma')
  })
  it('selects 1-based line ranges and clamps', () => {
    const [s, e] = locateRange(c, { startLine: 2, endLine: 3 })!
    expect(c.slice(s, e)).toBe('beta gamma\ndelta')
    const [s2, e2] = locateRange(c, { startLine: 99 })!
    expect(c.slice(s2, e2)).toBe('epsilon')
  })
  it('returns null when nothing matches or nothing requested', () => {
    expect(locateRange(c, { startText: 'zzz' })).toBeNull()
    expect(locateRange(c, {})).toBeNull()
  })
})
