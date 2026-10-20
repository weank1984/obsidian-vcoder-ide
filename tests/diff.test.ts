import { describe, expect, it } from 'vitest'
import { computeDiff } from '../src/core/diff'

describe('computeDiff', () => {
  it('returns no hunks for identical text', () => {
    expect(computeDiff('a\nb\n', 'a\nb\n')).toEqual({ hunks: [], added: 0, removed: 0 })
  })

  it('pairs modified lines with word-level segments and line numbers', () => {
    const m = computeDiff('one\ntwo apples\nthree\n', 'one\ntwo pears\nthree\n')
    expect(m.added).toBe(1)
    expect(m.removed).toBe(1)
    const rows = m.hunks[0].rows
    expect(rows.map(r => [r.kind, r.oldLine, r.newLine, r.text])).toEqual([
      ['context', 1, 1, 'one'],
      ['del', 2, undefined, 'two apples'],
      ['add', undefined, 2, 'two pears'],
      ['context', 3, 3, 'three'],
    ])
    expect(rows[1].segments?.filter(s => s.changed).map(s => s.text)).toEqual(['apples'])
    expect(rows[2].segments?.filter(s => s.changed).map(s => s.text)).toEqual(['pears'])
  })

  it('splits distant changes into separate hunks', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n'
    const next = old.replace('l1\n', 'L1\n').replace('l18\n', 'L18\n')
    const m = computeDiff(old, next, 2)
    expect(m.hunks).toHaveLength(2)
  })

  it('handles new files', () => {
    const m = computeDiff('', 'hello\nworld\n')
    expect(m.added).toBe(2)
    expect(m.hunks[0].rows.every(r => r.kind === 'add')).toBe(true)
  })
})
