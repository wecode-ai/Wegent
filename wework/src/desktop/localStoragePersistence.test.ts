import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
  isElectronRuntime: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invokeDesktopHost,
}))
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: mocks.isElectronRuntime,
  getDesktopWindowLabel: () => 'main',
}))

async function loadPersistence() {
  vi.resetModules()
  return import('./localStoragePersistence')
}

describe('desktop localStorage persistence', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(async () => {
    localStorage.clear()
    sessionStorage.clear()
    await new Promise(resolve => setTimeout(resolve, 0))
    mocks.invokeDesktopHost.mockReset()
    mocks.isElectronRuntime.mockReset()
  })

  it('does nothing outside Electron', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    mocks.isElectronRuntime.mockReturnValue(false)
    const { initializeDesktopLocalStoragePersistence } = await loadPersistence()

    await initializeDesktopLocalStoragePersistence()

    expect(mocks.invokeDesktopHost).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })

  it('seeds from the current origin and restores the durable snapshot before use', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
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
    expect(info.mock.calls.map(([message]) => JSON.parse(String(message).split('] ')[1]))).toEqual([
      {
        phase: 'renderer-storage-replace',
        status: 'started',
        navigationTimeMs: expect.any(Number),
      },
      {
        phase: 'renderer-storage-replace',
        status: 'completed',
        navigationTimeMs: expect.any(Number),
        durationMs: expect.any(Number),
      },
    ])
  })

  it('records synchronous replacement failure and preserves the exception', async () => {
    mocks.isElectronRuntime.mockReturnValue(true)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    let restore!: (entries: Record<string, string>) => void
    mocks.invokeDesktopHost.mockReturnValueOnce(
      new Promise(resolve => {
        restore = resolve
      })
    )
    const { initializeDesktopLocalStoragePersistence } = await loadPersistence()
    const initialization = initializeDesktopLocalStoragePersistence()
    const failure = new Error('private-storage-failure')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw failure
    })
    restore({ private: 'private-value' })
    await expect(initialization).rejects.toBe(failure)
    const phases = info.mock.calls.map(([message]) => JSON.parse(String(message).split('] ')[1]))
    expect(phases.map(({ phase, status }) => [phase, status])).toEqual([
      ['renderer-storage-replace', 'started'],
      ['renderer-storage-replace', 'failed'],
    ])
    expect(JSON.stringify(phases)).not.toContain('private')
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
