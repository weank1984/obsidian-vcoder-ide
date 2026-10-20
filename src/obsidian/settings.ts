import { App, PluginSettingTab, Setting } from 'obsidian'
import type { RuleToggles } from '../core/diagnostics/rules'
import type VcoderIdePlugin from '../main'

export interface VcoderIdeSettings {
  /** Overrides `<VCODER_HOME>/ide`. Empty = auto. */
  lockfileDir: string
  diagnostics: RuleToggles
  /** Max notes scanned by getDiagnostics without uri. */
  maxScanFiles: number
  diffLayout: 'unified' | 'split'
  /** Send `selection_changed` when the active file changes even without selection. */
  shareActiveFile: boolean
}

export const DEFAULT_SETTINGS: VcoderIdeSettings = {
  lockfileDir: '',
  diagnostics: { links: true, subpaths: true, frontmatter: true, structure: true },
  maxScanFiles: 5000,
  diffLayout: 'unified',
  shareActiveFile: true,
}

export class VcoderIdeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VcoderIdePlugin,
  ) {
    super(app, plugin)
  }

  display(): void {
    const { containerEl } = this
    const s = this.plugin.settings
    containerEl.empty()

    const status = this.plugin.statusText()
    new Setting(containerEl).setName('Status').setDesc(status)

    new Setting(containerEl)
      .setName('Lockfile directory')
      .setDesc(
        `Where vcoder discovers IDEs. Leave empty for the default (${this.plugin.defaultIdeDir()}). Set this if you use a custom VCODER_HOME — Obsidian launched from the Dock does not inherit shell variables.`,
      )
      .addText(t =>
        t
          .setPlaceholder(this.plugin.defaultIdeDir())
          .setValue(s.lockfileDir)
          .onChange(async v => {
            s.lockfileDir = v.trim()
            await this.plugin.saveSettings()
          }),
      )
      .addButton(b =>
        b.setButtonText('Restart server').onClick(async () => {
          await this.plugin.restartServer()
          this.display()
        }),
      )

    new Setting(containerEl)
      .setName('Share active note')
      .setDesc('Tell vcoder which note is open even when nothing is selected.')
      .addToggle(t =>
        t.setValue(s.shareActiveFile).onChange(async v => {
          s.shareActiveFile = v
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl).setName('Diff review').setHeading()
    new Setting(containerEl)
      .setName('Default layout')
      .addDropdown(d =>
        d
          .addOptions({ unified: 'Unified', split: 'Side by side' })
          .setValue(s.diffLayout)
          .onChange(async v => {
            s.diffLayout = v as VcoderIdeSettings['diffLayout']
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl).setName('Diagnostics').setHeading()
    const toggle = (key: keyof RuleToggles, name: string, desc: string) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle(t =>
          t.setValue(s.diagnostics[key]).onChange(async v => {
            s.diagnostics[key] = v
            await this.plugin.saveSettings()
          }),
        )
    toggle('links', 'Unresolved links and embeds', '[[Missing note]] and ![[missing.png]] (Warning)')
    toggle('subpaths', 'Missing headings and block references', '[[Note#No such heading]] and [[Note#^missing]] (Warning)')
    toggle('frontmatter', 'Frontmatter', 'Invalid YAML (Error), duplicate keys (Warning)')
    toggle('structure', 'Markdown structure', 'Unclosed code fences (Error), heading level skips (Info), duplicate headings (Hint)')
    new Setting(containerEl)
      .setName('Vault scan limit')
      .setDesc('Maximum notes checked when vcoder asks for diagnostics of the whole vault.')
      .addText(t =>
        t.setValue(String(s.maxScanFiles)).onChange(async v => {
          const n = Number.parseInt(v, 10)
          if (Number.isFinite(n) && n > 0) {
            s.maxScanFiles = n
            await this.plugin.saveSettings()
          }
        }),
      )
  }
}
