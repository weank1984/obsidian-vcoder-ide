import { diffLines, diffWordsWithSpace } from 'diff'

export interface InlineSegment {
  text: string
  changed: boolean
}

export interface DiffRow {
  kind: 'context' | 'add' | 'del'
  /** 1-based line numbers; undefined for the side that doesn't have the line. */
  oldLine?: number
  newLine?: number
  text: string
  /** Word-level segments when this row is part of a modified pair. */
  segments?: InlineSegment[]
}

export interface DiffHunk {
  rows: DiffRow[]
}

export interface DiffModel {
  hunks: DiffHunk[]
  added: number
  removed: number
}

function splitLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Builds a unified-diff model with word-level highlights for paired del/add runs. */
export function computeDiff(oldText: string, newText: string, context = 3): DiffModel {
  const parts = diffLines(oldText, newText)
  const rows: DiffRow[] = []
  let oldNo = 1
  let newNo = 1
  let added = 0
  let removed = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const lines = splitLines(part.value)
    if (part.removed) {
      const next = parts[i + 1]
      const addLines = next?.added ? splitLines(next.value) : []
      const pairs = Math.min(lines.length, addLines.length)
      const delRows: DiffRow[] = lines.map(t => ({ kind: 'del', oldLine: oldNo++, text: t }))
      const addRows: DiffRow[] = addLines.map(t => ({ kind: 'add', newLine: newNo++, text: t }))
      for (let k = 0; k < pairs; k++) {
        const [delSeg, addSeg] = wordSegments(lines[k], addLines[k])
        delRows[k].segments = delSeg
        addRows[k].segments = addSeg
      }
      removed += delRows.length
      added += addRows.length
      rows.push(...delRows, ...addRows)
      if (next?.added) i++
    } else if (part.added) {
      for (const t of lines) rows.push({ kind: 'add', newLine: newNo++, text: t })
      added += lines.length
    } else {
      for (const t of lines) rows.push({ kind: 'context', oldLine: oldNo++, newLine: newNo++, text: t })
    }
  }

  return { hunks: groupHunks(rows, context), added, removed }
}

function wordSegments(a: string, b: string): [InlineSegment[], InlineSegment[]] {
  const changes = diffWordsWithSpace(a, b)
  const left: InlineSegment[] = []
  const right: InlineSegment[] = []
  for (const c of changes) {
    if (c.added) right.push({ text: c.value, changed: true })
    else if (c.removed) left.push({ text: c.value, changed: true })
    else {
      left.push({ text: c.value, changed: false })
      right.push({ text: c.value, changed: false })
    }
  }
  return [left, right]
}

function groupHunks(rows: DiffRow[], context: number): DiffHunk[] {
  const changed = rows.map(r => r.kind !== 'context')
  if (!changed.some(Boolean)) return []
  const keep = new Array<boolean>(rows.length).fill(false)
  rows.forEach((_, i) => {
    if (!changed[i]) return
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true
  })
  const hunks: DiffHunk[] = []
  let current: DiffRow[] | undefined
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (!current) {
        current = []
        hunks.push({ rows: current })
      }
      current.push(row)
    } else {
      current = undefined
    }
  })
  return hunks
}
