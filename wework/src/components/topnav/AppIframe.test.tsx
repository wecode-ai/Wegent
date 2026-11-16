import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppIframe } from './AppIframe'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  evalEmbeddedBrowserJson: vi.fn().mockResolvedValue(true),
  listenEmbeddedBrowserCloseRequests: vi.fn(() => null),
  navigateEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  openEmbeddedBrowser: vi.fn().mockResolvedValue({
    nativeLabel: 'embedded-browser-native-1',
    title: null,
    url: 'http://localhost:3000',
  }),
  setEmbeddedBrowserBounds: vi.fn().mockResolvedValue(undefined),
}))
const runtimeMocks = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(() => false),
  isElectronRuntime: vi.fn(() => false),
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)
vi.mock('@/lib/runtime-environment', () => runtimeMocks)

describe('AppIframe', () => {
  beforeEach(() => {
    runtimeMocks.isDesktopRuntime.mockReturnValue(false)
    runtimeMocks.isElectronRuntime.mockReturnValue(false)
    embeddedBrowserMocks.closeEmbeddedBrowser.mockClear()
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockReset()
    embeddedBrowserMocks.evalEmbeddedBrowserJson.mockResolvedValue(true)
    embeddedBrowserMocks.navigateEmbeddedBrowser.mockClear()
    embeddedBrowserMocks.openEmbeddedBrowser.mockClear()
    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
  })

  test('keeps app identity stable when the display title is localized', async () => {
    runtimeMocks.isDesktopRuntime.mockReturnValue(true)
    const boundsSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 620,
      height: 600,
      left: 10,
      right: 810,
      top: 20,
      width: 800,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    })
    const { container } = render(
      <AppIframe
        appKey="wegent"
        src="http://localhost:3000"
        title="智能体"
        workspaceTabId="agent-localized"
      />
    )

    expect(container.querySelector('[data-testid="app-iframe-wegent"]')).toHaveAttribute(
      'data-embedded-browser-label',
      'app-wegent-agent-localized'
    )
    await waitFor(() =>
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'http://localhost:3000',
        { x: 10, y: 20, width: 800, height: 600 },
        'app-wegent-agent-localized',
        false,
        true
      )
    )
    await waitFor(() => expect(screen.queryByText('Loading 智能体...')).not.toBeInTheDocument())
    boundsSpy.mockRestore()
  })

  test('has sandbox attribute for security', () => {
    render(<AppIframe appKey="wegent" src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTitle('Wegent')
    expect(iframe).toHaveAttribute('sandbox')
  })

  test('allows popup links to escape the iframe sandbox', () => {
    render(<AppIframe appKey="wegent" src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTitle('Wegent')
    expect(iframe).toHaveAttribute(
      'sandbox',
      expect.stringContaining('allow-popups-to-escape-sandbox')
    )
  })

  test('closes an unmounted Electron app only when its native identity still matches', async () => {
    runtimeMocks.isDesktopRuntime.mockReturnValue(true)
    runtimeMocks.isElectronRuntime.mockReturnValue(true)
    const boundsSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 620,
      height: 600,
      left: 10,
      right: 810,
      top: 20,
      width: 800,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    })

    const { unmount } = render(
      <AppIframe
        appKey="harness-app"
        embeddedBrowserLabel="smart-app:test"
        src="http://localhost:3000"
        title="Harness app"
      />
    )
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledOnce())

    unmount()

    await waitFor(() =>
      expect(embeddedBrowserMocks.closeEmbeddedBrowser).toHaveBeenCalledWith(
        'smart-app:test',
        'embedded-browser-native-1'
      )
    )
    boundsSpy.mockRestore()
  })

  test('hides a native webview that finishes opening after its tab becomes inactive', async () => {
    runtimeMocks.isDesktopRuntime.mockReturnValue(true)
    let resolveOpen!: () => void
    embeddedBrowserMocks.openEmbeddedBrowser.mockReturnValueOnce(
      new Promise(resolve => {
        resolveOpen = () =>
          resolve({
            nativeLabel: 'embedded-browser-native-1',
            title: null,
            url: 'http://localhost:3000',
          })
      })
    )
    const boundsSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 620,
      height: 600,
      left: 10,
      right: 810,
      top: 20,
      width: 800,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    })
    const { rerender } = render(
      <AppIframe
        active
        appKey="wegent"
        src="http://localhost:3000"
        title="Wegent"
        workspaceTabId="agent-1"
      />
    )
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1))

    rerender(
      <AppIframe
        active={false}
        appKey="wegent"
        src="http://localhost:3000"
        title="Wegent"
        workspaceTabId="agent-1"
      />
    )
    resolveOpen()

    await waitFor(() =>
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenLastCalledWith(
        { x: 10, y: 20, width: 800, height: 600 },
        false,
        'app-wegent-agent-1'
      )
    )
    boundsSpy.mockRestore()
  })
})
