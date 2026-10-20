import type { Range } from './protocol'

export interface OffsetDoc {
  /** 0-based line + column for a document offset. */
  posAt(offset: number): { line: number; character: number }
}

export interface SelectionChangedParams {
  [key: string]: unknown
  text: string
  filePath: string
  fileUrl: string
  selection: Range & { isEmpty: boolean }
}

/**
 * Builds `selection_changed` params as the CLI expects them
 * (cli/src/hooks/useIdeSelection.ts): 0-based lines, `start`/`end` always
 * present. A bare cursor is sent as start==end with empty text, which the CLI
 * renders as "In <file>" and turns into an "opened file" attachment.
 */
export function buildSelectionParams(absPath: string, doc: OffsetDoc, from: number, to: number, text: string): SelectionChangedParams {
  const [a, b] = from <= to ? [from, to] : [to, from]
  const start = doc.posAt(a)
  const end = doc.posAt(b)
  return {
    text,
    filePath: absPath,
    fileUrl: `file://${absPath}`,
    selection: { start, end, isEmpty: a === b },
  }
}

export function fileOnlyParams(absPath: string): SelectionChangedParams {
  const zero = { line: 0, character: 0 }
  return { text: '', filePath: absPath, fileUrl: `file://${absPath}`, selection: { start: zero, end: zero, isEmpty: true } }
}

export function selectionKey(p: SelectionChangedParams): string {
  const s = p.selection
  return `${p.filePath}:${s.start.line}:${s.start.character}:${s.end.line}:${s.end.character}:${p.text.length}`
}

export interface LocateOptions {
  startText?: string
  endText?: string
  /** 1-based */
  startLine?: number
  /** 1-based */
  endLine?: number
  selectToEndOfLine?: boolean
}

/** Returns [fromOffset, toOffset] in `content` or null when nothing to select / not found. */
export function locateRange(content: string, opts: LocateOptions): [number, number] | null {
  const lineStarts = [0]
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1)
  const lineEnd = (line: number) => {
    const next = lineStarts[line + 1]
    return next === undefined ? content.length : next - 1
  }
  const lineOf = (offset: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  if (opts.startText) {
    const s = content.indexOf(opts.startText)
    if (s === -1) return null
    let e = s + opts.startText.length
    if (opts.endText) {
      const ei = content.indexOf(opts.endText, s)
      if (ei !== -1) e = ei + opts.endText.length
    }
    if (opts.selectToEndOfLine) e = lineEnd(lineOf(e === s ? e : e - 1))
    return [s, e]
  }

  if (opts.startLine !== undefined) {
    const last = lineStarts.length - 1
    const sl = clamp(Math.floor(opts.startLine) - 1, 0, last)
    const el = clamp(Math.floor(opts.endLine ?? opts.startLine) - 1, sl, last)
    return [lineStarts[sl], lineEnd(el)]
  }
  return null
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
