import type { LocalDeviceApp } from '@/types/api'

export const COMPOSER_APPS_SNAPSHOT_KEY = 'wework:composer:apps-snapshot'

function isLocalDeviceApp(value: unknown): value is LocalDeviceApp {
  if (!value || typeof value !== 'object') return false
  const app = value as LocalDeviceApp
  return typeof app.id === 'string' && typeof app.name === 'string'
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
