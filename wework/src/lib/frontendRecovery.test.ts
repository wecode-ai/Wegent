import { beforeEach, describe, expect, test, vi } from 'vitest'
import { installFrontendRecoveryBridge } from './frontendRecovery'

describe('installFrontendRecoveryBridge', () => {
  beforeEach(() => {
    delete window.__WEWORK_NATIVE_RESUME_PROBE__
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
  })

  test('acknowledges a native resume probe after renderer frames advance', () => {
    installFrontendRecoveryBridge()
    window.__WEWORK_NATIVE_RESUME_PROBE__?.(42)

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2)
  })
})
