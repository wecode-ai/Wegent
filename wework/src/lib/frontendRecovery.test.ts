import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const isTauriMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}))

import { installFrontendRecoveryBridge } from './frontendRecovery'

describe('installFrontendRecoveryBridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReturnValue(false)
    delete window.__WEWORK_NATIVE_RESUME_PROBE__
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
  })

  test('does nothing outside the Tauri app', () => {
    installFrontendRecoveryBridge()

    expect(window.__WEWORK_NATIVE_RESUME_PROBE__).toBeUndefined()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('acknowledges a native resume probe after WebView rendering advances', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    isTauriMock.mockReturnValue(true)
    invokeMock.mockResolvedValue(undefined)

    installFrontendRecoveryBridge()
    window.__WEWORK_NATIVE_RESUME_PROBE__?.(42)

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'register_frontend_recovery_bridge')
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'acknowledge_frontend_resume_probe', {
      probeId: 42,
    })
  })
})
