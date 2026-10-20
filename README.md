# vcoder IDE for Obsidian

Connect an Obsidian vault to the [vcoder](https://code.voyah.com) CLI through `/ide`. Obsidian then acts as vcoder's IDE:

| Capability | What happens |
|---|---|
| **Selection sync** | vcoder sees which note is open and what text you selected. The prompt footer shows `⧉ N lines selected`, so you can say "rewrite this paragraph". |
| **Send to vcoder** | Command, editor right-click, or file-menu entry. Inserts `@note.md#L3-5` into the vcoder prompt. |
| **Diff review** | When vcoder asks permission to edit a note, a diff tab opens in Obsidian (unified or side by side, with word-level highlights). Choose **Accept**, **Reject**, or **Edit proposal**, then accept your edited version. |
| **Note diagnostics** | `getDiagnostics` reports unresolved `[[links]]` / `![[embeds]]`, missing `#heading` / `#^block` targets, invalid or duplicate frontmatter keys, unclosed code fences, heading level skips and duplicate headings. vcoder sees any *new* problems its edits introduce automatically. |
| **openFile** | The model can open a note and highlight a passage for you. |

## Install

This plugin is distributed privately with [BRAT](https://github.com/TfTHacker/obsidian42-brat). It is not listed in the Obsidian community directory.

### With BRAT (recommended, auto-updates)

1. **Get access.** Ask the repo owner to add you as a collaborator on `weank1984/obsidian-vcoder-ide`.
2. **Create a GitHub token.**
   - Go to GitHub → Settings → Developer settings → **Fine-grained token**.
   - Repository access: only this repo.
   - Permission: **Contents: Read-only**.
3. **Install BRAT.** In Obsidian, open **Settings → Community plugins → Browse**, then install and enable **BRAT**.
4. **Add the token.** In BRAT settings, paste the token into **Personal access token**.
5. **Add the plugin.**
   - Run **BRAT: Add a beta plugin for testing**.
   - Enter `weank1984/obsidian-vcoder-ide`.
   - Choose the latest version.
6. **Enable it.** Turn on **vcoder IDE** under **Settings → Community plugins**.

BRAT checks for new releases on startup. You can also run **BRAT: Check for updates to all beta plugins** to update now.

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/weank1984/obsidian-vcoder-ide/releases).
2. Put them in `<vault>/.obsidian/plugins/vcoder-ide/`.
3. Enable the plugin.

### From source (development)

1. Run `npm install && npm run build`.
2. Symlink `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/vcoder-ide/`.

## Use

```sh
cd /path/to/vault
vcoder          # then run /ide and pick "Obsidian"
```

- **You must start vcoder inside the vault directory** (or a subfolder). vcoder only lists IDEs whose workspace contains the current directory.
- **Auto-connect:** click the `vcoder ○` status bar item to copy a launch command. The command includes `VCODER_SSE_PORT=<port>`, which makes vcoder connect to Obsidian on startup. `vcoder --ide` also works.
- **VS Code integrated terminal:** if you run vcoder there, it prefers VS Code. Use the copied command with `VCODER_SSE_PORT`.
- **Diff review:**
  - Closing the diff tab by hand counts as **Reject**.
  - Answering in the terminal closes the Obsidian tab.
  - The diff only opens when vcoder asks for permission. In auto-accept modes, edits are applied directly.
  - To turn the diff off, set **Diff tool → terminal** in vcoder `/config`.
- **openFile** requires vcoder ≥ the version that allows `mcp__ide__openFile` (internal allowlist).

## Settings

| Setting | Purpose |
|---|---|
| **Lockfile directory** | Defaults to `$VCODER_HOME/ide` or `~/.vcoder/ide`. If you start Obsidian from the Dock, it does not inherit shell variables. In that case, set this explicitly when you use a custom `VCODER_HOME`. |
| **Share active note** | Sends the open note even when nothing is selected. |
| **Diff layout** | Unified or side by side. |
| **Diagnostics** | Turn each of the four rule groups on or off, and set the vault scan limit. |

## Network use and files outside the vault

- **Network.** The plugin runs a WebSocket server on **127.0.0.1 only**. Only the vcoder CLI on the same machine connects to it. The plugin makes no outbound requests and contacts no remote services.
- **Files outside the vault.** The plugin writes one lockfile, `~/.vcoder/ide/<port>.lock` (or `$VCODER_HOME/ide`). vcoder reads this file to discover the running Obsidian instance. The plugin deletes it when it unloads.

## Security

- The WebSocket server binds to **127.0.0.1** only. It uses a random port and a per-start random token (`crypto.randomUUID`).
- The token is checked on every connection and stored only in an owner-only (`0600`) lockfile. The lockfile is deleted on unload.
- Paths outside the vault are rejected (`openDiff` errors, so vcoder falls back to its terminal prompt).
- **The plugin never writes your notes.** Accepted diffs are applied by vcoder itself.
- There is no code execution. `executeCode` is not implemented.

## Protocol

The plugin implements the vcoder IDE contract:

- **Lockfile:** `<vcoder home>/ide/<port>.lock` with contents `{workspaceFolders, pid, ideName, transport:"ws", authToken}`.
- **Server:** MCP over WebSocket, subprotocol `mcp`, header `X-Claude-Code-Ide-Authorization`.
- **Notifications to vcoder:** `selection_changed`, `at_mentioned`.
- **Tools:** `openDiff` (blocking; returns `FILE_SAVED`+contents / `DIFF_REJECTED` / `TAB_CLOSED`), `close_tab`, `closeAllDiffTabs`, `getDiagnostics`, `openFile`, `getWorkspaceFolders`, `getOpenEditors`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty`, `saveDocument`.

## Development

```sh
npm run dev        # esbuild watch → main.js
npm test           # vitest: lockfile, MCP server wire contract, diff, diagnostics rules
npm run build      # tsc + production bundle
npm run fake-ide -- /tmp/vault   # headless IDE peer (FAKE_IDE_DIFF=accept|reject|hold) for testing a real vcoder CLI
```

### Releasing

```sh
npm run release -- 0.1.1   # bump manifest/versions/package, test, build, commit, tag
git push --follow-tags     # CI (.github/workflows/release.yml) publishes the GitHub release
```

The tag must equal the `manifest.json` version, with no `v` prefix. BRAT users get the new version on their next update check.

- `src/core/` has no Obsidian imports and is fully unit tested.
- `src/obsidian/` is the adapter layer (views, editor extension, metadata cache).
- `test-vault/` contains seeded problems for every diagnostic rule. Symlink this repo to `test-vault/.obsidian/plugins/vcoder-ide` and open the folder as a vault.
