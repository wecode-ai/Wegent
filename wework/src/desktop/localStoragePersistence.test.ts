import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RendererStorageStore } from '../../electron/src/host/renderer-storage-store'

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

class BoundedStorage implements Storage {
  private entries = new Map<string, string>()

  constructor(private readonly quota: number) {}

  get length(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }

  setItem(key: string, value: string): void {
    let size = key.length + value.length
    for (const [existingKey, existingValue] of this.entries) {
      if (existingKey !== key) size += existingKey.length + existingValue.length
    }
    if (size > this.quota)
      throw new DOMException('Browser storage quota exceeded', 'QuotaExceededError')
    this.entries.set(key, value)
  }
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

  it('restores the official catalog alongside concurrent browser writes at restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-renderer-storage-quota-'))
    let store = new RendererStorageStore(root)
    const browserStorage = new BoundedStorage(1000)
    const browser = vi.spyOn(window, 'localStorage', 'get').mockReturnValue(browserStorage)
    const persistence = await loadPersistence()
    const catalogKey = persistence.REMOTE_PLUGIN_CATALOG_STORAGE_KEY
    const inventoryKey = 'wework.plugins.inventory.v2'
    const catalog = 'a'.repeat(600)
    const inventory = 'b'.repeat(600)
    const began = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    mocks.invokeDesktopHost.mockImplementation(async (method: string, params) => {
      if (method === 'rendererStorage.initialize') return store.initialize(params.entries)
      if (Object.hasOwn(params.changes, catalogKey)) {
        began.resolve()
        await resume.promise
      }
      await store.update(params)
      return { persisted: true }
    })
    try {
      await store.initialize({ [catalogKey]: 'old catalog', appearance: 'dark' })
      await persistence.initializeDesktopLocalStoragePersistence()

      const refresh = persistence.commitLocalStorageValue(catalogKey, catalog)
      await began.promise
      expect(persistence.readOpenAiCatalogStorage()).toBe('old catalog')
      browserStorage.setItem(inventoryKey, inventory)
      resume.resolve()
      await refresh
      await persistence.flushDesktopLocalStoragePersistence()
      await store.close()

      store = new RendererStorageStore(root)
      const restarted = await loadPersistence()
      await restarted.initializeDesktopLocalStoragePersistence()
      expect(browserStorage.getItem(inventoryKey)).toBe(inventory)
      expect(browserStorage.getItem('appearance')).toBe('dark')
      expect(browserStorage.getItem(catalogKey)).toBeNull()
      expect(restarted.readOpenAiCatalogStorage()).toBe(catalog)
    } finally {
      resume.resolve()
      browser.mockRestore()
      await store.close()
      await rm(root, { recursive: true, force: true })
    }
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
