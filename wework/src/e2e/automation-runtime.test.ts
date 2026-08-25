import { afterEach, describe, expect, test, vi } from 'vitest'
import { isWeworkAutomationEnabled, shouldUseNativeProjectDirectoryPicker } from './automation'

afterEach(() => {
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  vi.unstubAllEnvs()
})

describe('Electron desktop E2E automation', () => {
  test('is enabled by an injected runtime control URL', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      controlUrl: 'http://127.0.0.1:43111',
    }

    expect(isWeworkAutomationEnabled()).toBe(true)
  })

  test('uses the controllable project directory picker in unit tests', () => {
    expect(shouldUseNativeProjectDirectoryPicker()).toBe(false)
  })

  test('allows native project directory picker coverage when explicitly requested', () => {
    vi.stubEnv('VITE_WEWORK_E2E_NATIVE_DIRECTORY_PICKER', 'true')

    expect(shouldUseNativeProjectDirectoryPicker()).toBe(true)
  })
})
