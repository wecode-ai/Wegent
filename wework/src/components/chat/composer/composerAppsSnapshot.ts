import type { LocalDeviceApp } from '@/types/api'

export const COMPOSER_APPS_SNAPSHOT_KEY = 'wework:composer:apps-snapshot'
export const COMPOSER_APPS_REQUEST_SYNC_EVENT = 'wework:composer-apps-request-sync'

type ComposerAppsListener = () => void

type ComposerAppsStore = {
  source?: () => LocalDeviceApp[]
  memoryApps: LocalDeviceApp[]
  listeners: Set<ComposerAppsListener>
  suppressEmptySync: boolean
}

declare global {
  interface Window {
    __weworkComposerAppsStore?: ComposerAppsStore
  }
}

/**
 * Keep the shared inventory on `window` so Vite HMR cannot split slash
 * autocomplete and the toolbar plugin picker across two module instances.
 */
function getStore(): ComposerAppsStore {
  if (typeof window === 'undefined') {
    return { memoryApps: [], listeners: new Set(), suppressEmptySync: false }
  }
  if (!window.__weworkComposerAppsStore) {
    window.__weworkComposerAppsStore = {
      memoryApps: [],
      listeners: new Set(),
      suppressEmptySync: false,
    }
  }
  return window.__weworkComposerAppsStore
}

export function notifyComposerAppsListeners() {
  getStore().listeners.forEach(listener => listener())
}

/** Desktop membership is a read-only projection, never a second writable inventory. */
export function bindComposerAppsSource(source: () => LocalDeviceApp[]): () => void {
  const store = getStore()
  store.source = source
  store.memoryApps = []
  notifyComposerAppsListeners()
  return () => {
    if (store.source !== source) return
    delete store.source
    store.memoryApps = []
    notifyComposerAppsListeners()
  }
}

/** Legacy durable snapshot. Composer membership now reloads from the shared inventory. */
export function readComposerAppsSnapshot(): LocalDeviceApp[] {
  clearComposerAppsSnapshot()
  return []
}

export function writeComposerAppsSnapshot(apps: LocalDeviceApp[]): void {
  void apps
  clearComposerAppsSnapshot()
}

export function clearComposerAppsSnapshot(): void {
  try {
    window.localStorage.removeItem(COMPOSER_APPS_SNAPSHOT_KEY)
  } catch {
    // Ignore storage failures.
  }
}

/**
 * In-memory last-known composer apps shared by slash autocomplete and the
 * toolbar plugin picker. Slash keeps React state across refreshes; the picker
 * must read the same list or it briefly shows “no plugins” while `/` still works.
 */
export function getComposerApps(): LocalDeviceApp[] {
  const store = getStore()
  return store.source ? store.source() : store.memoryApps
}

/** Publish a non-empty composer app list to shared renderer memory. */
export function publishComposerApps(apps: LocalDeviceApp[]): void {
  if (apps.length === 0) return
  const store = getStore()
  if (store.source) return
  store.memoryApps = apps
  store.suppressEmptySync = false
  clearComposerAppsSnapshot()
  notifyComposerAppsListeners()
}

/** Replace the shared list, including clearing it after the last uninstall. */
export function replaceComposerApps(apps: LocalDeviceApp[]): void {
  const store = getStore()
  if (store.source) return
  store.memoryApps = apps
  store.suppressEmptySync = apps.length === 0
  clearComposerAppsSnapshot()
  notifyComposerAppsListeners()
}

export function shouldSuppressComposerAppsSync(): boolean {
  const store = getStore()
  if (store.source) return true
  return store.suppressEmptySync && store.memoryApps.length === 0
}

export function subscribeComposerApps(listener: ComposerAppsListener): () => void {
  const store = getStore()
  store.listeners.add(listener)
  return () => {
    store.listeners.delete(listener)
  }
}

/** Ask any mounted slash composer to re-publish its current apps list. */
export function requestComposerAppsSync(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(COMPOSER_APPS_REQUEST_SYNC_EVENT))
}

/** Test helper: drop memory without touching unrelated localStorage keys. */
export function resetComposerAppsMemory(): void {
  if (typeof window !== 'undefined') {
    delete window.__weworkComposerAppsStore
  }
}
