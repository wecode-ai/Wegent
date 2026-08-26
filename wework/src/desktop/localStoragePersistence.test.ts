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
  beforeEach(() => {
    mocks.invokeDesktopHost.mockReset()
    mocks.isElectronRuntime.mockReset()
    localStorage.clear()
    sessionStorage.clear()
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
    expect(Object.fromEntries(Object.entries(localStorage))).toEqual({
      restored: 'value',
      shared: 'durable',
    })
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
})
