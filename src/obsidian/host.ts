import { type App, FileView, MarkdownView, type TFile, type WorkspaceLeaf } from 'obsidian'
import { locateRange } from '../core/editorState'
import type { IdeHost, OpenFileOptions } from '../core/tools'
import type { DiagnosticsProvider } from './diagnosticsProvider'
import type { SelectionSync } from './selectionSync'

export function createHost(params: {
  app: App
  vaultRoot: string
  diagnostics: DiagnosticsProvider
  selection: SelectionSync
}): IdeHost {
  const { app, vaultRoot, diagnostics, selection } = params

  const markdownViewsFor = (vaultPath: string): MarkdownView[] => {
    const out: MarkdownView[] = []
    app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === vaultPath) out.push(leaf.view)
    })
    return out
  }

  return {
    vaultRoot,
    vaultName: app.vault.getName(),

    async readFile(vaultPath) {
      const file = app.vault.getFileByPath(vaultPath)
      if (!file) return null
      // Read from disk, not cache: the CLI computes the diff against disk contents.
      return app.vault.read(file)
    },

    diagnosticsFor: vaultPath => diagnostics.forPath(vaultPath),
    allDiagnostics: () => diagnostics.all(),

    async openFile(vaultPath, opts) {
      const file = app.vault.getFileByPath(vaultPath)
      if (!file) return { found: false }
      const leaf = await openInLeaf(app, file, opts)
      const view = leaf.view
      if (!(view instanceof MarkdownView)) return { found: true }
      const content = view.editor.getValue()
      const range = locateRange(content, opts)
      if (!range) return { found: true }
      const from = view.editor.offsetToPos(range[0])
      const to = view.editor.offsetToPos(range[1])
      if (view.getMode() === 'source') {
        view.editor.setSelection(from, to)
        view.editor.scrollIntoView({ from, to }, true)
      } else {
        leaf.setEphemeralState({ line: from.line })
      }
      return { found: true, line: from.line }
    },

    openEditors() {
      const active = app.workspace.getActiveViewOfType(FileView)?.file?.path
      const seen = new Set<string>()
      const out: Array<{ vaultPath: string; active: boolean; dirty: boolean }> = []
      app.workspace.iterateAllLeaves(leaf => {
        const f = leaf.view instanceof FileView ? leaf.view.file : null
        if (!f || seen.has(f.path)) return
        seen.add(f.path)
        out.push({ vaultPath: f.path, active: f.path === active, dirty: false })
      })
      return out
    },

    currentSelection: () => selection.currentSelection(),
    latestSelection: () => selection.latestSelection(),

    // Obsidian autosaves continuously; there is no public dirty flag.
    isDirty: () => false,

    async save(vaultPath) {
      const views = markdownViewsFor(vaultPath)
      for (const v of views) await v.save()
      return views.length > 0
    },
  }
}

async function openInLeaf(app: App, file: TFile, opts: OpenFileOptions): Promise<WorkspaceLeaf> {
  let existing: WorkspaceLeaf | undefined
  app.workspace.iterateAllLeaves(leaf => {
    if (!existing && leaf.view instanceof FileView && leaf.view.file?.path === file.path) existing = leaf
  })
  if (existing) {
    if (opts.makeFrontmost) {
      app.workspace.setActiveLeaf(existing, { focus: true })
      await app.workspace.revealLeaf(existing)
    }
    return existing
  }
  const leaf = app.workspace.getLeaf(opts.makeFrontmost ? false : 'tab')
  await leaf.openFile(file, { active: opts.makeFrontmost })
  return leaf
}
