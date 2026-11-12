import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

interface PendingStorageUpdate {
  clear: boolean
  changes: Map<string, string | null>
}

interface StorageMethods {
  setItem: Storage['setItem']
  removeItem: Storage['removeItem']
  clear: Storage['clear']
}

const STORAGE_METHODS = Symbol.for('wework.desktop.localStoragePersistence.methods')

let installed = false
let pending: PendingStorageUpdate = {
  clear: false,
  changes: new Map(),
}
let flushScheduled = false
let writeQueue: Promise<void> = Promise.resolve()
let writeFailure: unknown = null
let retryUpdate: PendingStorageUpdate | null = null

export async function initializeDesktopLocalStoragePersistence(): Promise<void> {
  if (!isElectronRuntime() || installed) return

  const localStorage = window.localStorage
  restoreStorageMethods(localStorage)
  const durableEntries = await invokeDesktopHost<Record<string, string>>(
    'rendererStorage.initialize',
    {
      entries: storageEntries(localStorage),
    }
  )
  replaceStorage(localStorage, durableEntries)
  installPersistence(localStorage)
  installed = true
}

export async function flushDesktopLocalStoragePersistence(): Promise<void> {
  if (flushScheduled) flushPendingChanges()
  await writeQueue
  if (writeFailure !== null) throw writeFailure
}

/** Durable commands read the host snapshot, not another window's pending browser cache. */
export async function readCommittedLocalStorageValue(key: string): Promise<string | null> {
  if (!isElectronRuntime()) return localStorage.getItem(key)
  if (flushScheduled) flushPendingChanges()
  await writeQueue
  const entries = await invokeDesktopHost<Record<string, string>>('rendererStorage.initialize', {
    entries: {},
  })
  return Object.hasOwn(entries, key) ? entries[key] : null
}

/** Publish to browser windows only after the owning host has committed the value. */
export async function commitLocalStorageValue(key: string, value: string): Promise<void> {
  if (!isElectronRuntime()) {
    localStorage.setItem(key, value)
    return
  }
  if (flushScheduled) flushPendingChanges()
  const commit = writeQueue.then(async () => {
    const update = { clear: false, changes: new Map([[key, value]]) }
    const persisted = retryUpdate ? mergeUpdates(retryUpdate, update) : update
    await invokeDesktopHost('rendererStorage.update', {
      clear: persisted.clear,
      changes: Object.fromEntries(persisted.changes),
    })
    retryUpdate = null
    writeFailure = null
    try {
      const storage = window.localStorage
      const prototype = storagePrototype(storage)
      const setItem = prototype[STORAGE_METHODS]?.setItem ?? prototype.setItem
      setItem.call(storage, key, value)
    } catch (error) {
      console.error('[Wework] Could not publish committed localStorage value:', error)
    }
  })
  // A rejected command is not a queued write to retry alongside unrelated changes.
  writeQueue = commit.catch(() => {})
  await commit
}

function storageEntries(storage: Storage): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key === null) continue
    const value = storage.getItem(key)
    if (value !== null) entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

function replaceStorage(storage: Storage, entries: Record<string, string>): void {
  storage.clear()
  for (const [key, value] of Object.entries(entries)) {
    storage.setItem(key, value)
  }
}

function installPersistence(localStorage: Storage): void {
  const prototype = storagePrototype(localStorage)
  const methods = prototype[STORAGE_METHODS] ?? {
    setItem: prototype.setItem,
    removeItem: prototype.removeItem,
    clear: prototype.clear,
  }
  Object.defineProperty(prototype, STORAGE_METHODS, {
    configurable: true,
    value: methods,
  })

  prototype.setItem = function setItem(key: string, value: string): void {
    methods.setItem.call(this, key, value)
    if (this === localStorage) queueChange(String(key), String(value))
  }
  prototype.removeItem = function removeItem(key: string): void {
    methods.removeItem.call(this, key)
    if (this === localStorage) queueChange(String(key), null)
  }
  prototype.clear = function clear(): void {
    methods.clear.call(this)
    if (this === localStorage) queueClear()
  }
}

function restoreStorageMethods(localStorage: Storage): void {
  const prototype = storagePrototype(localStorage)
  const methods = prototype[STORAGE_METHODS]
  if (!methods) return
  prototype.setItem = methods.setItem
  prototype.removeItem = methods.removeItem
  prototype.clear = methods.clear
}

function storagePrototype(storage: Storage): Storage & {
  [key: symbol]: StorageMethods | undefined
} {
  return Object.getPrototypeOf(storage) as Storage & {
    [key: symbol]: StorageMethods | undefined
  }
}

function queueChange(key: string, value: string | null): void {
  pending.changes.set(key, value)
  scheduleFlush()
}

function queueClear(): void {
  pending = {
    clear: true,
    changes: new Map(),
  }
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(flushPendingChanges)
}

function flushPendingChanges(): void {
  flushScheduled = false
  const update = pending
  pending = {
    clear: false,
    changes: new Map(),
  }
  if (!update.clear && update.changes.size === 0) return

  writeQueue = writeQueue.then(async () => {
    const persistedUpdate = retryUpdate ? mergeUpdates(retryUpdate, update) : update
    retryUpdate = null
    try {
      await invokeDesktopHost('rendererStorage.update', {
        clear: persistedUpdate.clear,
        changes: Object.fromEntries(persistedUpdate.changes),
      })
      writeFailure = null
    } catch (error) {
      retryUpdate = persistedUpdate
      writeFailure = error
      console.error('[Wework] Failed to persist renderer localStorage:', error)
    }
  })
}

function mergeUpdates(
  previous: PendingStorageUpdate,
  next: PendingStorageUpdate
): PendingStorageUpdate {
  if (next.clear) return next
  const changes = new Map(previous.changes)
  for (const [key, value] of next.changes) changes.set(key, value)
  return {
    clear: previous.clear,
    changes,
  }
}
