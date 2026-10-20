import type { ToolDefinition } from './mcpServer'
import { diffOutcomeToResult, fail, ok, type DiagnosticFile, type Range } from './protocol'
import { DiffSessions } from './diffSessions'
import { toFileUri, toVaultPath } from './pathGuard'

export interface SelectionSnapshot {
  /** Vault-relative path. */
  vaultPath: string
  text: string
  selection: Range
}

export interface OpenFileOptions {
  startText?: string
  endText?: string
  startLine?: number
  endLine?: number
  selectToEndOfLine?: boolean
  makeFrontmost: boolean
  preview?: boolean
}

/** What the Obsidian side must provide to the tool layer. */
export interface IdeHost {
  vaultRoot: string
  vaultName: string
  readFile(vaultPath: string): Promise<string | null>
  /** Diagnostics for one vault file (empty array for non-notes/missing files). */
  diagnosticsFor(vaultPath: string): Promise<DiagnosticFile['diagnostics']>
  /** Diagnostics for all notes; only files with at least one diagnostic. */
  allDiagnostics(): Promise<Array<{ vaultPath: string; diagnostics: DiagnosticFile['diagnostics'] }>>
  openFile(vaultPath: string, opts: OpenFileOptions): Promise<{ found: boolean; line?: number }>
  openEditors(): Array<{ vaultPath: string; active: boolean; dirty: boolean }>
  currentSelection(): SelectionSnapshot | null
  latestSelection(): SelectionSnapshot | null
  isDirty(vaultPath: string): boolean
  save(vaultPath: string): Promise<boolean>
}

export interface BuildToolsDeps {
  host: IdeHost
  diffs: DiffSessions
  absPath: (vaultPath: string) => string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const json = (v: unknown) => ok(JSON.stringify(v))

export function buildTools({ host, diffs, absPath }: BuildToolsDeps): ToolDefinition[] {
  const guard = (p: string | undefined) => (p ? toVaultPath(host.vaultRoot, p) : null)

  const selectionJson = (s: SelectionSnapshot | null) =>
    s
      ? { success: true, text: s.text, filePath: absPath(s.vaultPath), fileUrl: toFileUri(absPath(s.vaultPath)), selection: { ...s.selection, isEmpty: s.text.length === 0 } }
      : { success: false, message: 'No active editor found' }

  return [
    // ── Internal RPCs driven by the CLI permission dialog (not listed) ──
    {
      name: 'openDiff',
      listed: false,
      description: 'Open a diff view comparing the current file with proposed contents; blocks until the user decides.',
      inputSchema: {
        type: 'object',
        properties: {
          old_file_path: { type: 'string' },
          new_file_path: { type: 'string' },
          new_file_contents: { type: 'string' },
          tab_name: { type: 'string' },
        },
        required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'],
      },
      handler: async (args, ctx) => {
        const target = str(args.new_file_path) ?? str(args.old_file_path)
        const newContents = str(args.new_file_contents)
        const tabName = str(args.tab_name)
        if (!target || newContents === undefined || !tabName) return fail('openDiff: missing arguments')
        const vaultPath = guard(target)
        // Outside the vault → error so the CLI falls back to its terminal prompt.
        if (vaultPath === null || vaultPath === '') return fail(`openDiff: ${target} is outside the vault`)
        const existing = await host.readFile(vaultPath)
        const outcome = await diffs.open(
          {
            tabName,
            absPath: absPath(vaultPath),
            vaultPath,
            oldContents: existing ?? '',
            fileExists: existing !== null,
            newContents,
          },
          ctx.signal,
        )
        return diffOutcomeToResult(outcome)
      },
    },
    {
      name: 'close_tab',
      listed: false,
      description: 'Close a diff tab by name.',
      inputSchema: { type: 'object', properties: { tab_name: { type: 'string' } }, required: ['tab_name'] },
      handler: args => {
        const tabName = str(args.tab_name)
        if (tabName) diffs.close(tabName)
        return ok('TAB_CLOSED')
      },
    },
    {
      name: 'closeAllDiffTabs',
      listed: false,
      description: 'Close all diff tabs opened by vcoder.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ok(`CLOSED_${diffs.closeAll()}_DIFF_TABS`),
    },

    // ── Model-facing tools (CLI allowlist: getDiagnostics, openFile) ──
    {
      name: 'getDiagnostics',
      description:
        'Get note diagnostics from Obsidian: unresolved [[wikilinks]]/embeds, missing #heading / #^block references, invalid or duplicate frontmatter keys, unclosed code fences, heading level skips and duplicate headings. Pass a file URI (file:///abs/path.md) for one note, or omit it for every note in the vault that has problems.',
      inputSchema: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'Optional file URI (file:///absolute/path.md). Omit to scan the whole vault.' },
        },
      },
      handler: async args => {
        const uri = str(args.uri)
        if (uri) {
          const vaultPath = guard(uri)
          // Always echo the requested file first — the CLI matches it as baseline.
          const echoUri = uri.startsWith('file://') ? uri : toFileUri(uri)
          if (vaultPath === null || vaultPath === '') return json([{ uri: echoUri, diagnostics: [] }])
          return json([{ uri: echoUri, diagnostics: await host.diagnosticsFor(vaultPath) }])
        }
        const all = await host.allDiagnostics()
        return json(all.map(f => ({ uri: toFileUri(absPath(f.vaultPath)), diagnostics: f.diagnostics })))
      },
    },
    {
      name: 'openFile',
      description:
        'Open a note or file in Obsidian and optionally select a range. Use startText/endText (exact text to find) or startLine/endLine (1-based) to highlight a passage for the user.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path or vault-relative path of the file.' },
          startText: { type: 'string', description: 'Text marking the start of the selection.' },
          endText: { type: 'string', description: 'Text marking the end of the selection (requires startText).' },
          startLine: { type: 'number', description: '1-based start line (alternative to startText).' },
          endLine: { type: 'number', description: '1-based end line.' },
          selectToEndOfLine: { type: 'boolean', description: 'Extend selection to end of the endText line.' },
          makeFrontmost: { type: 'boolean', description: 'Focus the opened file (default true).' },
          preview: { type: 'boolean', description: 'Ignored in Obsidian.' },
        },
        required: ['filePath'],
      },
      handler: async args => {
        const filePath = str(args.filePath)
        const vaultPath = guard(filePath)
        if (!filePath || vaultPath === null || vaultPath === '') return fail(`File is outside the vault: ${filePath ?? ''}`)
        const res = await host.openFile(vaultPath, {
          startText: str(args.startText) || undefined,
          endText: str(args.endText) || undefined,
          startLine: num(args.startLine),
          endLine: num(args.endLine),
          selectToEndOfLine: args.selectToEndOfLine === true,
          makeFrontmost: args.makeFrontmost !== false,
          preview: args.preview === true,
        })
        if (!res.found) return fail(`File not found in vault: ${vaultPath}`)
        return ok(res.line !== undefined ? `Opened ${vaultPath} at line ${res.line + 1}` : `Opened ${vaultPath}`)
      },
    },

    // ── Compatibility RPCs (parity with the official IDE extension) ──
    {
      name: 'getWorkspaceFolders',
      description: 'Get the Obsidian vault folder.',
      inputSchema: { type: 'object', properties: {} },
      handler: () =>
        json({
          success: true,
          folders: [{ name: host.vaultName, uri: toFileUri(host.vaultRoot), path: host.vaultRoot }],
          rootPath: host.vaultRoot,
        }),
    },
    {
      name: 'getOpenEditors',
      description: 'List notes currently open in Obsidian.',
      inputSchema: { type: 'object', properties: {} },
      handler: () =>
        json({
          tabs: host.openEditors().map(e => ({
            uri: toFileUri(absPath(e.vaultPath)),
            isActive: e.active,
            label: e.vaultPath.split('/').pop(),
            languageId: e.vaultPath.endsWith('.md') ? 'markdown' : 'plaintext',
            isDirty: e.dirty,
          })),
        }),
    },
    {
      name: 'getCurrentSelection',
      description: 'Get the current selection in the active Obsidian editor.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => json(selectionJson(host.currentSelection())),
    },
    {
      name: 'getLatestSelection',
      description: 'Get the most recent selection in any Obsidian editor.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => json(selectionJson(host.latestSelection())),
    },
    {
      name: 'checkDocumentDirty',
      description: 'Check whether a note has unsaved changes.',
      inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      handler: args => {
        const filePath = str(args.filePath)
        const vaultPath = guard(filePath)
        if (!filePath || vaultPath === null) return json({ success: false, message: `Document not open: ${filePath ?? ''}` })
        return json({ success: true, filePath, isDirty: host.isDirty(vaultPath), isUntitled: false })
      },
    },
    {
      name: 'saveDocument',
      description: 'Save a note that is open in Obsidian.',
      inputSchema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
      handler: async args => {
        const filePath = str(args.filePath)
        const vaultPath = guard(filePath)
        if (!filePath || vaultPath === null) return json({ success: false, message: `Document not open: ${filePath ?? ''}` })
        const saved = await host.save(vaultPath)
        return json({ success: saved, filePath, saved, message: saved ? 'Document saved' : 'Document not open' })
      },
    },
  ]
}

export function buildInstructions(host: Pick<IdeHost, 'vaultRoot' | 'vaultName'>): string {
  return [
    `The connected IDE is Obsidian (vault "${host.vaultName}" at ${host.vaultRoot}).`,
    'Files are Markdown notes. Notes link to each other with [[wikilinks]] (optionally [[Note#Heading]], [[Note#^block-id]] or [[Note|alias]]) and embed with ![[...]]; link targets resolve by note name, not path. When renaming or moving a note, update links that point to it.',
    'Prefer the mcp__ide__getDiagnostics tool to check notes for broken links, bad frontmatter and structural issues after editing.',
    'Use mcp__ide__openFile to open a note in Obsidian and highlight a passage when you want the user to look at it.',
  ].join('\n')
}
