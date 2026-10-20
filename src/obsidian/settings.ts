import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian'
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

const DIAGNOSTIC_RULES: { key: keyof RuleToggles; name: string; desc: string }[] = [
  { key: 'links', name: 'Unresolved links and embeds', desc: '[[Missing note]] and ![[missing.png]] (Warning)' },
  { key: 'subpaths', name: 'Missing headings and block references', desc: '[[Note#No such heading]] and [[Note#^missing]] (Warning)' },
  { key: 'frontmatter', name: 'Frontmatter', desc: 'Invalid YAML (Error), duplicate keys (Warning)' },
  { key: 'structure', name: 'Markdown structure', desc: 'Unclosed code fences (Error), heading level skips (Info), duplicate headings (Hint)' },
]

const DIAG_PREFIX = 'diagnostics.'

function isRuleKey(k: string): k is keyof RuleToggles {
  return DIAGNOSTIC_RULES.some(r => r.key === k)
}

function validateScanLimit(n: number): string | undefined {
  return Number.isInteger(n) && n > 0 ? undefined : 'Enter a whole number greater than 0.'
}

export class VcoderIdeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: VcoderIdePlugin,
  ) {
    super(app, plugin)
  }

  private lockfileDesc(): string {
    return `Where vcoder discovers IDEs. Leave empty for the default (${this.plugin.defaultIdeDir()}). Set this if you use a custom VCODER_HOME — Obsidian launched from the Dock does not inherit shell variables. Restart the server after a change.`
  }

  private renderStatus(setting: Setting): void {
    setting.setName('Status').setDesc(this.plugin.statusText())
    setting.addButton(b =>
      b.setButtonText('Restart server').onClick(async () => {
        await this.plugin.restartServer()
        setting.setDesc(this.plugin.statusText())
      }),
    )
  }

  // ── declarative settings (Obsidian 1.13+) ─────────────────────────────

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: 'Status', render: setting => this.renderStatus(setting) },
      {
        name: 'Lockfile directory',
        desc: this.lockfileDesc(),
        control: { type: 'text', key: 'lockfileDir', placeholder: this.plugin.defaultIdeDir() },
      },
      {
        name: 'Share active note',
        desc: 'Tell vcoder which note is open even when nothing is selected.',
        control: { type: 'toggle', key: 'shareActiveFile' },
      },
      {
        type: 'group',
        heading: 'Diff review',
        items: [
          {
            name: 'Default layout',
            control: { type: 'dropdown', key: 'diffLayout', options: { unified: 'Unified', split: 'Side by side' } },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Diagnostics',
        items: [
          ...DIAGNOSTIC_RULES.map(r => ({
            name: r.name,
            desc: r.desc,
            control: { type: 'toggle' as const, key: `${DIAG_PREFIX}${r.key}` },
          })),
          {
            name: 'Vault scan limit',
            desc: 'Maximum notes checked when vcoder asks for diagnostics of the whole vault.',
            control: {
              type: 'number',
              key: 'maxScanFiles',
              min: 1,
              step: 1,
              defaultValue: DEFAULT_SETTINGS.maxScanFiles,
              validate: validateScanLimit,
            },
          },
        ],
      },
    ]
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings
    if (key.startsWith(DIAG_PREFIX)) {
      const rule = key.slice(DIAG_PREFIX.length)
      return isRuleKey(rule) ? s.diagnostics[rule] : undefined
    }
    switch (key) {
      case 'lockfileDir':
        return s.lockfileDir
      case 'shareActiveFile':
        return s.shareActiveFile
      case 'diffLayout':
        return s.diffLayout
      case 'maxScanFiles':
        return s.maxScanFiles
      default:
        return undefined
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (this.applyValue(key, value)) await this.plugin.saveSettings()
  }

  /** Writes a validated value into the settings object. Returns false for unknown keys or bad values. */
  private applyValue(key: string, value: unknown): boolean {
    const s = this.plugin.settings
    if (key.startsWith(DIAG_PREFIX)) {
      const rule = key.slice(DIAG_PREFIX.length)
      if (!isRuleKey(rule) || typeof value !== 'boolean') return false
      s.diagnostics[rule] = value
      return true
    }
    switch (key) {
      case 'lockfileDir':
        if (typeof value !== 'string') return false
        s.lockfileDir = value.trim()
        return true
      case 'shareActiveFile':
        if (typeof value !== 'boolean') return false
        s.shareActiveFile = value
        return true
      case 'diffLayout':
        if (value !== 'unified' && value !== 'split') return false
        s.diffLayout = value
        return true
      case 'maxScanFiles':
        if (typeof value !== 'number' || validateScanLimit(value)) return false
        s.maxScanFiles = value
        return true
      default:
        return false
    }
  }

  // ── fallback for Obsidian < 1.13 (minAppVersion is 1.7.2) ─────────────

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    this.renderStatus(new Setting(containerEl))

    new Setting(containerEl)
      .setName('Lockfile directory')
      .setDesc(this.lockfileDesc())
      .addText(t =>
        t
          .setPlaceholder(this.plugin.defaultIdeDir())
          .setValue(this.plugin.settings.lockfileDir)
          .onChange(v => this.setControlValue('lockfileDir', v)),
      )

    new Setting(containerEl)
      .setName('Share active note')
      .setDesc('Tell vcoder which note is open even when nothing is selected.')
      .addToggle(t => t.setValue(this.plugin.settings.shareActiveFile).onChange(v => this.setControlValue('shareActiveFile', v)))

    new Setting(containerEl).setName('Diff review').setHeading()
    new Setting(containerEl)
      .setName('Default layout')
      .addDropdown(d =>
        d
          .addOptions({ unified: 'Unified', split: 'Side by side' })
          .setValue(this.plugin.settings.diffLayout)
          .onChange(v => this.setControlValue('diffLayout', v)),
      )

    new Setting(containerEl).setName('Diagnostics').setHeading()
    for (const r of DIAGNOSTIC_RULES) {
      new Setting(containerEl)
        .setName(r.name)
        .setDesc(r.desc)
        .addToggle(t => t.setValue(this.plugin.settings.diagnostics[r.key]).onChange(v => this.setControlValue(`${DIAG_PREFIX}${r.key}`, v)))
    }
    new Setting(containerEl)
      .setName('Vault scan limit')
      .setDesc('Maximum notes checked when vcoder asks for diagnostics of the whole vault.')
      .addText(t =>
        t.setValue(String(this.plugin.settings.maxScanFiles)).onChange(v => this.setControlValue('maxScanFiles', Number(v.trim()))),
      )
  }
}
