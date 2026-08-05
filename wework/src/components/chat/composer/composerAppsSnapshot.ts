import type { LocalDeviceApp } from '@/types/api'

export const COMPOSER_APPS_SNAPSHOT_KEY = 'wework:composer:apps-snapshot'
export const COMPOSER_APPS_REQUEST_SYNC_EVENT = 'wework:composer-apps-request-sync'

type ComposerAppsListener = () => void

type ComposerAppsStore = {
  memoryApps: LocalDeviceApp[]
  listeners: Set<ComposerAppsListener>
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
    return { memoryApps: [], listeners: new Set() }
  }
  if (!window.__weworkComposerAppsStore) {
    window.__weworkComposerAppsStore = {
      memoryApps: [],
      listeners: new Set(),
    }
  }
  return window.__weworkComposerAppsStore
}

function isLocalDeviceApp(value: unknown): value is LocalDeviceApp {
  if (!value || typeof value !== 'object') return false
  const app = value as LocalDeviceApp
  return typeof app.id === 'string' && typeof app.name === 'string'
}

function notifyComposerAppsListeners() {
  getStore().listeners.forEach(listener => listener())
}

/** Last successful composer plugin list for instant toolbar paint. */
export function readComposerAppsSnapshot(): LocalDeviceApp[] {
  try {
    const raw = window.localStorage.getItem(COMPOSER_APPS_SNAPSHOT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isLocalDeviceApp)
  } catch {
    return []
  }
}

export function writeComposerAppsSnapshot(apps: LocalDeviceApp[]): void {
  try {
    window.localStorage.setItem(COMPOSER_APPS_SNAPSHOT_KEY, JSON.stringify(apps))
  } catch {
    // Ignore quota / private-mode failures; live fetch still works.
  }
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
  if (store.memoryApps.length > 0) return store.memoryApps
  return readComposerAppsSnapshot()
}

/** Publish a non-empty composer app list to memory + localStorage. */
export function publishComposerApps(apps: LocalDeviceApp[]): void {
  if (apps.length === 0) return
  const store = getStore()
  store.memoryApps = apps
  writeComposerAppsSnapshot(apps)
  notifyComposerAppsListeners()
}

/** Replace the shared list, including clearing it after the last uninstall. */
export function replaceComposerApps(apps: LocalDeviceApp[]): void {
  const store = getStore()
  store.memoryApps = apps
  if (apps.length > 0) writeComposerAppsSnapshot(apps)
  else clearComposerAppsSnapshot()
  notifyComposerAppsListeners()
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
