import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

interface PendingStorageUpdate {
  clear: boolean
  changes: Map<string, string | null>
}

let installed = false
let pending: PendingStorageUpdate = {
  clear: false,
  changes: new Map(),
}
let flushScheduled = false
let writeQueue: Promise<unknown> = Promise.resolve()

export async function initializeDesktopLocalStoragePersistence(): Promise<void> {
  if (!isElectronRuntime() || installed) return

  const localStorage = window.localStorage
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
  const prototype = Object.getPrototypeOf(localStorage) as Storage
  const originalSetItem = prototype.setItem
  const originalRemoveItem = prototype.removeItem
  const originalClear = prototype.clear

  prototype.setItem = function setItem(key: string, value: string): void {
    originalSetItem.call(this, key, value)
    if (this === localStorage) queueChange(String(key), String(value))
  }
  prototype.removeItem = function removeItem(key: string): void {
    originalRemoveItem.call(this, key)
    if (this === localStorage) queueChange(String(key), null)
  }
  prototype.clear = function clear(): void {
    originalClear.call(this)
    if (this === localStorage) queueClear()
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

  writeQueue = writeQueue
    .then(() =>
      invokeDesktopHost('rendererStorage.update', {
        clear: update.clear,
        changes: Object.fromEntries(update.changes),
      })
    )
    .catch(error => {
      console.error('[Wework] Failed to persist renderer localStorage:', error)
    })
}
