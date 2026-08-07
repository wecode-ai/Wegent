import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LocalDeviceApp } from '@/types/api'
import {
  COMPOSER_APPS_REQUEST_SYNC_EVENT,
  COMPOSER_APPS_SNAPSHOT_KEY,
  clearComposerAppsSnapshot,
  getComposerApps,
  publishComposerApps,
  readComposerAppsSnapshot,
  replaceComposerApps,
  requestComposerAppsSync,
  resetComposerAppsMemory,
  shouldSuppressComposerAppsSync,
  subscribeComposerApps,
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
  beforeEach(() => {
    window.localStorage.clear()
    resetComposerAppsMemory()
  })

  test('round-trips composer apps for instant toolbar paint', () => {
    writeComposerAppsSnapshot(sampleApps)
    expect(window.localStorage.getItem(COMPOSER_APPS_SNAPSHOT_KEY)).toBeTruthy()
    expect(readComposerAppsSnapshot()).toEqual(sampleApps)
  })

  test('ignores corrupt snapshot payloads', () => {
    window.localStorage.setItem(COMPOSER_APPS_SNAPSHOT_KEY, '{not-json')
    expect(readComposerAppsSnapshot()).toEqual([])

    window.localStorage.setItem(COMPOSER_APPS_SNAPSHOT_KEY, JSON.stringify([{ name: 'x' }]))
    expect(readComposerAppsSnapshot()).toEqual([])
  })

  test('clearComposerAppsSnapshot removes stored apps', () => {
    writeComposerAppsSnapshot(sampleApps)
    clearComposerAppsSnapshot()
    expect(readComposerAppsSnapshot()).toEqual([])
  })

  test('keeps an in-memory list that slash and the picker share', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeComposerApps(listener)

    publishComposerApps(sampleApps)
    expect(getComposerApps()).toEqual(sampleApps)
    expect(readComposerAppsSnapshot()).toEqual(sampleApps)
    expect(listener).toHaveBeenCalledTimes(1)

    clearComposerAppsSnapshot()
    expect(getComposerApps()).toEqual(sampleApps)

    replaceComposerApps([])
    expect(getComposerApps()).toEqual([])
    expect(shouldSuppressComposerAppsSync()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  test('allows sync republish after a non-empty composer app list is published', () => {
    replaceComposerApps([])
    expect(shouldSuppressComposerAppsSync()).toBe(true)

    publishComposerApps(sampleApps)

    expect(shouldSuppressComposerAppsSync()).toBe(false)
    expect(getComposerApps()).toEqual(sampleApps)
  })

  test('stores composer apps on window so HMR cannot split slash and picker', () => {
    publishComposerApps(sampleApps)
    expect(window.__weworkComposerAppsStore?.memoryApps).toEqual(sampleApps)

    // Simulate a fresh module namespace reading the same window store.
    expect(getComposerApps()).toEqual(sampleApps)
  })

  test('requestComposerAppsSync notifies slash composers to republish', () => {
    const onSync = vi.fn()
    window.addEventListener(COMPOSER_APPS_REQUEST_SYNC_EVENT, onSync)
    requestComposerAppsSync()
    expect(onSync).toHaveBeenCalledTimes(1)
    window.removeEventListener(COMPOSER_APPS_REQUEST_SYNC_EVENT, onSync)
  })
})
