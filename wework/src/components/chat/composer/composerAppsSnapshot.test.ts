import { beforeEach, describe, expect, test } from 'vitest'
import type { LocalDeviceApp } from '@/types/api'
import {
  COMPOSER_APPS_SNAPSHOT_KEY,
  clearComposerAppsSnapshot,
  readComposerAppsSnapshot,
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
})
