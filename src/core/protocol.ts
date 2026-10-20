/** Wire types shared with the vcoder CLI's IDE integration. */

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export type DiagnosticSeverity = 'Error' | 'Warning' | 'Info' | 'Hint'

export interface Diagnostic {
  message: string
  severity: DiagnosticSeverity
  range: Range
  source?: string
  code?: string
}

export interface DiagnosticFile {
  /** Unencoded `file://` + absolute path — the CLI compares it verbatim after stripping `file://`. */
  uri: string
  diagnostics: Diagnostic[]
}

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: TextContent[]
  isError?: boolean
}

export const text = (t: string): TextContent => ({ type: 'text', text: t })

export const ok = (...parts: string[]): ToolResult => ({ content: parts.map(text) })

export const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true })

/** openDiff outcomes understood by cli/src/hooks/useDiffInIDE.ts */
export type DiffOutcome =
  | { kind: 'saved'; contents: string }
  | { kind: 'rejected' }
  | { kind: 'closed' }

export function diffOutcomeToResult(outcome: DiffOutcome): ToolResult {
  switch (outcome.kind) {
    case 'saved':
      // The CLI reads data[1].text unconditionally — both blocks are required.
      return ok('FILE_SAVED', outcome.contents)
    case 'rejected':
      return ok('DIFF_REJECTED')
    case 'closed':
      return ok('TAB_CLOSED')
  }
}
