import { StrictMode } from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
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

  test('renders iframe with src and title', () => {
    render(<AppIframe appKey="wegent" src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTitle('Wegent')
    expect(iframe).toBeInTheDocument()
    expect(iframe).toHaveAttribute('src', 'http://localhost:3000')
    expect(iframe).toHaveAttribute('title', 'Wegent')
  })

  test('shows loading spinner initially', () => {
    render(<AppIframe appKey="wegent" src="http://localhost:3000" title="Wegent" />)
    expect(screen.getByText('Loading Wegent...')).toBeInTheDocument()
  })

  test('removes workspace insets for edge-to-edge apps', () => {
    render(<AppIframe appKey="harness" edgeToEdge src="http://localhost:3000" title="Harness" />)

    expect(screen.getByTestId('app-iframe-harness')).not.toHaveClass('app-view-surface')
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

  test('uses the runtime label for an Electron workbench webview', async () => {
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

    render(
      <AppIframe
        appKey="harness-review"
        embeddedBrowserLabel="smart-app:review"
        src="http://localhost:4101"
        title="Review"
        workspaceTabId="auxiliary-1"
      />
    )

    expect(screen.getByTestId('workspace-browser-electron-webview-placeholder')).toBeInTheDocument()
    expect(
      document.querySelector('[data-wework-browser-webview-host-root] webview')
    ).toHaveAttribute('data-wework-browser-label', 'smart-app:review')
    await waitFor(() =>
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'http://localhost:4101',
        { x: 10, y: 20, width: 800, height: 600 },
        'smart-app:review',
        false,
        true
      )
    )
    await waitFor(() => expect(screen.queryByText('Loading Review...')).not.toBeInTheDocument())
    boundsSpy.mockRestore()
  })

  test('hides loading on iframe load', () => {
    render(<AppIframe appKey="wegent" src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTitle('Wegent')
    fireEvent.load(iframe)
    expect(screen.queryByText('Loading Wegent...')).not.toBeInTheDocument()
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

  test('uses a persistent native webview in the desktop app', async () => {
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
        title="Wegent"
        workspaceTabId="agent-1"
      />
    )

    await waitFor(() =>
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'http://localhost:3000',
        { x: 10, y: 20, width: 800, height: 600 },
        'app-wegent-agent-1',
        false,
        true
      )
    )
    expect(container.querySelector('iframe')).toBeNull()
    boundsSpy.mockRestore()
  })

  test('creates the Electron webview host before opening the native app', async () => {
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

    render(
      <AppIframe
        appKey="wegent"
        src="http://localhost:3000"
        title="Wegent"
        workspaceTabId="fixed-agent"
      />
    )

    const webview = document.querySelector('webview')
    expect(webview).toHaveAttribute('data-wework-browser-label', 'app-wegent-fixed-agent')
    await waitFor(() =>
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'http://localhost:3000',
        { x: 10, y: 20, width: 800, height: 600 },
        'app-wegent-fixed-agent',
        false,
        true
      )
    )
    boundsSpy.mockRestore()
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

  test('mounts content-aware native apps in a visible collapsed webview', async () => {
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

    render(
      <AppIframe
        appKey="harness-app"
        src="http://localhost:3000"
        title="Harness app"
        waitForContent
        workspaceTabId="harness-1"
      />
    )

    await waitFor(() =>
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'http://localhost:3000',
        { x: 362, y: 284, width: 96, height: 72 },
        'app-harness-app-harness-1',
        true,
        true
      )
    )
    boundsSpy.mockRestore()
  })

  test('keeps one native webview during the StrictMode effect replay', async () => {
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

    render(
      <StrictMode>
        <AppIframe
          appKey="wegent"
          src="http://localhost:3000"
          title="Wegent"
          workspaceTabId="agent-strict"
        />
      </StrictMode>
    )

    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1))
    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(embeddedBrowserMocks.closeEmbeddedBrowser).not.toHaveBeenCalledWith(
      'app-wegent-agent-strict'
    )
    boundsSpy.mockRestore()
  })

  test('shows an existing native webview without navigating again', async () => {
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
    rerender(
      <AppIframe
        active
        appKey="wegent"
        src="http://localhost:3000"
        title="Wegent"
        workspaceTabId="agent-1"
      />
    )

    await waitFor(() =>
      expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenLastCalledWith(
        { x: 10, y: 20, width: 800, height: 600 },
        true,
        'app-wegent-agent-1'
      )
    )
    expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1)
    expect(embeddedBrowserMocks.navigateEmbeddedBrowser).not.toHaveBeenCalled()
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

  test('does not reveal a reduced-motion native webview after cleanup', async () => {
    runtimeMocks.isDesktopRuntime.mockReturnValue(true)
    const frames: FrameRequestCallback[] = []
    const frameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => frames.push(callback))
    const mediaSpy = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as MediaQueryList)
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
        appKey="wegent"
        src="http://localhost:3000"
        title="Wegent"
        workspaceTabId="agent-reduced-motion"
      />
    )
    await waitFor(() => expect(frames).toHaveLength(1))

    act(() => frames.shift()?.(performance.now()))
    expect(frames).toHaveLength(1)
    const callsBeforeCleanup = embeddedBrowserMocks.setEmbeddedBrowserBounds.mock.calls.length

    unmount()
    act(() => frames.shift()?.(performance.now()))

    expect(embeddedBrowserMocks.setEmbeddedBrowserBounds).toHaveBeenCalledTimes(callsBeforeCleanup)
    boundsSpy.mockRestore()
    mediaSpy.mockRestore()
    frameSpy.mockRestore()
  })
})
