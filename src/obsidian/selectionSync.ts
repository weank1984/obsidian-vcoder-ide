import { EditorView, type ViewUpdate } from '@codemirror/view'
import { type App, type Editor, FileView, MarkdownView, type TFile, editorInfoField } from 'obsidian'
import {
  buildSelectionParams,
  fileOnlyParams,
  type SelectionChangedParams,
  selectionKey,
} from '../core/editorState'
import type { SelectionSnapshot } from '../core/tools'

const DEBOUNCE_MS = 150

/**
 * Pushes `selection_changed` to vcoder. Tracks the current selection (focused
 * editor) and the latest non-empty selection for getLatestSelection.
 */
export class SelectionSync {
  private timer: number | undefined
  private pending: SelectionChangedParams | undefined
  private lastSentKey = ''
  private current: { params: SelectionChangedParams; vaultPath: string } | undefined
  private latestNonEmpty: { params: SelectionChangedParams; vaultPath: string } | undefined

  constructor(
    private readonly app: App,
    private readonly absPath: (vaultPath: string) => string,
    private readonly send: (params: SelectionChangedParams) => void,
    private readonly shareActiveFile: () => boolean,
  ) {}

  /** CodeMirror extension; register with plugin.registerEditorExtension. */
  extension() {
    return EditorView.updateListener.of((u: ViewUpdate) => {
      if (!(u.selectionSet || u.focusChanged)) return
      if (!u.view.hasFocus) return
      const file = u.state.field(editorInfoField, false)?.file
      if (!file) return
      const sel = u.state.selection.main
      const doc = u.state.doc
      const params = buildSelectionParams(
        this.absPath(file.path),
        {
          posAt: offset => {
            const line = doc.lineAt(offset)
            return { line: line.number - 1, character: offset - line.from }
          },
        },
        sel.from,
        sel.to,
        u.state.sliceDoc(sel.from, sel.to),
      )
      this.update(file.path, params)
    })
  }

  /** active-leaf-change: share the opened file (reading view, PDFs, canvases…). */
  onActiveLeafChange(): void {
    if (!this.shareActiveFile()) return
    const view = this.app.workspace.getActiveViewOfType(FileView)
    const file = view?.file
    if (!file) return
    if (view instanceof MarkdownView && view.getMode() === 'source') {
      const p = this.fromEditor(file, view.editor)
      this.update(file.path, p)
      return
    }
    this.update(file.path, fileOnlyParams(this.absPath(file.path)))
  }

  /** Re-send the current state (e.g. right after vcoder connects). */
  resend(): void {
    if (this.current) {
      this.lastSentKey = ''
      this.queue(this.current.params)
    } else {
      this.onActiveLeafChange()
    }
  }

  currentSelection(): SelectionSnapshot | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (view?.file && view.getMode() === 'source') return toSnapshot(view.file.path, this.fromEditor(view.file, view.editor))
    return this.current ? toSnapshot(this.current.vaultPath, this.current.params) : null
  }

  latestSelection(): SelectionSnapshot | null {
    const l = this.latestNonEmpty ?? this.current
    return l ? toSnapshot(l.vaultPath, l.params) : null
  }

  dispose(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer)
  }

  private fromEditor(file: TFile, editor: Editor): SelectionChangedParams {
    const from = editor.posToOffset(editor.getCursor('from'))
    const to = editor.posToOffset(editor.getCursor('to'))
    return buildSelectionParams(
      this.absPath(file.path),
      {
        posAt: offset => {
          const p = editor.offsetToPos(offset)
          return { line: p.line, character: p.ch }
        },
      },
      from,
      to,
      editor.getSelection(),
    )
  }

  private update(vaultPath: string, params: SelectionChangedParams): void {
    this.current = { params, vaultPath }
    if (params.text.length > 0) this.latestNonEmpty = { params, vaultPath }
    this.queue(params)
  }

  private queue(params: SelectionChangedParams): void {
    this.pending = params
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      const p = this.pending
      this.pending = undefined
      if (!p) return
      const key = selectionKey(p)
      if (key === this.lastSentKey) return
      this.lastSentKey = key
      this.send(p)
    }, DEBOUNCE_MS)
  }
}

function toSnapshot(vaultPath: string, p: SelectionChangedParams): SelectionSnapshot {
  return { vaultPath, text: p.text, selection: { start: p.selection.start, end: p.selection.end } }
}
