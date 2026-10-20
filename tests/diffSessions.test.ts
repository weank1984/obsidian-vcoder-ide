import { describe, expect, it, vi } from 'vitest'
import { DiffSessions, type DiffPresenter, type DiffSession } from '../src/core/diffSessions'

function setup() {
  const shown: DiffSession[] = []
  const presenter: DiffPresenter = {
    show: s => {
      shown.push(s)
    },
    dispose: vi.fn(),
  }
  return { shown, presenter, diffs: new DiffSessions(presenter) }
}

const req = (tabName = 't1') => ({
  tabName,
  absPath: '/v/a.md',
  vaultPath: 'a.md',
  oldContents: 'old',
  fileExists: true,
  newContents: 'new',
})

describe('DiffSessions', () => {
  it('resolves with saved contents when the user accepts', async () => {
    const { shown, diffs, presenter } = setup()
    const p = diffs.open(req())
    shown[0].resolve({ kind: 'saved', contents: 'edited' })
    await expect(p).resolves.toEqual({ kind: 'saved', contents: 'edited' })
    expect(presenter.dispose).toHaveBeenCalledWith('t1')
    expect(diffs.size).toBe(0)
  })

  it('resolves rejected', async () => {
    const { shown, diffs } = setup()
    const p = diffs.open(req())
    shown[0].resolve({ kind: 'rejected' })
    await expect(p).resolves.toEqual({ kind: 'rejected' })
  })

  it('close_tab resolves TAB_CLOSED and later UI clicks are ignored', async () => {
    const { shown, diffs } = setup()
    const p = diffs.open(req())
    expect(diffs.close('t1')).toBe(true)
    shown[0].resolve({ kind: 'saved', contents: 'x' })
    await expect(p).resolves.toEqual({ kind: 'closed' })
    expect(shown[0].settled).toBe(true)
    expect(diffs.close('t1')).toBe(false)
  })

  it('closeAll settles every pending session', async () => {
    const { diffs } = setup()
    const a = diffs.open(req('a'))
    const b = diffs.open(req('b'))
    expect(diffs.closeAll()).toBe(2)
    await expect(Promise.all([a, b])).resolves.toEqual([{ kind: 'closed' }, { kind: 'closed' }])
  })

  it('abort signal (connection dropped) settles as closed', async () => {
    const { diffs, presenter } = setup()
    const ac = new AbortController()
    const p = diffs.open(req(), ac.signal)
    ac.abort()
    await expect(p).resolves.toEqual({ kind: 'closed' })
    expect(presenter.dispose).toHaveBeenCalledWith('t1')
  })

  it('reusing a tab name closes the stale session', async () => {
    const { shown, diffs } = setup()
    const first = diffs.open(req())
    const second = diffs.open(req())
    await expect(first).resolves.toEqual({ kind: 'closed' })
    shown[1].resolve({ kind: 'rejected' })
    await expect(second).resolves.toEqual({ kind: 'rejected' })
  })

  it('rejects when the presenter fails to show', async () => {
    const diffs = new DiffSessions({ show: () => Promise.reject(new Error('boom')), dispose: () => {} })
    await expect(diffs.open(req())).resolves.toEqual({ kind: 'rejected' })
  })
})
