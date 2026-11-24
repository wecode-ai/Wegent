import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isMainWindowFocused, subscribeMainWindowFocus } from './windowFocus'
import { pollWorkbenchPresentation } from './workbenchWindowActivity'

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
})

test('window presentation polls slow down, pause, and refresh as soon as focus returns', async () => {
  vi.useFakeTimers()
  const initial = Promise.withResolvers<unknown>()
  let notify: (activity: unknown) => void = () => undefined
  window.weworkElectronLifecycle = {
    onSystemResume: () => () => undefined,
    getWorkbenchActivity: () => initial.promise,
    onWorkbenchActivityChanged: listener => {
      notify = listener
      return () => undefined
    },
  }
  const refresh = vi.fn()
  const stop = pollWorkbenchPresentation(refresh, 1000, 5000)
  try {
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    notify('background')
    vi.advanceTimersByTime(4999)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(2)

    notify('hidden')
    initial.resolve('foreground')
    await initial.promise
    vi.advanceTimersByTime(10_000)
    expect(refresh).toHaveBeenCalledTimes(2)

    notify('foreground')
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(3)
  } finally {
    stop()
    delete window.weworkElectronLifecycle
    vi.useRealTimers()
  }
})
