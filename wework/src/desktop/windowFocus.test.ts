import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isMainWindowFocused, subscribeMainWindowFocus } from './windowFocus'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
}))

const invokeDesktopHostMock = vi.mocked(invokeDesktopHost)

describe('windowFocus', () => {
  beforeEach(() => {
    invokeDesktopHostMock.mockReset()
    delete window.weworkElectronLifecycle
  })

  test('reads and follows the native Electron window focus state', async () => {
    let nativeListener: ((focused: boolean) => void) | null = null
    const unsubscribeNative = vi.fn()
    window.weworkElectronLifecycle = {
      onSystemResume: vi.fn(() => () => undefined),
      onWindowFocusChanged: vi.fn(listener => {
        nativeListener = listener
        return unsubscribeNative
      }),
    }
    invokeDesktopHostMock.mockResolvedValue({ focused: false })
    const listener = vi.fn()

    const unsubscribe = subscribeMainWindowFocus(listener)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(false))

    nativeListener?.(true)
    expect(isMainWindowFocused()).toBe(true)
    expect(listener).toHaveBeenLastCalledWith(true)

    unsubscribe()
    expect(unsubscribeNative).toHaveBeenCalledOnce()
  })

  test('does not treat retained renderer focus as native window activation', async () => {
    window.weworkElectronLifecycle = {
      onSystemResume: vi.fn(() => () => undefined),
      onWindowFocusChanged: vi.fn(() => () => undefined),
    }
    invokeDesktopHostMock.mockResolvedValue({ focused: false })
    const unsubscribe = subscribeMainWindowFocus(vi.fn())
    try {
      await vi.waitFor(() => expect(isMainWindowFocused()).toBe(false))
      window.dispatchEvent(new FocusEvent('focus'))
      expect(isMainWindowFocused()).toBe(false)
    } finally {
      unsubscribe()
    }
  })
})
