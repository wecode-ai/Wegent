import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { evalEmbeddedBrowserJson, openEmbeddedBrowser } from '@/lib/embedded-browser'
import { AppIframe } from './AppIframe'

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => false,
}))
vi.mock('@/lib/embedded-browser', () => ({
  closeEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  evalEmbeddedBrowserJson: vi.fn(),
  navigateEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  openEmbeddedBrowser: vi.fn(),
  setEmbeddedBrowserBounds: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 800, 600)
  )
  vi.mocked(evalEmbeddedBrowserJson).mockResolvedValue(false)
  vi.mocked(openEmbeddedBrowser).mockResolvedValue({ nativeLabel: 'native-app' } as Awaited<
    ReturnType<typeof openEmbeddedBrowser>
  >)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

test.each(['opening', 'evaluating'] as const)(
  'stops content polling after unmount during %s',
  async stage => {
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    if (stage === 'opening') {
      vi.mocked(openEmbeddedBrowser).mockImplementationOnce(async () => {
        await pending
        return { nativeLabel: 'native-app' } as Awaited<ReturnType<typeof openEmbeddedBrowser>>
      })
    } else {
      vi.mocked(evalEmbeddedBrowserJson).mockImplementationOnce(async () => {
        await pending
        throw new Error('target closed while handling command')
      })
    }
    const onReady = vi.fn()
    const view = render(
      <AppIframe
        appKey="closed-app"
        src="http://localhost/app"
        title="App"
        waitForContent
        onReady={onReady}
      />
    )
    await act(async () => {})
    expect(evalEmbeddedBrowserJson).toHaveBeenCalledTimes(stage === 'opening' ? 0 : 1)
    view.unmount()
    await act(async () => {
      release()
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(evalEmbeddedBrowserJson).toHaveBeenCalledTimes(stage === 'opening' ? 0 : 1)
    expect(onReady).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  }
)
