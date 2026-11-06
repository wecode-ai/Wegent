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

  it('does not broadcast a transient preference reset when another window initializes', async () => {
    mocks.isElectronRuntime.mockReturnValue(true)
    const appearance = '{"schemaVersion":2,"mode":"dark","darkThemeId":"tokyo-night"}'
    localStorage.setItem('wework.appearance', appearance)
    localStorage.setItem('shared', 'current')
    mocks.invokeDesktopHost.mockResolvedValueOnce({
      'wework.appearance': appearance,
      shared: 'durable',
    })
    const { initializeDesktopLocalStoragePersistence } = await loadPersistence()
    const prototype = Object.getPrototypeOf(localStorage)
    const methods = prototype[Symbol.for('wework.desktop.localStoragePersistence.methods')]
    const clear = vi.spyOn(methods ?? prototype, 'clear')
    const setItem = vi.spyOn(methods ?? prototype, 'setItem')

    await initializeDesktopLocalStoragePersistence()

    expect(clear).not.toHaveBeenCalled()
    expect(setItem).toHaveBeenCalledExactlyOnceWith('shared', 'durable')
    expect(localStorage.getItem('wework.appearance')).toBe(appearance)
    clear.mockRestore()
    setItem.mockRestore()
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
