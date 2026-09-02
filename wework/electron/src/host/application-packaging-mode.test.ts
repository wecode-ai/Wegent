import { describe, expect, test } from 'vitest'
import { isEffectivePackagedApplication } from './application-packaging-mode.js'

describe('isEffectivePackagedApplication', () => {
  test('keeps release bundles in packaged mode', () => {
    expect(isEffectivePackagedApplication(true, {})).toBe(true)
  })

  test('keeps source Electron launches in development mode', () => {
    expect(isEffectivePackagedApplication(false, {})).toBe(false)
  })

  test('treats renamed hot-reload bundles as development launches', () => {
    expect(
      isEffectivePackagedApplication(true, {
        WEWORK_APP_HOT_RELOAD: '1',
      })
    ).toBe(false)
  })
})
