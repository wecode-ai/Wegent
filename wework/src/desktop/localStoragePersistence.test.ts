import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
  isElectronRuntime: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invokeDesktopHost,
}))
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: mocks.isElectronRuntime,
}))

async function loadPersistence() {
  vi.resetModules()
  return import('./localStoragePersistence')
}

describe('desktop localStorage persistence', () => {
  beforeEach(async () => {
    localStorage.clear()
    sessionStorage.clear()
    await new Promise(resolve => setTimeout(resolve, 0))
    mocks.invokeDesktopHost.mockReset()
    mocks.isElectronRuntime.mockReset()
  })

  it('does nothing outside Electron', async () => {
    mocks.isElectronRuntime.mockReturnValue(false)
    const { initializeDesktopLocalStoragePersistence } = await loadPersistence()

    await initializeDesktopLocalStoragePersistence()

    expect(mocks.invokeDesktopHost).not.toHaveBeenCalled()
  })

  it('seeds from the current origin and restores the durable snapshot before use', async () => {
    mocks.isElectronRuntime.mockReturnValue(true)
    localStorage.setItem('origin-only', 'stale')
    localStorage.setItem('shared', 'current')
    mocks.invokeDesktopHost.mockResolvedValueOnce({
      shared: 'durable',
      restored: 'value',
    })
    const { initializeDesktopLocalStoragePersistence } = await loadPersistence()

    await initializeDesktopLocalStoragePersistence()

    expect(mocks.invokeDesktopHost).toHaveBeenCalledWith('rendererStorage.initialize', {
      entries: {
        'origin-only': 'stale',
        shared: 'current',
      },
    })
    expect(localStorage).toHaveLength(2)
    expect(localStorage.getItem('origin-only')).toBeNull()
    expect(localStorage.getItem('restored')).toBe('value')
    expect(localStorage.getItem('shared')).toBe('durable')
  })

  it('persists set, remove, and clear operations without affecting sessionStorage', async () => {
    mocks.isElectronRuntime.mockReturnValue(true)
    mocks.invokeDesktopHost.mockResolvedValueOnce({})
    mocks.invokeDesktopHost.mockResolvedValue({ persisted: true })
    const { flushDesktopLocalStoragePersistence, initializeDesktopLocalStoragePersistence } =
      await loadPersistence()
    await initializeDesktopLocalStoragePersistence()

    localStorage.setItem('first', 'one')
    localStorage.removeItem('removed')
    sessionStorage.setItem('session', 'ignored')
    await flushDesktopLocalStoragePersistence()
    await vi.waitFor(() => {
      expect(mocks.invokeDesktopHost).toHaveBeenCalledWith('rendererStorage.update', {
        clear: false,
        changes: {
          first: 'one',
          removed: null,
        },
      })
    })

    localStorage.clear()
    localStorage.setItem('after-clear', 'value')
    await flushDesktopLocalStoragePersistence()
    await vi.waitFor(() => {
      expect(mocks.invokeDesktopHost).toHaveBeenCalledWith('rendererStorage.update', {
        clear: true,
        changes: {
          'after-clear': 'value',
        },
      })
    })
  })

  it('rejects flushes after a failed write and retries the complete update later', async () => {
    mocks.isElectronRuntime.mockReturnValue(true)
    const failure = new Error('disk unavailable')
    mocks.invokeDesktopHost
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ persisted: true })
    const { flushDesktopLocalStoragePersistence, initializeDesktopLocalStoragePersistence } =
      await loadPersistence()
    await initializeDesktopLocalStoragePersistence()

    localStorage.setItem('first', 'one')
    await expect(flushDesktopLocalStoragePersistence()).rejects.toBe(failure)

    localStorage.setItem('second', 'two')
    await expect(flushDesktopLocalStoragePersistence()).resolves.toBeUndefined()
    expect(mocks.invokeDesktopHost).toHaveBeenLastCalledWith('rendererStorage.update', {
      clear: false,
      changes: {
        first: 'one',
        second: 'two',
      },
    })
  })
})

describe('committed localStorage commands', () => {
  beforeEach(() => {
    mocks.invokeDesktopHost.mockReset()
    mocks.isElectronRuntime.mockReturnValue(true)
  })

  it('publishes a durable value only after acknowledgement and does not queue it twice', async () => {
    let commit!: () => void
    const acknowledged = new Promise<void>(resolve => {
      commit = resolve
    })
    mocks.invokeDesktopHost.mockImplementation(async (method: string) => {
      if (method === 'rendererStorage.initialize') return {}
      await acknowledged
      return { persisted: true }
    })
    const persistence = await loadPersistence()
    await persistence.initializeDesktopLocalStoragePersistence()
    const write = persistence.commitLocalStorageValue('archive', 'committed')
    await vi.waitFor(() =>
      expect(mocks.invokeDesktopHost).toHaveBeenCalledWith('rendererStorage.update', {
        clear: false,
        changes: { archive: 'committed' },
      })
    )
    expect(localStorage.getItem('archive')).toBeNull()
    commit()
    await write
    expect(localStorage.getItem('archive')).toBe('committed')
    await persistence.flushDesktopLocalStoragePersistence()
    expect(
      mocks.invokeDesktopHost.mock.calls.filter(([method]) => method === 'rendererStorage.update')
    ).toHaveLength(1)
  })

  it('does not publish or retry a failed command alongside a later successful command', async () => {
    const durable: Record<string, string> = {}
    mocks.invokeDesktopHost.mockImplementation(async (method: string, params) => {
      if (method === 'rendererStorage.initialize') return { ...durable }
      if (params.changes.failed) throw new Error('Disk unavailable')
      Object.assign(durable, params.changes)
      return { persisted: true }
    })
    const persistence = await loadPersistence()
    await persistence.initializeDesktopLocalStoragePersistence()
    await expect(persistence.commitLocalStorageValue('failed', 'tentative')).rejects.toThrow(
      'Disk unavailable'
    )
    expect(localStorage.getItem('failed')).toBeNull()
    await persistence.commitLocalStorageValue('successful', 'committed')
    expect(durable).toEqual({ successful: 'committed' })
    expect(localStorage.getItem('failed')).toBeNull()
    expect(await persistence.readCommittedLocalStorageValue('successful')).toBe('committed')
  })

  it('reads another window’s durable value even when this window has stale cached history', async () => {
    mocks.invokeDesktopHost.mockResolvedValue({ archive: 'another-window' })
    const persistence = await loadPersistence()
    expect(await persistence.readCommittedLocalStorageValue('archive')).toBe('another-window')
    expect(mocks.invokeDesktopHost).toHaveBeenCalledWith('rendererStorage.initialize', {
      entries: {},
    })
  })

  it('preserves the durable command result when browser-cache publication fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.invokeDesktopHost.mockResolvedValue({ persisted: true })
    const persistence = await loadPersistence()
    const set = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('Browser cache unavailable')
    })
    await expect(
      persistence.commitLocalStorageValue('archive', 'committed')
    ).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledOnce()
    set.mockRestore()
    log.mockRestore()
  })
})
