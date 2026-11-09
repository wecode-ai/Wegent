import type { LocalDeviceApp } from '@/types/api'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  COMPOSER_APPS_SNAPSHOT_KEY,
  bindComposerAppsSource,
  getComposerApps,
  notifyComposerAppsListeners,
  publishComposerApps,
  readComposerAppsSnapshot,
  replaceComposerApps,
  resetComposerAppsMemory,
  writeComposerAppsSnapshot,
} from './composerAppsSnapshot'

const sampleApps: LocalDeviceApp[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub connector',
    logoUrl: 'https://example.com/github.png',
    isAccessible: true,
    isEnabled: true,
  },
]

describe('composerAppsSnapshot', () => {
  test('reads bound inventory projections and ignores stale picker publications', () => {
    let inventoryApps = sampleApps
    const unbind = bindComposerAppsSource(() => inventoryApps)
    expect(getComposerApps()).toBe(sampleApps)
    replaceComposerApps([])
    expect(getComposerApps()).toBe(sampleApps)
    inventoryApps = []
    notifyComposerAppsListeners()
    publishComposerApps(sampleApps)
    expect(getComposerApps()).toEqual([])
    unbind()
    expect(getComposerApps()).toEqual([])
  })

  beforeEach(() => {
    window.localStorage.clear()
    resetComposerAppsMemory()
  })

  test('does not persist a second installed-plugin snapshot', () => {
    writeComposerAppsSnapshot(sampleApps)
    expect(window.localStorage.getItem(COMPOSER_APPS_SNAPSHOT_KEY)).toBeNull()
    expect(readComposerAppsSnapshot()).toEqual([])
  })

  test('drops legacy snapshot payloads without migration', () => {
    window.localStorage.setItem(COMPOSER_APPS_SNAPSHOT_KEY, '{not-json')
    expect(readComposerAppsSnapshot()).toEqual([])
    expect(window.localStorage.getItem(COMPOSER_APPS_SNAPSHOT_KEY)).toBeNull()
  })

  test('stores composer apps on window so HMR cannot split slash and picker', () => {
    publishComposerApps(sampleApps)
    expect(window.__weworkComposerAppsStore?.memoryApps).toEqual(sampleApps)

    // Simulate a fresh module namespace reading the same window store.
    expect(getComposerApps()).toEqual(sampleApps)
  })
})
