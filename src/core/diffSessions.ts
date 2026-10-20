import type { DiffOutcome } from './protocol'

export interface DiffRequest {
  tabName: string
  absPath: string
  /** Vault-relative path. */
  vaultPath: string
  oldContents: string
  /** null when the file does not exist yet (new file). */
  fileExists: boolean
  newContents: string
}

/** UI side of a diff session (implemented by the Obsidian ItemView). */
export interface DiffPresenter {
  show(session: DiffSession): Promise<void> | void
  /** Close the UI for a session. Must not call back into resolve(). */
  dispose(tabName: string): void
}

export interface DiffSession extends DiffRequest {
  /** Called by the UI when the user accepts/rejects. Idempotent. */
  resolve(outcome: DiffOutcome): void
  readonly settled: boolean
}

/**
 * Tracks pending `openDiff` calls. Each call blocks until one of:
 *   - user accepts (FILE_SAVED + final contents) / rejects in Obsidian
 *   - CLI calls close_tab / closeAllDiffTabs (TAB_CLOSED; CLI ignores it then)
 *   - the CLI connection drops (TAB_CLOSED)
 */
export class DiffSessions {
  private readonly pending = new Map<string, { session: DiffSession; settle: (o: DiffOutcome) => void }>()

  constructor(private readonly presenter: DiffPresenter) {}

  get size(): number {
    return this.pending.size
  }

  has(tabName: string): boolean {
    return this.pending.has(tabName)
  }

  open(req: DiffRequest, signal?: AbortSignal): Promise<DiffOutcome> {
    // Same tab name re-used → close the stale one first.
    this.close(req.tabName)

    return new Promise<DiffOutcome>(resolvePromise => {
      let settled = false
      const settle = (outcome: DiffOutcome) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (this.pending.get(req.tabName)?.session === session) this.pending.delete(req.tabName)
        resolvePromise(outcome)
      }
      const session: DiffSession = {
        ...req,
        resolve: outcome => {
          settle(outcome)
          this.presenter.dispose(req.tabName)
        },
        get settled() {
          return settled
        },
      }
      const onAbort = () => {
        settle({ kind: 'closed' })
        this.presenter.dispose(req.tabName)
      }
      if (signal?.aborted) {
        resolvePromise({ kind: 'closed' })
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(req.tabName, { session, settle })
      Promise.resolve(this.presenter.show(session)).catch(() => {
        // If we cannot show the diff, reject so the CLI falls back gracefully.
        session.resolve({ kind: 'rejected' })
      })
    })
  }

  /** CLI-initiated close (close_tab). Returns whether a session existed. */
  close(tabName: string): boolean {
    const entry = this.pending.get(tabName)
    if (!entry) return false
    entry.settle({ kind: 'closed' })
    this.presenter.dispose(tabName)
    return true
  }

  closeAll(): number {
    const names = [...this.pending.keys()]
    for (const n of names) this.close(n)
    return names.length
  }
}
