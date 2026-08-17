import { StrictMode } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AppIframe } from './AppIframe'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  navigateEmbeddedBrowser: vi.fn().mockResolvedValue(undefined),
  openEmbeddedBrowser: vi.fn().mockResolvedValue({
    nativeLabel: 'embedded-browser-native-1',
    title: null,
    url: 'http://localhost:3000',
  }),
  setEmbeddedBrowserBounds: vi.fn().mockResolvedValue(undefined),
}))
const runtimeMocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => false),
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)
vi.mock('@/lib/runtime-environment', () => runtimeMocks)

describe('AppIframe', () => {
  beforeEach(() => {
    runtimeMocks.isTauriRuntime.mockReturnValue(false)
    embeddedBrowserMocks.closeEmbeddedBrowser.mockClear()
    embeddedBrowserMocks.navigateEmbeddedBrowser.mockClear()
    embeddedBrowserMocks.openEmbeddedBrowser.mockClear()
    embeddedBrowserMocks.setEmbeddedBrowserBounds.mockClear()
  })

  test('renders iframe with src and title', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTitle('Wegent')
    expect(iframe).toBeInTheDocument()
    expect(iframe).toHaveAttribute('src', 'http://localhost:3000')
    expect(iframe).toHaveAttribute('title', 'Wegent')
  })

  test('shows loading spinner initially', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    expect(screen.getByText('Loading Wegent...')).toBeInTheDocument()
  })

  test('hides loading on iframe load', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTitle('Wegent')
    fireEvent.load(iframe)
    expect(screen.queryByText('Loading Wegent...')).not.toBeInTheDocument()
  })

  test('has sandbox attribute for security', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTitle('Wegent')
    expect(iframe).toHaveAttribute('sandbox')
  })

  test('allows popup links to escape the iframe sandbox', () => {
    render(<AppIframe src="http://localhost:3000" title="Wegent" />)
    const iframe = screen.getByTitle('Wegent')
    expect(iframe).toHaveAttribute(
      'sandbox',
      expect.stringContaining('allow-popups-to-escape-sandbox')
    )
  })

  test('uses a persistent native webview in Tauri', async () => {
    runtimeMocks.isTauriRuntime.mockReturnValue(true)
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
      <AppIframe src="http://localhost:3000" title="Wegent" workspaceTabId="agent-1" />
    )

    await waitFor(() =>
      expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledWith(
        'http://localhost:3000',
        { x: 10, y: 20, width: 800, height: 600 },
        'app-wegent-agent-1'
      )
    )
    expect(container.querySelector('iframe')).toBeNull()
    boundsSpy.mockRestore()
  })

  test('keeps one native webview during the StrictMode effect replay', async () => {
    runtimeMocks.isTauriRuntime.mockReturnValue(true)
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
        <AppIframe src="http://localhost:3000" title="Wegent" workspaceTabId="agent-strict" />
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
    runtimeMocks.isTauriRuntime.mockReturnValue(true)
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
      <AppIframe active src="http://localhost:3000" title="Wegent" workspaceTabId="agent-1" />
    )
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1))

    rerender(
      <AppIframe
        active={false}
        src="http://localhost:3000"
        title="Wegent"
        workspaceTabId="agent-1"
      />
    )
    rerender(
      <AppIframe active src="http://localhost:3000" title="Wegent" workspaceTabId="agent-1" />
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
    runtimeMocks.isTauriRuntime.mockReturnValue(true)
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
      <AppIframe active src="http://localhost:3000" title="Wegent" workspaceTabId="agent-1" />
    )
    await waitFor(() => expect(embeddedBrowserMocks.openEmbeddedBrowser).toHaveBeenCalledTimes(1))

    rerender(
      <AppIframe
        active={false}
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
