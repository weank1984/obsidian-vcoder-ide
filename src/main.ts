import { type Editor, FileSystemAdapter, Notice, Plugin, type TAbstractFile, TFile } from 'obsidian'
import { DiffSessions } from './core/diffSessions'
import { buildLockfile, generateAuthToken, removeLockfile, resolveIdeDir, writeLockfile } from './core/lockfile'
import { McpWebSocketServer } from './core/mcpServer'
import { toAbsolutePath } from './core/pathGuard'
import { buildInstructions, buildTools } from './core/tools'
import { DiagnosticsProvider } from './obsidian/diagnosticsProvider'
import { DIFF_VIEW_TYPE, DiffView, ObsidianDiffPresenter } from './obsidian/diffView'
import { createHost } from './obsidian/host'
import { SelectionSync } from './obsidian/selectionSync'
import { DEFAULT_SETTINGS, type VcoderIdeSettings, VcoderIdeSettingTab } from './obsidian/settings'

export default class VcoderIdePlugin extends Plugin {
  declare settings: VcoderIdeSettings
  private server: McpWebSocketServer | undefined
  private lockPath: string | undefined
  private port: number | undefined
  private vaultRoot = ''
  private statusEl: HTMLElement | undefined
  private selection!: SelectionSync
  private diffs!: DiffSessions
  private diagnostics!: DiagnosticsProvider

  async onload(): Promise<void> {
    await this.loadSettings()
    const adapter = this.app.vault.adapter
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('vcoder IDE requires the desktop app.')
      return
    }
    this.vaultRoot = adapter.getBasePath()

    this.selection = new SelectionSync(
      this.app,
      p => this.absPath(p),
      params => this.server?.notify('selection_changed', params),
      () => this.settings.shareActiveFile,
    )
    this.diagnostics = new DiagnosticsProvider(
      this.app,
      () => this.settings.diagnostics,
      () => this.settings.maxScanFiles,
    )
    this.diffs = new DiffSessions(new ObsidianDiffPresenter(this.app, () => this.settings.diffLayout))

    this.registerView(DIFF_VIEW_TYPE, leaf => new DiffView(leaf))
    this.registerEditorExtension(this.selection.extension())
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.selection.onActiveLeafChange()))
    this.registerCommands()
    this.registerMenus()
    this.addSettingTab(new VcoderIdeSettingTab(this.app, this))

    this.statusEl = this.addStatusBarItem()
    this.statusEl.addClass('vcoder-ide-status')
    this.statusEl.onClickEvent(() => void this.copyLaunchCommand())

    this.app.workspace.onLayoutReady(() => {
      // Restored diff tabs from a previous session have no pending call — close them.
      this.app.workspace.detachLeavesOfType(DIFF_VIEW_TYPE)
      void this.startServer()
    })
  }

  async onunload(): Promise<void> {
    await this.stopServer()
    this.selection?.dispose()
  }

  // ── server lifecycle ──────────────────────────────────────────────────

  defaultIdeDir(): string {
    return resolveIdeDir()
  }

  private async startServer(): Promise<void> {
    const authToken = generateAuthToken()
    const host = createHost({ app: this.app, vaultRoot: this.vaultRoot, diagnostics: this.diagnostics, selection: this.selection })
    const server = new McpWebSocketServer({
      authToken,
      serverName: 'vcoder-obsidian',
      serverVersion: this.manifest.version,
      instructions: () => buildInstructions(host),
      tools: buildTools({ host, diffs: this.diffs, absPath: p => this.absPath(p) }),
    })
    server.on('connection', () => {
      this.updateStatus()
      this.selection.resend()
    })
    server.on('disconnect', count => {
      if (count === 0) this.diffs.closeAll()
      this.updateStatus()
    })
    try {
      this.port = await server.start()
      this.server = server
      this.lockPath = writeLockfile(
        resolveIdeDir({ override: this.settings.lockfileDir }),
        this.port,
        buildLockfile({ workspaceFolders: [this.vaultRoot], authToken }),
      )
    } catch (err) {
      console.error('[vcoder-ide] failed to start', err)
      new Notice(`vcoder IDE failed to start: ${err instanceof Error ? err.message : String(err)}`)
      await server.stop()
      this.server = undefined
    }
    this.updateStatus()
  }

  private async stopServer(): Promise<void> {
    this.diffs?.closeAll()
    removeLockfile(this.lockPath)
    this.lockPath = undefined
    await this.server?.stop()
    this.server = undefined
    this.port = undefined
  }

  async restartServer(): Promise<void> {
    await this.stopServer()
    await this.startServer()
    new Notice(`vcoder IDE listening on port ${this.port ?? '—'}`)
  }

  statusText(): string {
    if (!this.server || !this.port) return 'Not running'
    const n = this.server.connectionCount
    return n > 0 ? `Connected (${n} session${n > 1 ? 's' : ''}) · port ${this.port}` : `Waiting for vcoder · port ${this.port} · run /ide in vcoder from this vault`
  }

  private updateStatus(): void {
    if (!this.statusEl) return
    const connected = (this.server?.connectionCount ?? 0) > 0
    this.statusEl.setText(connected ? 'vcoder ●' : 'vcoder ○')
    this.statusEl.toggleClass('is-connected', connected)
    this.statusEl.setAttr('aria-label', `${this.statusText()}\nClick to copy the launch command`)
  }

  // ── commands ──────────────────────────────────────────────────────────

  private registerCommands(): void {
    this.addCommand({
      id: 'send-selection',
      name: 'Send selection to vcoder',
      editorCallback: (editor, ctx) => {
        const file = ctx.file
        if (file) this.sendMention(file, editor)
      },
    })
    this.addCommand({
      id: 'send-file',
      name: 'Send current file to vcoder',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile()
        if (!file) return false
        if (!checking) this.sendMention(file)
        return true
      },
    })
    this.addCommand({
      id: 'copy-launch-command',
      name: 'Copy vcoder launch command for this vault',
      callback: () => void this.copyLaunchCommand(),
    })
    this.addCommand({
      id: 'restart-server',
      name: 'Restart IDE server',
      callback: () => void this.restartServer(),
    })
  }

  private registerMenus(): void {
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        const file = info.file
        if (!file) return
        menu.addItem(item =>
          item
            .setTitle(editor.somethingSelected() ? 'Send selection to vcoder' : 'Send note to vcoder')
            .setIcon('bot')
            .onClick(() => this.sendMention(file, editor)),
        )
      }),
    )
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file: TAbstractFile) => {
        menu.addItem(item =>
          item
            .setTitle('Send to vcoder')
            .setIcon('bot')
            .onClick(() => this.sendMention(file)),
        )
      }),
    )
  }

  private sendMention(file: TAbstractFile, editor?: Editor): void {
    if (!this.server || this.server.connectionCount === 0) {
      new Notice('vcoder is not connected. Run /ide in vcoder from this vault.')
      return
    }
    const params: Record<string, unknown> = { filePath: this.absPath(file.path) }
    if (editor && file instanceof TFile && editor.somethingSelected()) {
      const from = editor.getCursor('from')
      const to = editor.getCursor('to')
      // A selection ending at column 0 doesn't include that line.
      const endLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line
      params.lineStart = from.line
      params.lineEnd = endLine
    }
    this.server.notify('at_mentioned', params)
    new Notice(`Sent ${file.name} to vcoder`)
  }

  private async copyLaunchCommand(): Promise<void> {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const cmd = this.port ? `cd ${q(this.vaultRoot)} && VCODER_SSE_PORT=${this.port} vcoder` : `cd ${q(this.vaultRoot)} && vcoder --ide`
    await navigator.clipboard.writeText(cmd)
    new Notice(`Copied: ${cmd}`)
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private absPath(vaultPath: string): string {
    return toAbsolutePath(this.vaultRoot, vaultPath)
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<VcoderIdeSettings> | null
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      diagnostics: { ...DEFAULT_SETTINGS.diagnostics, ...(data?.diagnostics ?? {}) },
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}
