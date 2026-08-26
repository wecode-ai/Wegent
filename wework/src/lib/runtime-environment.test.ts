import { afterEach, describe, expect, test } from 'vitest'
import { isElectronRuntime } from './runtime-environment'

describe('isElectronRuntime', () => {
  afterEach(() => {
    delete window.__WEWORK_RUNTIME_CONFIG__
  })

  test('uses the Electron desktop host runtime marker', () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    expect(isElectronRuntime()).toBe(true)
  })

  test('returns false in a regular browser runtime', () => {
    expect(isElectronRuntime()).toBe(false)
  })
})
