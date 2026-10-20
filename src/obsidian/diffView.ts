import { ItemView, type WorkspaceLeaf, setIcon } from 'obsidian'
import { computeDiff, type DiffRow, type InlineSegment } from '../core/diff'
import type { DiffPresenter, DiffSession } from '../core/diffSessions'

export const DIFF_VIEW_TYPE = 'vcoder-diff'

/**
 * Review view for a single `openDiff` call. Accept → FILE_SAVED with the
 * (optionally hand-edited) proposal; Reject or closing the tab → DIFF_REJECTED.
 * The plugin never writes the file itself — the CLI applies accepted edits.
 */
export class DiffView extends ItemView {
  private session: DiffSession | undefined
  private proposal = ''
  private layout: 'unified' | 'split' = 'unified'
  private editing = false
  private bodyEl!: HTMLElement
  private statsEl!: HTMLElement

  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
  }

  getViewType(): string {
    return DIFF_VIEW_TYPE
  }

  getDisplayText(): string {
    return this.session ? `vcoder: ${this.session.vaultPath.split('/').pop()}` : 'vcoder diff'
  }

  getIcon(): string {
    return 'git-compare'
  }

  get tabName(): string | undefined {
    return this.session?.tabName
  }

  attach(session: DiffSession, layout: 'unified' | 'split'): void {
    this.session = session
    this.proposal = session.newContents
    this.layout = layout
    this.editing = false
    // Refresh tab title.
    ;(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.()
    this.render()
  }

  async onOpen(): Promise<void> {
    this.render()
  }

  async onClose(): Promise<void> {
    // Closing the tab by hand counts as a rejection (never auto-accept).
    if (this.session && !this.session.settled) this.session.resolve({ kind: 'rejected' })
  }

  private render(): void {
    const root = this.contentEl
    root.empty()
    root.addClass('vcoder-diff')
    const s = this.session
    if (!s) {
      root.createDiv({ cls: 'vcoder-diff-empty', text: 'This diff is no longer active.' })
      return
    }

    const header = root.createDiv({ cls: 'vcoder-diff-header' })
    const title = header.createDiv({ cls: 'vcoder-diff-title' })
    title.createSpan({ cls: 'vcoder-diff-path', text: s.vaultPath })
    if (!s.fileExists) title.createSpan({ cls: 'vcoder-diff-badge', text: 'new file' })
    this.statsEl = title.createSpan({ cls: 'vcoder-diff-stats' })

    const actions = header.createDiv({ cls: 'vcoder-diff-actions' })
    const layoutBtn = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Toggle layout' } })
    setIcon(layoutBtn, this.layout === 'unified' ? 'columns-2' : 'rows-2')
    layoutBtn.onclick = () => {
      this.layout = this.layout === 'unified' ? 'split' : 'unified'
      this.render()
    }
    const editBtn = actions.createEl('button', { text: this.editing ? 'Preview diff' : 'Edit proposal' })
    editBtn.onclick = () => {
      this.editing = !this.editing
      this.render()
    }
    const reject = actions.createEl('button', { text: 'Reject', cls: 'mod-warning' })
    reject.onclick = () => s.resolve({ kind: 'rejected' })
    const accept = actions.createEl('button', { text: this.proposal === s.newContents ? 'Accept' : 'Accept edited', cls: 'mod-cta' })
    accept.onclick = () => s.resolve({ kind: 'saved', contents: this.proposal })

    this.bodyEl = root.createDiv({ cls: 'vcoder-diff-body' })
    if (this.editing) this.renderEditor()
    else this.renderDiff()
  }

  private renderEditor(): void {
    const ta = this.bodyEl.createEl('textarea', { cls: 'vcoder-diff-editor' })
    ta.value = this.proposal
    ta.spellcheck = false
    ta.oninput = () => {
      this.proposal = ta.value
    }
    window.setTimeout(() => ta.focus(), 0)
    this.updateStats()
  }

  private renderDiff(): void {
    const s = this.session!
    const model = computeDiff(s.oldContents, this.proposal)
    this.updateStats(model.added, model.removed)
    if (model.hunks.length === 0) {
      this.bodyEl.createDiv({ cls: 'vcoder-diff-empty', text: 'No changes.' })
      return
    }
    const table = this.bodyEl.createDiv({ cls: `vcoder-diff-table is-${this.layout}` })
    model.hunks.forEach((hunk, i) => {
      if (i > 0) table.createDiv({ cls: 'vcoder-diff-sep', text: '⋯' })
      if (this.layout === 'unified') hunk.rows.forEach(r => this.unifiedRow(table, r))
      else this.splitRows(table, hunk.rows)
    })
  }

  private updateStats(added?: number, removed?: number): void {
    this.statsEl.empty()
    if (added === undefined || removed === undefined) return
    this.statsEl.createSpan({ cls: 'vcoder-add', text: `+${added}` })
    this.statsEl.createSpan({ cls: 'vcoder-del', text: ` −${removed}` })
  }

  private unifiedRow(parent: HTMLElement, r: DiffRow): void {
    const row = parent.createDiv({ cls: `vcoder-row is-${r.kind}` })
    row.createSpan({ cls: 'vcoder-ln', text: r.oldLine?.toString() ?? '' })
    row.createSpan({ cls: 'vcoder-ln', text: r.newLine?.toString() ?? '' })
    row.createSpan({ cls: 'vcoder-sign', text: r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' ' })
    this.code(row, r.text, r.segments)
  }

  private splitRows(parent: HTMLElement, rows: DiffRow[]): void {
    let i = 0
    while (i < rows.length) {
      const r = rows[i]
      if (r.kind === 'context') {
        this.splitRow(parent, r, r)
        i++
        continue
      }
      const dels: DiffRow[] = []
      const adds: DiffRow[] = []
      while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++])
      while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++])
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) this.splitRow(parent, dels[k], adds[k])
    }
  }

  private splitRow(parent: HTMLElement, left: DiffRow | undefined, right: DiffRow | undefined): void {
    const row = parent.createDiv({ cls: 'vcoder-row is-split' })
    const side = (r: DiffRow | undefined, which: 'old' | 'new') => {
      const cell = row.createDiv({ cls: `vcoder-cell is-${r ? r.kind : 'empty'}` })
      cell.createSpan({ cls: 'vcoder-ln', text: (which === 'old' ? r?.oldLine : r?.newLine)?.toString() ?? '' })
      if (r) this.code(cell, r.text, r.segments)
    }
    side(left, 'old')
    side(right, 'new')
  }

  private code(parent: HTMLElement, text: string, segments?: InlineSegment[]): void {
    const el = parent.createSpan({ cls: 'vcoder-code' })
    if (!segments) {
      el.setText(text || ' ')
      return
    }
    for (const seg of segments) el.createSpan({ cls: seg.changed ? 'vcoder-word' : undefined, text: seg.text })
  }
}

/** Opens/closes DiffView tabs for DiffSessions. */
export class ObsidianDiffPresenter implements DiffPresenter {
  constructor(
    private readonly app: import('obsidian').App,
    private readonly getLayout: () => 'unified' | 'split',
  ) {}

  async show(session: DiffSession): Promise<void> {
    const leaf = this.app.workspace.getLeaf('tab')
    await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true })
    const view = leaf.view
    if (!(view instanceof DiffView)) throw new Error('vcoder diff view not available')
    view.attach(session, this.getLayout())
    await this.app.workspace.revealLeaf(leaf)
  }

  dispose(tabName: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE)) {
      if (leaf.view instanceof DiffView && leaf.view.tabName === tabName) leaf.detach()
    }
  }
}
